#!/usr/bin/env python3
"""
Follow-Up Campaign Cron Job
Schedule: daily at 8PM IST (14:30 UTC) → cron: 30 14 * * *

Flow:
1. GET /leads?filters[tag_ids][]=11  → all 'Interested' leads (tag_id=11)
2. GET /leads/{id}/replies           → full thread per lead, sorted newest first
   - latest.folder == 'Inbox'       → prospect sent last → skip
   - latest.folder == 'Sent'        → we sent last → evaluate further
3. 3 conditions to pass:
   a. our last reply was > 24h ago
   b. lead's email domain NOT in gist.gtm_inbound_demo_bookings (postgres, read-only)
   c. lead NOT already in Follow-Ups campaign (id=9)
4. Tag qualifying leads as 'followup'
5. Add to Follow-Ups campaign (id=9)
6. Send Slack summary + append to runs log CSV

Run with: python3 -u followup_cron.py
"""

import os
import sys
import csv
import time
import logging
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))  # fallback for GitHub Actions

# ── Config ─────────────────────────────────────────────────────────────────────
SEQ_BASE  = os.getenv('SEQUENCER_BASE_URL', 'https://sequencer.gushwork.ai/api')
SEQ_TOKEN = os.getenv('SEQUENCER_API_KEY')
DB_URL    = os.getenv('DATABASE_URL')

SEQ_HEADS = {'Authorization': f'Bearer {SEQ_TOKEN}', 'Content-Type': 'application/json'}

SLACK_TOKEN   = os.getenv('SLACK_BOT_TOKEN')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL_ID', 'C0ARFBBN3TN')

INTERESTED_TAG_ID    = 11         # 'Interested' tag
FOLLOWUP_CAMPAIGN_ID = 9          # 'Follow-Ups' campaign
FOLLOWUP_TAG_NAME    = 'followup' # single static tag applied to all follow-up leads
EVAL_WORKERS         = 15

IST_OFFSET = timedelta(hours=5, minutes=30)

LEADS_CSV = os.path.join(os.path.dirname(__file__), 'followup_leads_log.csv')
RUNS_CSV  = os.path.join(os.path.dirname(__file__), 'followup_runs_log.csv')

LEADS_CSV_HEADERS = ['date_added', 'tag', 'name', 'email', 'domain', 'our_last_reply']
RUNS_CSV_HEADERS  = ['date', 'time_ist', 'total_interested', 'already_in_followup', 'newly_added']


# ── Logging ────────────────────────────────────────────────────────────────────
LOG_FILE = os.path.join(os.path.dirname(__file__), 'followup_cron.log')

class FlushHandler(logging.StreamHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

class FlushFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)
log.addHandler(FlushHandler(sys.stdout))
log.addHandler(FlushFileHandler(LOG_FILE))
log.propagate = False


# ── Sequencer API helpers ──────────────────────────────────────────────────────

def seq_get(path, params=None, retries=3):
    url = f"{SEQ_BASE}{path}"
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=SEQ_HEADS, params=params, timeout=(10, 30))
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def seq_post(path, payload, retries=3):
    url = f"{SEQ_BASE}{path}"
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=SEQ_HEADS, json=payload, timeout=(10, 30))
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def fetch_all_pages(path, extra_params=None):
    params = dict(extra_params or {})
    params.update({'per_page': 100, 'page': 1})
    first   = seq_get(path, params)
    items   = list(first.get('data', []))
    last_pg = first.get('meta', {}).get('last_page', 1)
    lock    = Lock()
    if last_pg > 1:
        def fetch(pg):
            p = dict(params); p['page'] = pg
            return seq_get(path, p).get('data', [])
        with ThreadPoolExecutor(max_workers=20) as ex:
            for fut in as_completed({ex.submit(fetch, pg): pg for pg in range(2, last_pg + 1)}):
                with lock:
                    items.extend(fut.result())
    return items


# ── Step 1: Interested leads ───────────────────────────────────────────────────

def get_interested_leads():
    leads, page = [], 1
    while True:
        d = seq_get('/leads', {
            'filters[tag_ids][]': INTERESTED_TAG_ID,
            'per_page': 100,
            'page': page,
        })
        leads.extend(d.get('data', []))
        if page >= d.get('meta', {}).get('last_page', 1):
            break
        page += 1
    return leads


# ── Step 2: Thread per lead ────────────────────────────────────────────────────

def parse_dt(msg):
    try:
        return datetime.fromisoformat(msg['date_received'].replace('Z', '+00:00'))
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def get_lead_thread(lead_id):
    """Returns reply list sorted newest first."""
    try:
        d = seq_get(f'/leads/{lead_id}/replies', {'per_page': 100, 'page': 1})
        replies = d.get('data', [])
        return sorted(replies, key=parse_dt, reverse=True)
    except Exception as exc:
        log.warning(f"  Thread fetch failed for lead {lead_id}: {exc}")
        return []


# ── Step 3: Booked domains ─────────────────────────────────────────────────────

def get_booked_domains(db_conn):
    booked = set()
    with db_conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT lower(split_part(prospect_email, '@', 2))
            FROM gist.gtm_inbound_demo_bookings
            WHERE prospect_email LIKE '%@%'
        """)
        for (d,) in cur.fetchall():
            if d: booked.add(d.strip())
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
        for (d,) in cur.fetchall():
            if d: booked.add(d.strip())
    return booked


# ── Step 4: Leads already in Follow-Ups ───────────────────────────────────────

def get_campaign_lead_ids():
    leads = fetch_all_pages(f'/campaigns/{FOLLOWUP_CAMPAIGN_ID}/leads')
    ids   = {str(l['id']) for l in leads}
    log.info(f"  Leads already in Follow-Ups (campaign {FOLLOWUP_CAMPAIGN_ID}): {len(ids):,}")
    return ids


# ── Step 5: Tag helpers ────────────────────────────────────────────────────────

def get_or_create_tag(tag_name):
    tags = fetch_all_pages('/tags')
    for t in tags:
        if t.get('name', '').lower() == tag_name.lower():
            log.info(f"  Tag '{tag_name}' exists → ID {t['id']}")
            return t['id']
    resp   = seq_post('/tags', {'name': tag_name})
    tag_id = (resp.get('data') or resp).get('id')
    log.info(f"  Created tag '{tag_name}' → ID {tag_id}")
    return tag_id


def attach_tag(tag_id, lead_ids):
    for i in range(0, len(lead_ids), 500):
        seq_post('/tags/attach-to-leads', {'tag_ids': [tag_id], 'lead_ids': lead_ids[i:i+500]})
        time.sleep(0.2)


def attach_to_campaign(lead_ids):
    for i in range(0, len(lead_ids), 500):
        seq_post(f'/campaigns/{FOLLOWUP_CAMPAIGN_ID}/leads/attach-leads', {'lead_ids': lead_ids[i:i+500]})
        time.sleep(0.2)


# ── CSV logging ───────────────────────────────────────────────────────────────

def append_to_leads_csv(qualified, tag_name, run_dt):
    """Append individual qualifying leads to the cumulative lead log."""
    date_str    = run_dt.strftime('%Y-%m-%d')
    file_exists = os.path.isfile(LEADS_CSV)
    with open(LEADS_CSV, 'a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=LEADS_CSV_HEADERS)
        if not file_exists:
            writer.writeheader()
        for q in qualified:
            writer.writerow({
                'date_added':     date_str,
                'tag':            tag_name,
                'name':           q['name'],
                'email':          q['email'],
                'domain':         q['domain'],
                'our_last_reply': q['our_last_reply'],
            })
    log.info(f"  Appended {len(qualified)} rows to {LEADS_CSV}")


def append_to_runs_log(run_dt, total_interested, already_in_followup, newly_added):
    """Append run-level stats to the runs log."""
    ist_dt      = run_dt + IST_OFFSET
    file_exists = os.path.isfile(RUNS_CSV)
    with open(RUNS_CSV, 'a', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(RUNS_CSV_HEADERS)
        writer.writerow([
            ist_dt.strftime('%Y-%m-%d'),
            ist_dt.strftime('%H:%M'),
            total_interested,
            already_in_followup,
            newly_added,
        ])
    log.info(f"  Appended run stats to {RUNS_CSV}")


# ── Slack notification ─────────────────────────────────────────────────────────

def send_slack(run_dt, total_interested, already_in_followup, newly_added, error=None):
    if not SLACK_TOKEN:
        log.warning("SLACK_BOT_TOKEN not set — skipping Slack notification")
        return

    ist_dt   = run_dt + IST_OFFSET
    date_str = ist_dt.strftime('%d %b %Y')
    time_str = ist_dt.strftime('%I:%M %p IST')

    if error:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f":red_circle: *Run failed* at {time_str}\n```{error}```"}}
        ]
    elif newly_added == 0:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Run time*\n{time_str}"},
                {"type": "mrkdwn", "text": f"*Interested leads checked*\n{total_interested}"},
                {"type": "mrkdwn", "text": f"*Already in Follow-Ups*\n{already_in_followup}"},
                {"type": "mrkdwn", "text": f"*Newly added*\n{newly_added}"},
            ]},
            {"type": "section", "text": {"type": "mrkdwn", "text": ":white_check_mark: Nothing to action today — all prospects are either active, booked, or already in Follow-Ups."}}
        ]
    else:
        blocks = [
            {"type": "header", "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}},
            {"type": "section", "fields": [
                {"type": "mrkdwn", "text": f"*Run time*\n{time_str}"},
                {"type": "mrkdwn", "text": f"*Interested leads checked*\n{total_interested}"},
                {"type": "mrkdwn", "text": f"*Already in Follow-Ups*\n{already_in_followup}"},
                {"type": "mrkdwn", "text": f"*Newly added*\n:large_green_circle: {newly_added}"},
            ]},
            {"type": "section", "text": {"type": "mrkdwn", "text": f":bell: *{newly_added} lead(s) moved to Follow-Ups and tagged `{FOLLOWUP_TAG_NAME}`.*"}}
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
    now         = datetime.now(timezone.utc)
    one_day_ago = now - timedelta(hours=24)

    log.info("=" * 60)
    log.info(f"Follow-up cron started | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    log.info("=" * 60)

    if not SEQ_TOKEN:
        log.error("SEQUENCER_API_KEY not set — aborting"); sys.exit(1)
    if not DB_URL:
        log.error("DATABASE_URL not set — aborting"); sys.exit(1)

    # ── Postgres (read-only) ───────────────────────────────────────
    log.info("Connecting to postgres...")
    db_conn = psycopg2.connect(DB_URL)
    db_conn.set_session(readonly=True, autocommit=True)
    booked_domains = get_booked_domains(db_conn)
    db_conn.close()
    log.info(f"  Booked domains: {len(booked_domains):,}")

    # ── Fetch data ─────────────────────────────────────────────────
    log.info("Fetching interested leads (tag_id=11)...")
    interested_leads  = get_interested_leads()
    total_interested  = len(interested_leads)
    log.info(f"  Interested leads: {total_interested:,}")

    campaign_lead_ids   = get_campaign_lead_ids()
    already_in_followup = len(campaign_lead_ids)

    # ── Evaluate each lead in parallel ────────────────────────────
    qualified = []
    q_lock    = Lock()

    def evaluate(lead):
        lead_id = str(lead['id'])
        email   = (lead.get('email') or '').lower()
        domain  = email.split('@')[-1] if '@' in email else ''

        # Fetch full thread, sorted newest first
        thread = get_lead_thread(lead_id)
        if not thread:
            return

        last_msg = thread[0]

        # Prospect sent last → no follow-up needed
        if last_msg.get('folder') == 'Inbox':
            return

        # We sent last — check how long ago
        last_dt = parse_dt(last_msg)
        if last_dt > one_day_ago:
            return  # < 24h ago — too soon

        # Domain not booked?
        if domain and domain in booked_domains:
            return

        # Not already in Follow-Ups?
        if lead_id in campaign_lead_ids:
            return

        name = f"{lead.get('first_name', '')} {lead.get('last_name', '')}".strip()
        with q_lock:
            qualified.append({
                'lead_id':        int(lead_id),
                'name':           name,
                'email':          email,
                'domain':         domain,
                'our_last_reply': last_dt.strftime('%Y-%m-%d %H:%M UTC'),
            })

    log.info(f"Evaluating {total_interested:,} leads ({EVAL_WORKERS} workers)...")
    with ThreadPoolExecutor(max_workers=EVAL_WORKERS) as ex:
        futs = {ex.submit(evaluate, lead): lead['id'] for lead in interested_leads}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                fut.result()
            except Exception as exc:
                log.warning(f"  Error for lead {futs[fut]}: {exc}")
            if i % 50 == 0:
                log.info(f"  Evaluated {i}/{total_interested} | qualified so far: {len(qualified)}")

    log.info(f"\nQualified for follow-up: {len(qualified)}")
    for q in qualified:
        log.info(f"  → {q['name']} <{q['email']}> | our last reply: {q['our_last_reply']}")

    if not qualified:
        log.info("Nothing to action today.")
        log.info("=" * 60)
        append_to_runs_log(now, total_interested, already_in_followup, 0)
        send_slack(now, total_interested, already_in_followup, 0)
        return

    # ── Tag + add to Follow-Ups ────────────────────────────────────
    lead_ids = [q['lead_id'] for q in qualified]

    log.info(f"\nFetching/creating tag '{FOLLOWUP_TAG_NAME}'...")
    tag_id = get_or_create_tag(FOLLOWUP_TAG_NAME)

    log.info(f"Tagging {len(lead_ids)} leads as '{FOLLOWUP_TAG_NAME}'...")
    attach_tag(tag_id, lead_ids)

    log.info(f"Adding {len(lead_ids)} leads to Follow-Ups campaign ({FOLLOWUP_CAMPAIGN_ID})...")
    attach_to_campaign(lead_ids)

    log.info("\n" + "=" * 60)
    log.info(f"Done. {len(qualified)} leads tagged '{FOLLOWUP_TAG_NAME}' → added to Follow-Ups.")
    log.info("=" * 60)

    append_to_leads_csv(qualified, FOLLOWUP_TAG_NAME, now)
    append_to_runs_log(now, total_interested, already_in_followup, len(qualified))
    send_slack(now, total_interested, already_in_followup, len(qualified))


if __name__ == '__main__':
    try:
        run()
    except Exception as exc:
        log.error(f"Cron crashed: {exc}", exc_info=True)
        send_slack(datetime.now(timezone.utc), 0, 0, 0, error=str(exc))
        sys.exit(1)
