#!/usr/bin/env python3
"""
Allaine SDR Lead Tagging Cron
Schedule:
  - Every 15 mins during 10AM–6PM EST (15:00–23:00 UTC)
  - Every 3 hours outside business hours

Logic:
1. Fetch all leads tagged 'Interested' but not already tagged 'Allaine'
2. For each lead, fetch their reply thread (sorted newest first)
3. If latest message is from prospect (folder=Inbox) AND >10 mins ago
   AND domain not in demo bookings → tag lead as 'Allaine'
4. Send Slack summary + append to runs log CSV
"""

import os
import csv
import sys
import time
import logging
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

# ── Config ─────────────────────────────────────────────────────────────────────
BASE          = os.getenv('SEQUENCER_BASE_URL', 'https://sequencer.gushwork.ai/api')
TOKEN         = os.getenv('SEQUENCER_API_KEY')
DB_URL        = os.getenv('DATABASE_URL')
SLACK_TOKEN   = os.getenv('SLACK_BOT_TOKEN')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL_ID', 'C0ARFBBN3TN')
HEADERS       = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}

INTERESTED_TAG_ID   = 11
ALLAINE_TAG_NAME    = 'Allaine'
SENDER_CSV          = os.path.join(os.path.dirname(__file__), 'sender_emails.csv')
RUNS_CSV            = os.path.join(os.path.dirname(__file__), 'allaine_runs_log.csv')
SENDER_CSV_MAX_AGE  = 86400   # refresh if older than 24hrs (seconds)
TEN_MINUTES         = timedelta(minutes=10)

# ── Logging ────────────────────────────────────────────────────────────────────
LOG_FILE = os.path.join(os.path.dirname(__file__), 'allaine_cron.log')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE),
    ]
)
log = logging.getLogger(__name__)


# ── Sequencer helpers ──────────────────────────────────────────────────────────

def seq_get(path, params=None, retries=3):
    url = f"{BASE}{path}"
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, params=params, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def seq_post(path, payload, retries=3):
    url = f"{BASE}{path}"
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=HEADERS, json=payload, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def detach_tag(tag_id, lead_ids):
    """Remove a tag from a batch of leads."""
    batch_size = 500
    for i in range(0, len(lead_ids), batch_size):
        batch = lead_ids[i:i + batch_size]
        seq_post('/tags/detach-from-leads', {'tag_ids': [tag_id], 'lead_ids': batch})
        log.info(f"  Detached tag from batch {i//batch_size + 1}: {len(batch)} leads")
        time.sleep(0.2)


def fetch_all_pages(path, params=None):
    p = dict(params or {})
    p['per_page'] = 100
    p['page'] = 1
    first = seq_get(path, p)
    items = list(first.get('data', []))
    last_page = first.get('meta', {}).get('last_page', 1)
    if last_page <= 1:
        return items
    lock = Lock()
    def fetch_page(page):
        pp = dict(p)
        pp['page'] = page
        return seq_get(path, pp).get('data', [])
    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = {ex.submit(fetch_page, pg): pg for pg in range(2, last_page + 1)}
        for fut in as_completed(futures):
            with lock:
                items.extend(fut.result())
    return items


# ── Sender emails CSV ──────────────────────────────────────────────────────────

def load_sender_emails():
    """Load sender emails from CSV, refresh if >24hrs old."""
    needs_refresh = True
    if os.path.exists(SENDER_CSV):
        age = time.time() - os.path.getmtime(SENDER_CSV)
        if age < SENDER_CSV_MAX_AGE:
            needs_refresh = False

    if needs_refresh:
        log.info("Refreshing sender emails CSV...")
        import fetch_sender_emails
        fetch_sender_emails.main()

    emails = set()
    with open(SENDER_CSV, newline='') as f:
        for row in csv.DictReader(f):
            emails.add(row['email'].strip().lower())
    log.info(f"  Loaded {len(emails)} sender emails")
    return emails


# ── Allaine tag ────────────────────────────────────────────────────────────────

def get_or_create_allaine_tag():
    tags = fetch_all_pages('/tags')
    for t in tags:
        if t.get('name', '').lower() == ALLAINE_TAG_NAME.lower():
            log.info(f"  '{ALLAINE_TAG_NAME}' tag exists → ID {t['id']}")
            return t['id']
    resp = seq_post('/tags', {'name': ALLAINE_TAG_NAME})
    tag_id = (resp.get('data') or resp).get('id')
    log.info(f"  Created '{ALLAINE_TAG_NAME}' tag → ID {tag_id}")
    return tag_id


# ── Booked domains ─────────────────────────────────────────────────────────────

def get_booked_domains():
    conn = psycopg2.connect(DB_URL)
    conn.set_session(readonly=True, autocommit=True)
    booked = set()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT lower(split_part(prospect_email, '@', 2))
            FROM gist.gtm_inbound_demo_bookings
            WHERE prospect_email LIKE '%@%'
        """)
        for (domain,) in cur.fetchall():
            if domain:
                booked.add(domain.strip())
        cur.execute("""
            SELECT DISTINCT lower(
                regexp_replace(
                    regexp_replace(prospect_website, '^https?://(www\\.)?', ''),
                    '/.*$', ''
                )
            )
            FROM gist.gtm_inbound_demo_bookings
            WHERE prospect_website IS NOT NULL AND prospect_website <> ''
        """)
        for (domain,) in cur.fetchall():
            if domain:
                booked.add(domain.strip())
    conn.close()
    log.info(f"  Booked domains: {len(booked)}")
    return booked


# ── Cleanup: remove Allaine tag where we already replied ──────────────────────

def find_leads_to_remove(allaine_leads, sender_emails):
    """Return lead_ids where the latest reply is folder=Sent (we replied)."""
    to_remove = []
    remove_lock = Lock()

    def check_lead(lead):
        lead_id = lead['id']
        try:
            data    = seq_get(f'/leads/{lead_id}/replies', {'per_page': 100})
            replies = data.get('data', [])
        except Exception as exc:
            log.warning(f"  Reply fetch failed for lead {lead_id}: {exc}")
            return

        if not replies:
            return

        def parse_dt(r):
            try:
                return datetime.fromisoformat(r['date_received'].replace('Z', '+00:00'))
            except Exception:
                return datetime.min.replace(tzinfo=timezone.utc)

        latest = sorted(replies, key=parse_dt)[-1]

        # We replied if latest message is Sent OR from one of our sender emails
        is_sent = latest.get('folder') == 'Sent'
        from_email = (latest.get('from_email_address') or '').lower()
        is_our_email = from_email in sender_emails

        if is_sent or is_our_email:
            with remove_lock:
                to_remove.append(lead_id)

    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = [ex.submit(check_lead, lead) for lead in allaine_leads]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                fut.result()
            except Exception as exc:
                log.warning(f"  Cleanup check error: {exc}")
            if i % 50 == 0:
                log.info(f"  Cleanup progress: {i}/{len(allaine_leads)}")

    return to_remove


# ── Candidate leads ────────────────────────────────────────────────────────────

def get_candidate_leads(allaine_tag_id):
    """Leads tagged Interested but not Allaine."""
    leads = fetch_all_pages('/leads', {
        'filters[tag_ids][]':          INTERESTED_TAG_ID,
        'filters[excluded_tag_ids][]': allaine_tag_id,
    })
    log.info(f"  Candidate leads (Interested, not Allaine): {len(leads)}")
    return leads


# ── Per-lead evaluation ────────────────────────────────────────────────────────

def evaluate_lead(lead, sender_emails, booked_domains, now):
    lead_id = lead['id']
    email   = lead.get('email', '')
    domain  = email.split('@')[-1].lower() if '@' in email else ''

    # Check booked domain
    if domain and domain in booked_domains:
        return None

    # Fetch reply thread
    try:
        data    = seq_get(f'/leads/{lead_id}/replies', {'per_page': 100})
        replies = data.get('data', [])
    except Exception as exc:
        log.warning(f"  Reply fetch failed for lead {lead_id}: {exc}")
        return None

    if not replies:
        return None

    # Sort by date_received, get latest
    def parse_dt(r):
        try:
            return datetime.fromisoformat(r['date_received'].replace('Z', '+00:00'))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)

    replies_sorted = sorted(replies, key=parse_dt)
    latest = replies_sorted[-1]

    # Latest must be from prospect (folder=Inbox) not us (folder=Sent)
    if latest.get('folder') != 'Inbox':
        return None

    # from_email must not be one of our sender emails
    from_email = (latest.get('from_email_address') or '').lower()
    if from_email in sender_emails:
        return None

    # Must be >10 mins ago
    latest_dt = parse_dt(latest)
    if now - latest_dt < TEN_MINUTES:
        return None

    return {
        'lead_id':    lead_id,
        'name':       f"{lead.get('first_name','')} {lead.get('last_name','')}".strip(),
        'email':      email,
        'latest_reply': latest_dt.strftime('%Y-%m-%d %H:%M UTC'),
    }


# ── CSV run log ───────────────────────────────────────────────────────────────

def append_to_runs_log(run_dt, total_candidates, already_tagged, newly_tagged, removed=0):
    file_exists = os.path.exists(RUNS_CSV)
    ist_offset  = timedelta(hours=5, minutes=30)
    ist_dt      = run_dt + ist_offset
    with open(RUNS_CSV, 'a', newline='') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(['date', 'time_ist', 'total_candidates', 'already_tagged', 'newly_tagged', 'removed'])
        writer.writerow([
            ist_dt.strftime('%Y-%m-%d'),
            ist_dt.strftime('%H:%M'),
            total_candidates,
            already_tagged,
            newly_tagged,
            removed,
        ])
    log.info(f"  Appended run stats to {RUNS_CSV}")


# ── Slack notification ─────────────────────────────────────────────────────────

def send_slack(run_dt, total_candidates, already_tagged, newly_tagged, removed=0, error=None):
    if not SLACK_TOKEN:
        log.warning("SLACK_BOT_TOKEN not set — skipping Slack notification")
        return

    ist_offset    = timedelta(hours=5, minutes=30)
    ist_dt        = run_dt + ist_offset
    date_str      = ist_dt.strftime('%d %b %Y')
    time_str      = ist_dt.strftime('%I:%M %p IST')
    current_total = already_tagged - removed + newly_tagged  # live count after this run

    if error:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Allaine Cron — {date_str}"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f":red_circle: *Run failed* at {time_str}\n```{error}```"}}
        ]
    elif newly_tagged == 0 and removed == 0:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Allaine Cron — {date_str}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Triggered at*\n{time_str}"},
                {"type": "mrkdwn", "text": f"*Total in Allaine*\n{current_total}"},
                {"type": "mrkdwn", "text": f"*Added this run*\n{newly_tagged}"},
                {"type": "mrkdwn", "text": f"*Removed this run*\n{removed}"},
            ]},
            {"type": "section", "text": {"type": "mrkdwn", "text": ":white_check_mark: No changes to Allaine's queue this run."}}
        ]
    else:
        summary_parts = []
        if newly_tagged > 0:
            summary_parts.append(f":large_green_circle: *{newly_tagged} added*")
        if removed > 0:
            summary_parts.append(f":large_yellow_circle: *{removed} removed* (we replied)")
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Allaine Cron — {date_str}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Triggered at*\n{time_str}"},
                {"type": "mrkdwn", "text": f"*Total in Allaine*\n{current_total}"},
                {"type": "mrkdwn", "text": f"*Added this run*\n:large_green_circle: {newly_tagged}"},
                {"type": "mrkdwn", "text": f"*Removed this run*\n:large_yellow_circle: {removed}"},
            ]},
            {"type": "section", "text": {"type": "mrkdwn", "text": "  |  ".join(summary_parts)}}
        ]

    try:
        r = requests.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {SLACK_TOKEN}", "Content-Type": "application/json"},
            json={"channel": SLACK_CHANNEL, "blocks": blocks, "unfurl_links": False},
            timeout=15,
        )
        resp = r.json()
        if resp.get("ok"):
            log.info("Slack notification sent.")
        else:
            log.warning(f"Slack API error: {resp.get('error')}")
    except Exception as exc:
        log.warning(f"Failed to send Slack notification: {exc}")


# ── Main ───────────────────────────────────────────────────────────────────────

def run():
    now = datetime.now(timezone.utc)
    log.info("=" * 60)
    log.info(f"Allaine cron started | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    log.info("=" * 60)

    if not TOKEN:
        log.error("SEQUENCER_API_KEY not set — aborting")
        sys.exit(1)
    if not DB_URL:
        log.error("DATABASE_URL not set — aborting")
        sys.exit(1)

    # ── Load all required data ─────────────────────────────────────
    sender_emails  = load_sender_emails()
    booked_domains = get_booked_domains()
    allaine_tag_id = get_or_create_allaine_tag()

    # Total Allaine-tagged leads before this run
    all_allaine_before = fetch_all_pages('/leads', {'filters[tag_ids][]': allaine_tag_id})
    already_tagged     = len(all_allaine_before)

    # ── Cleanup: remove tag from leads where we already replied ───
    removed = 0
    if all_allaine_before:
        log.info(f"\nChecking {already_tagged} Allaine-tagged leads for cleanup...")
        leads_to_remove = find_leads_to_remove(all_allaine_before, sender_emails)
        removed = len(leads_to_remove)
        if leads_to_remove:
            log.info(f"  Removing Allaine tag from {removed} leads (we already replied)")
            detach_tag(allaine_tag_id, leads_to_remove)
        else:
            log.info("  No leads to remove.")

    candidates = get_candidate_leads(allaine_tag_id)

    if not candidates:
        log.info("No candidate leads found. Exiting.")
        log.info("=" * 60)
        append_to_runs_log(now, 0, already_tagged, 0, removed)
        send_slack(now, 0, already_tagged, 0, removed)
        return

    # ── Evaluate leads in parallel ─────────────────────────────────
    log.info(f"\nEvaluating {len(candidates)} leads...")
    qualified = []
    q_lock    = Lock()

    def evaluate(lead):
        result = evaluate_lead(lead, sender_emails, booked_domains, now)
        if result:
            with q_lock:
                qualified.append(result)

    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = [ex.submit(evaluate, lead) for lead in candidates]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                fut.result()
            except Exception as exc:
                log.warning(f"  Evaluation error: {exc}")
            if i % 50 == 0:
                log.info(f"  Progress: {i}/{len(candidates)}")

    log.info(f"\nQualified for Allaine: {len(qualified)}")
    for q in qualified:
        log.info(f"  → {q['name']} <{q['email']}> | last reply: {q['latest_reply']}")

    if not qualified:
        log.info("Nothing to tag.")
        log.info("=" * 60)
        append_to_runs_log(now, len(candidates), already_tagged, 0, removed)
        send_slack(now, len(candidates), already_tagged, 0, removed)
        return

    # ── Tag qualifying leads ───────────────────────────────────────
    lead_ids   = [q['lead_id'] for q in qualified]
    batch_size = 500
    for i in range(0, len(lead_ids), batch_size):
        batch = lead_ids[i:i + batch_size]
        seq_post('/tags/attach-to-leads', {'tag_ids': [allaine_tag_id], 'lead_ids': batch})
        log.info(f"  Tagged batch {i//batch_size + 1}: {len(batch)} leads")
        time.sleep(0.2)

    log.info(f"\nDone. Tagged {len(qualified)} leads as '{ALLAINE_TAG_NAME}'. Removed {removed}.")
    log.info("=" * 60)
    append_to_runs_log(now, len(candidates), already_tagged, len(qualified), removed)
    send_slack(now, len(candidates), already_tagged, len(qualified), removed)


if __name__ == '__main__':
    try:
        run()
    except Exception as exc:
        log.error(f"Cron crashed: {exc}", exc_info=True)
        send_slack(datetime.now(timezone.utc), 0, 0, 0, removed=0, error=str(exc))
        sys.exit(1)
