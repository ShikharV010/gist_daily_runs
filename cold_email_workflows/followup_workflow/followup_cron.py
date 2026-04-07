#!/usr/bin/env python3
"""
Follow-Up Campaign Cron Job
Schedule: daily at 8PM IST (14:30 UTC) → cron: 30 14 * * *

Flow:
1. GET /leads?filters[tag_ids][]=11  → all 'Interested' leads (tag_id=11)
2. GET /leads/{id}/replies           → full thread per lead (newest first)
   - thread[0].folder == 'Sent'     → we sent last
   - thread[0].folder == 'Inbox'    → prospect sent last → skip
3. 3 conditions to pass:
   a. our last reply was > 24h ago
   b. lead's email domain NOT in gist.gtm_inbound_demo_bookings (postgres, read-only)
   c. lead NOT already in Follow-Ups campaign (id=9)
4. Tag qualifying leads  → 'followup_{dd}_{mmm}' (e.g. followup_07_apr)
5. Add to Follow-Ups campaign (id=9)

Run with: python3 -u followup_cron.py
"""

import os
import sys
import time
import logging
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

# ── Config ─────────────────────────────────────────────────────────────────────
SEQ_BASE  = os.getenv('SEQUENCER_BASE_URL', 'https://sequencer.gushwork.ai/api')
SEQ_TOKEN = os.getenv('SEQUENCER_API_KEY')
DB_URL    = os.getenv('DATABASE_URL')

SEQ_HEADS = {'Authorization': f'Bearer {SEQ_TOKEN}', 'Content-Type': 'application/json'}

SLACK_TOKEN   = os.getenv('SLACK_BOT_TOKEN')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL_ID', 'C0ARFBBN3TN')

INTERESTED_TAG_ID      = 11   # 'Interested' tag
FOLLOWUP_CAMPAIGN_ID   = 9    # 'Follow-Ups' campaign
EVAL_WORKERS           = 15


# ── Logging (flushed in real time) ─────────────────────────────────────────────
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
    """Paginate a small endpoint (campaigns, tags) fully."""
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


# ── Step 1: Interested leads via tag filter ────────────────────────────────────

def get_interested_leads():
    """
    Returns list of lead dicts for all leads tagged 'Interested' (tag_id=11).
    Uses GET /leads?filters[tag_ids][]=11
    """
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

def get_lead_thread(lead_id):
    """
    Returns list of reply/message dicts for this lead, newest first.
    Uses GET /leads/{id}/replies
    """
    try:
        d = seq_get(f'/leads/{lead_id}/replies', {'per_page': 100, 'page': 1})
        return d.get('data', [])
    except Exception as exc:
        log.warning(f"  Thread fetch failed for lead {lead_id}: {exc}")
        return []


# ── Step 3: Booked domains from postgres ──────────────────────────────────────

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


# ── Step 4: Leads already in Follow-Ups campaign ──────────────────────────────

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


# ── Slack notification ─────────────────────────────────────────────────────────

def send_slack(qualified, total_checked, booked_skipped_count, run_dt, error=None):
    """Send a formatted daily summary to the Slack channel."""
    if not SLACK_TOKEN:
        log.warning("SLACK_BOT_TOKEN not set — skipping Slack notification")
        return

    date_str = run_dt.strftime('%d %b %Y')
    time_str = run_dt.strftime('%I:%M %p IST')

    if error:
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f":red_circle: *Run failed* at {time_str}\n```{error}```"}
            }
        ]
    elif not qualified:
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Run time*\n{time_str}"},
                    {"type": "mrkdwn", "text": f"*Interested leads checked*\n{total_checked}"},
                ]
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": ":white_check_mark: Nothing to action today — all prospects are either active, booked, or already in Follow-Ups."}
            }
        ]
    else:
        tag_name = run_dt.strftime('followup_%d_%b').lower()

        # Build lead list — cap at 20 in Slack, show count for the rest
        lead_lines = []
        for q in qualified[:20]:
            reply_date = q['our_last_reply'][:10]
            lead_lines.append(f"• {q['name']}  |  {q['email']}  |  last reply: {reply_date}")
        if len(qualified) > 20:
            lead_lines.append(f"_...and {len(qualified) - 20} more_")

        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"Follow-Up Cron — {date_str}"}
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Run time*\n{time_str}"},
                    {"type": "mrkdwn", "text": f"*Interested leads checked*\n{total_checked}"},
                    {"type": "mrkdwn", "text": f"*Moved to Follow-Ups*\n{len(qualified)}"},
                    {"type": "mrkdwn", "text": f"*Tag applied*\n`{tag_name}`"},
                ]
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*Leads added to Follow-Ups campaign:*\n" + "\n".join(lead_lines)
                }
            }
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
    tag_name    = now.strftime('followup_%d_%b').lower()   # e.g. followup_07_apr

    log.info("=" * 60)
    log.info(f"Follow-up cron started | {now.strftime('%Y-%m-%d %H:%M UTC')}")
    log.info(f"Tag for today: {tag_name}")
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

    # ── Fetch interested leads & campaign state ────────────────────
    log.info("Fetching interested leads (tag_id=11)...")
    interested_leads = get_interested_leads()
    log.info(f"  Interested leads: {len(interested_leads):,}")

    campaign_lead_ids = get_campaign_lead_ids()

    # ── Evaluate each lead in parallel ────────────────────────────
    total     = len(interested_leads)
    qualified = []
    q_lock    = Lock()
    done      = [0]
    d_lock    = Lock()

    def evaluate(lead):
        lead_id = str(lead['id'])
        email   = (lead.get('email') or '').lower()
        domain  = email.split('@')[-1] if '@' in email else ''

        # Get the full message thread (newest first)
        thread = get_lead_thread(lead_id)
        if not thread:
            return

        last_msg = thread[0]

        # Who sent last?
        if last_msg.get('folder') == 'Inbox':
            return  # Prospect sent last — no action needed

        # We sent last — check timestamp
        try:
            last_dt = datetime.fromisoformat(
                last_msg['date_received'].replace('Z', '+00:00')
            )
        except Exception:
            return

        if last_dt > one_day_ago:
            return  # Our reply was < 1 day ago — too soon

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

    log.info(f"Evaluating {total:,} leads ({EVAL_WORKERS} workers)...")
    with ThreadPoolExecutor(max_workers=EVAL_WORKERS) as ex:
        futs = {ex.submit(evaluate, lead): lead['id'] for lead in interested_leads}
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception as exc:
                log.warning(f"  Error for lead {futs[fut]}: {exc}")
            with d_lock:
                done[0] += 1
            if done[0] % 50 == 0:
                log.info(f"  Evaluated {done[0]}/{total} | qualified so far: {len(qualified)}")

    log.info(f"\nQualified for follow-up: {len(qualified)}")
    for q in qualified:
        log.info(f"  → {q['name']} <{q['email']}> | our last reply: {q['our_last_reply']}")

    if not qualified:
        log.info("Nothing to action today.")
        log.info("=" * 60)
        send_slack([], total, 0, now)
        return

    # ── Tag + add to Follow-Ups ────────────────────────────────────
    lead_ids = [q['lead_id'] for q in qualified]

    log.info(f"\nFetching/creating tag '{tag_name}'...")
    tag_id = get_or_create_tag(tag_name)

    log.info(f"Tagging {len(lead_ids)} leads with '{tag_name}'...")
    attach_tag(tag_id, lead_ids)

    log.info(f"Adding {len(lead_ids)} leads to Follow-Ups campaign ({FOLLOWUP_CAMPAIGN_ID})...")
    attach_to_campaign(lead_ids)

    log.info("\n" + "=" * 60)
    log.info(f"Done. {len(qualified)} leads tagged '{tag_name}' → added to Follow-Ups.")
    log.info("=" * 60)
    send_slack(qualified, total, 0, now)


if __name__ == '__main__':
    try:
        run()
    except Exception as exc:
        log.error(f"Cron crashed: {exc}", exc_info=True)
        send_slack([], 0, 0, datetime.now(timezone.utc), error=str(exc))
        sys.exit(1)
