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

INTERESTED_TAG_ID        = 11
ALLAINE_TAG_NAME         = 'Allaine'
NOT_INTERESTED_TAG_NAME  = 'Not Interested'
LTO_TAG_NAME             = 'LTO'
SENDER_CSV               = os.path.join(os.path.dirname(__file__), 'sender_emails.csv')
RUNS_CSV                 = os.path.join(os.path.dirname(__file__), 'allaine_runs_log.csv')
LEADS_CSV                = os.path.join(os.path.dirname(__file__), 'allaine_leads_log.csv')
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
        seq_post('/tags/remove-from-leads', {'tag_ids': [tag_id], 'lead_ids': batch})
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


# ── Tag helpers ────────────────────────────────────────────────────────────────

def load_all_tags():
    """Fetch all tags and return a name→id dict (lowercased names)."""
    tags = fetch_all_pages('/tags')
    return {t['name'].lower(): t['id'] for t in tags if t.get('name')}


def get_or_create_allaine_tag(tag_map):
    tag_id = tag_map.get(ALLAINE_TAG_NAME.lower())
    if tag_id:
        log.info(f"  '{ALLAINE_TAG_NAME}' tag exists → ID {tag_id}")
        return tag_id
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


def find_tag_based_removals(all_allaine_before, not_interested_tag_id, lto_tag_id):
    """
    Return (ni_ids, lto_ids) — Allaine-tagged lead IDs that also carry
    'Not Interested' or 'LTO' tags, broken out so Slack can show reasons.
    """
    allaine_id_set = {lead['id'] for lead in all_allaine_before}
    ni_ids  = set()
    lto_ids = set()

    if not_interested_tag_id:
        ni_leads = fetch_all_pages('/leads', {'filters[tag_ids][]': not_interested_tag_id})
        ni_ids   = {lead['id'] for lead in ni_leads if lead['id'] in allaine_id_set}
        log.info(f"  Allaine leads also tagged '{NOT_INTERESTED_TAG_NAME}': {len(ni_ids)}")

    if lto_tag_id:
        lto_leads = fetch_all_pages('/leads', {'filters[tag_ids][]': lto_tag_id})
        lto_ids   = {lead['id'] for lead in lto_leads if lead['id'] in allaine_id_set}
        log.info(f"  Allaine leads also tagged '{LTO_TAG_NAME}': {len(lto_ids)}")

    return list(ni_ids), list(lto_ids)


# ── Candidate leads ────────────────────────────────────────────────────────────

def get_candidate_leads(allaine_tag_id, not_interested_tag_id, lto_tag_id):
    """Leads tagged Interested but not Allaine, Not Interested, or LTO."""
    params = {
        'filters[tag_ids][]':          INTERESTED_TAG_ID,
        'filters[excluded_tag_ids][]': allaine_tag_id,
    }
    leads = fetch_all_pages('/leads', params)

    # Filter out NI and LTO tagged leads client-side if we have their IDs
    excluded = set()
    if not_interested_tag_id:
        ni_leads = fetch_all_pages('/leads', {'filters[tag_ids][]': not_interested_tag_id})
        excluded |= {l['id'] for l in ni_leads}
    if lto_tag_id:
        lto_leads = fetch_all_pages('/leads', {'filters[tag_ids][]': lto_tag_id})
        excluded |= {l['id'] for l in lto_leads}

    leads = [l for l in leads if l['id'] not in excluded]
    log.info(f"  Candidate leads (Interested, not Allaine/NI/LTO): {len(leads)}")
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


# ── CSV leads log ─────────────────────────────────────────────────────────────

LEADS_CSV_HEADERS = ['date', 'time_ist', 'action', 'removal_reason', 'name', 'email']

def append_to_leads_csv(entries, run_dt):
    """
    entries: list of dicts with keys: action, removal_reason, name, email
    """
    if not entries:
        return
    ist_dt     = run_dt + timedelta(hours=5, minutes=30)
    date_str   = ist_dt.strftime('%Y-%m-%d')
    time_str   = ist_dt.strftime('%H:%M')
    file_exists = os.path.isfile(LEADS_CSV)
    with open(LEADS_CSV, 'a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=LEADS_CSV_HEADERS)
        if not file_exists:
            writer.writeheader()
        for e in entries:
            writer.writerow({
                'date':           date_str,
                'time_ist':       time_str,
                'action':         e['action'],
                'removal_reason': e.get('removal_reason', ''),
                'name':           e.get('name', ''),
                'email':          e.get('email', ''),
            })
    log.info(f"  Appended {len(entries)} leads to {LEADS_CSV}")


# ── CSV run log ───────────────────────────────────────────────────────────────

def append_to_runs_log(run_dt, total_candidates, already_tagged, newly_tagged,
                       removed_replied=0, removed_ni=0, removed_lto=0):
    file_exists = os.path.exists(RUNS_CSV)
    ist_offset  = timedelta(hours=5, minutes=30)
    ist_dt      = run_dt + ist_offset
    removed     = removed_replied + removed_ni + removed_lto
    with open(RUNS_CSV, 'a', newline='') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow([
                'date', 'time_ist', 'total_candidates', 'already_tagged',
                'newly_tagged', 'removed_total', 'removed_replied', 'removed_not_interested', 'removed_lto',
            ])
        writer.writerow([
            ist_dt.strftime('%Y-%m-%d'),
            ist_dt.strftime('%H:%M'),
            total_candidates,
            already_tagged,
            newly_tagged,
            removed,
            removed_replied,
            removed_ni,
            removed_lto,
        ])
    log.info(f"  Appended run stats to {RUNS_CSV}")


# ── Slack notification ─────────────────────────────────────────────────────────

def send_slack(run_dt, total_candidates, already_tagged, newly_tagged,
               removed_replied=0, removed_ni=0, removed_lto=0, error=None):
    if not SLACK_TOKEN:
        log.warning("SLACK_BOT_TOKEN not set — skipping Slack notification")
        return

    ist_offset    = timedelta(hours=5, minutes=30)
    ist_dt        = run_dt + ist_offset
    date_str      = ist_dt.strftime('%d %b %Y')
    time_str      = ist_dt.strftime('%I:%M %p IST')
    removed       = removed_replied + removed_ni + removed_lto
    current_total = already_tagged - removed + newly_tagged

    if error:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"📧 Reply Queue Tracker — {date_str}"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*Run failed* at {time_str}\n```{error}```"}}
        ]
    else:
        removed_text = f"*Leads Removed This Run*\n• Total: {removed}\n• Replied: {removed_replied}\n• Marked Not Interested: {removed_ni}\n• LTO: {removed_lto}"
        added_text   = f"*Leads Added This Run*\n{newly_tagged}"

        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"📧 Reply Queue Tracker — {date_str}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Triggered at*\n{time_str}"},
                {"type": "mrkdwn", "text": f"*Awaiting Response*\n{current_total}"},
            ]},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": removed_text},
                {"type": "mrkdwn", "text": added_text},
            ]},
        ]
        if newly_tagged == 0 and removed == 0:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "No changes this run."}})

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

    tag_map              = load_all_tags()
    allaine_tag_id       = get_or_create_allaine_tag(tag_map)
    not_interested_tag_id = tag_map.get(NOT_INTERESTED_TAG_NAME.lower())
    lto_tag_id           = tag_map.get(LTO_TAG_NAME.lower())
    log.info(f"  Tag IDs — Allaine: {allaine_tag_id}, Not Interested: {not_interested_tag_id}, LTO: {lto_tag_id}")

    # Total Allaine-tagged leads before this run
    all_allaine_before = fetch_all_pages('/leads', {'filters[tag_ids][]': allaine_tag_id})
    already_tagged     = len(all_allaine_before)

    # ── Cleanup: remove Allaine tag for three reasons ─────────────
    removed_replied = 0
    removed_ni      = 0
    removed_lto     = 0

    if all_allaine_before:
        log.info(f"\nChecking {already_tagged} Allaine-tagged leads for cleanup...")

        # Reason 1: Allaine (or any Gushwork sender) already replied
        replied_ids = find_leads_to_remove(all_allaine_before, sender_emails)
        replied_set = set(replied_ids)

        # Reason 2 & 3: lead tagged 'Not Interested' or 'LTO'
        ni_ids, lto_ids = find_tag_based_removals(all_allaine_before, not_interested_tag_id, lto_tag_id)
        ni_set  = set(ni_ids)  - replied_set           # avoid double-counting
        lto_set = set(lto_ids) - replied_set - ni_set

        all_to_remove = list(replied_set | ni_set | lto_set)
        removed_replied = len(replied_set)
        removed_ni      = len(ni_set)
        removed_lto     = len(lto_set)

        if all_to_remove:
            log.info(f"  Removing Allaine tag from {len(all_to_remove)} leads "
                     f"(replied={removed_replied}, not-interested={removed_ni}, lto={removed_lto})")
            detach_tag(allaine_tag_id, all_to_remove)

            # Build lookup for name/email from allaine leads
            lead_lookup = {lead['id']: lead for lead in all_allaine_before}
            removed_entries = []
            for lid in replied_set:
                lead = lead_lookup.get(lid, {})
                removed_entries.append({'action': 'removed', 'removal_reason': 'replied',
                    'name': f"{lead.get('first_name','')} {lead.get('last_name','')}".strip(),
                    'email': lead.get('email', '')})
            for lid in ni_set:
                lead = lead_lookup.get(lid, {})
                removed_entries.append({'action': 'removed', 'removal_reason': 'not_interested',
                    'name': f"{lead.get('first_name','')} {lead.get('last_name','')}".strip(),
                    'email': lead.get('email', '')})
            for lid in lto_set:
                lead = lead_lookup.get(lid, {})
                removed_entries.append({'action': 'removed', 'removal_reason': 'lto',
                    'name': f"{lead.get('first_name','')} {lead.get('last_name','')}".strip(),
                    'email': lead.get('email', '')})
            append_to_leads_csv(removed_entries, now)
        else:
            log.info("  No leads to remove.")

    removed = removed_replied + removed_ni + removed_lto

    candidates = get_candidate_leads(allaine_tag_id, not_interested_tag_id, lto_tag_id)

    if not candidates:
        log.info("No candidate leads found. Exiting.")
        log.info("=" * 60)
        append_to_runs_log(now, 0, already_tagged, 0, removed_replied, removed_ni, removed_lto)
        send_slack(now, 0, already_tagged, 0, removed_replied, removed_ni, removed_lto)
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
        append_to_runs_log(now, len(candidates), already_tagged, 0, removed_replied, removed_ni, removed_lto)
        send_slack(now, len(candidates), already_tagged, 0, removed_replied, removed_ni, removed_lto)
        return

    # ── Tag qualifying leads ───────────────────────────────────────
    lead_ids   = [q['lead_id'] for q in qualified]
    batch_size = 500
    for i in range(0, len(lead_ids), batch_size):
        batch = lead_ids[i:i + batch_size]
        seq_post('/tags/attach-to-leads', {'tag_ids': [allaine_tag_id], 'lead_ids': batch})
        log.info(f"  Tagged batch {i//batch_size + 1}: {len(batch)} leads")
        time.sleep(0.2)

    added_entries = [{'action': 'added', 'removal_reason': '', 'name': q['name'], 'email': q['email']}
                     for q in qualified]
    append_to_leads_csv(added_entries, now)

    log.info(f"\nDone. Tagged {len(qualified)} leads as '{ALLAINE_TAG_NAME}'. "
             f"Removed {removed} (replied={removed_replied}, ni={removed_ni}, lto={removed_lto}).")
    log.info("=" * 60)
    append_to_runs_log(now, len(candidates), already_tagged, len(qualified), removed_replied, removed_ni, removed_lto)
    send_slack(now, len(candidates), already_tagged, len(qualified), removed_replied, removed_ni, removed_lto)


if __name__ == '__main__':
    try:
        run()
    except Exception as exc:
        log.error(f"Cron crashed: {exc}", exc_info=True)
        send_slack(datetime.now(timezone.utc), 0, 0, 0, error=str(exc))
        sys.exit(1)
