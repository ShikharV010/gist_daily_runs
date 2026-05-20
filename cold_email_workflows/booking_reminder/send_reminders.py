"""
Booking Reminder — sends 2h-before-call reminders to inbound demo prospects
whose source is a Gushwork cold email campaign.

Pipeline:
  1. Query gist.gtm_inbound_demo_bookings for upcoming calls (1h30m–2h30m from now)
     filtered to Gushwork-Email-sourced + is_latest + show_status not in (N, C).
  2. For each, look up the prospect in Sequencer by email → get their most recent
     reply → POST a fresh in-thread message via /api/replies/{reply_id}/reply.
  3. Log the send in gist.gtm_booking_reminders_sent (idempotency).

Flags:
  --dry-run   : don't actually POST to Sequencer; just print plan
  --window-h  : hours-before-call to target (default: 2)
  --tolerance-min : ± minutes window around target (default: 30)

Env vars (required):
  DATABASE_URL          postgres DSN to gw_prod
  SEQUENCER_API_KEY     bearer token

Idempotency table (auto-created on first run):
  gist.gtm_booking_reminders_sent (event_id text, reminder_type text, sent_at timestamptz,
    PRIMARY KEY (event_id, reminder_type))
"""
import argparse, os, sys, time, json, traceback
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import psycopg2
import requests
from dotenv import load_dotenv

# Load .env if present (local dev). Production: env vars come from GH Actions secrets.
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'), override=False)
load_dotenv('/Users/shikhar.vermagushwork.ai/Documents/claude/projects/.env', override=False)

DATABASE_URL      = os.getenv('DATABASE_URL')
SEQUENCER_API_KEY = os.getenv('SEQUENCER_API_KEY')
SEQUENCER_BASE    = 'https://sequencer.gushwork.ai/api'

REMINDER_TYPE     = '2h_before'   # logged in tracking table
DEFAULT_WINDOW_H  = 2
DEFAULT_TOL_MIN   = 30            # ± minutes (covers 30-min cron cadence + GH drift)

GUSHWORK_EMAIL_SOURCES_LIKE = '%gushwork email%'  # ILIKE — covers all variants

# ──────────────────────────────────────────────────────────────────────────────
# DB helpers
# ──────────────────────────────────────────────────────────────────────────────

def db_connect():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL env var not set')
    return psycopg2.connect(DATABASE_URL, connect_timeout=15)

def ensure_tracking_table(con):
    """Create gist.gtm_booking_reminders_sent if missing."""
    with con.cursor() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS gist.gtm_booking_reminders_sent (
            event_id        TEXT NOT NULL,
            reminder_type   TEXT NOT NULL,
            prospect_email  TEXT,
            sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sequencer_reply_id BIGINT,
            response_status INT,
            response_body   TEXT,
            PRIMARY KEY (event_id, reminder_type)
        )
        """)
    con.commit()

def fetch_upcoming_bookings(con, window_start_utc, window_end_utc):
    """Pull bookings starting in the window, source = Gushwork Email, not yet reminded."""
    with con.cursor() as cur:
        cur.execute("""
        SELECT b.event_id, b.prospect_email, b.prospect_first_name, b.prospect_company,
               b.ae_name, b.ae_email, b.start_time_utc, b.attendee_time_zone,
               b.show_status, b.source, b.demo_scheduled_date, b.event_url
        FROM gist.gtm_inbound_demo_bookings b
        LEFT JOIN gist.gtm_booking_reminders_sent r
               ON r.event_id = b.event_id AND r.reminder_type = %s
        WHERE b.is_latest = TRUE
          AND b.source ILIKE %s
          AND COALESCE(b.show_status, '') NOT IN ('N','C','Cancelled','cancelled','No Show','N/A')
          AND b.start_time_utc IS NOT NULL
          AND b.start_time_utc >= %s
          AND b.start_time_utc <  %s
          AND r.event_id IS NULL
          AND b.prospect_email IS NOT NULL AND b.prospect_email LIKE '%%@%%'
          AND b.event_id IS NOT NULL
        ORDER BY b.start_time_utc ASC
        """, (REMINDER_TYPE, GUSHWORK_EMAIL_SOURCES_LIKE, window_start_utc, window_end_utc))
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

def mark_sent(con, event_id, prospect_email, reply_id, status_code, response_text):
    with con.cursor() as cur:
        cur.execute("""
        INSERT INTO gist.gtm_booking_reminders_sent
            (event_id, reminder_type, prospect_email, sequencer_reply_id, response_status, response_body)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (event_id, reminder_type) DO NOTHING
        """, (event_id, REMINDER_TYPE, prospect_email, reply_id, status_code, (response_text or '')[:2000]))
    con.commit()

# ──────────────────────────────────────────────────────────────────────────────
# Sequencer helpers
# ──────────────────────────────────────────────────────────────────────────────

def sequencer_session():
    s = requests.Session()
    s.headers.update({
        'Authorization': f'Bearer {SEQUENCER_API_KEY}',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    })
    return s

def find_lead_by_email(s, email):
    """Return the lead_id for an email, or None."""
    r = s.get(f'{SEQUENCER_BASE}/leads', params={'search': email, 'per_page': 5}, timeout=30)
    if r.status_code != 200: return None
    for item in r.json().get('data', []):
        if (item.get('email') or '').lower() == email.lower():
            return item['id']
    return None

def find_most_recent_reply(s, lead_id):
    """Return (reply_id, sender_email_id) for the most-recent reply in the thread, or (None, None)."""
    r = s.get(f'{SEQUENCER_BASE}/leads/{lead_id}/replies', params={'per_page': 10}, timeout=30)
    if r.status_code != 200: return (None, None)
    data = r.json().get('data', [])
    if not data: return (None, None)
    def keyfn(x):
        return x.get('created_at') or x.get('received_at') or ''
    latest = sorted(data, key=keyfn, reverse=True)[0]
    return latest.get('id'), latest.get('sender_email_id')

# Cache sender lookups within one run
_SENDER_CACHE = {}
def get_sender_first_name(s, sender_email_id):
    """Look up the sender (e.g. Anna Wong, Alison George) and return their FIRST name only."""
    if not sender_email_id: return None
    if sender_email_id in _SENDER_CACHE: return _SENDER_CACHE[sender_email_id]
    r = s.get(f'{SEQUENCER_BASE}/sender-emails/{sender_email_id}', timeout=30)
    if r.status_code != 200:
        _SENDER_CACHE[sender_email_id] = None
        return None
    name = (r.json().get('data') or {}).get('name', '') or ''
    fn = extract_first_name(name)
    _SENDER_CACHE[sender_email_id] = fn or None
    return fn or None

def send_in_thread_reply(s, reply_id, html_body):
    r = s.post(
        f'{SEQUENCER_BASE}/replies/{reply_id}/reply',
        json={
            'reply_all': True,
            'inject_previous_email_body': True,
            'message': html_body,
            'use_dedicated_ips': True,
            'content_type': 'html',
        },
        timeout=60,
    )
    return r

# ──────────────────────────────────────────────────────────────────────────────
# Time formatting
# ──────────────────────────────────────────────────────────────────────────────

# Common cal.com / scheduling timezone abbreviations
TZ_ABBR_OVERRIDES = {
    'America/New_York':    ('EST', 'EDT'),
    'America/Chicago':     ('CST', 'CDT'),
    'America/Denver':      ('MST', 'MDT'),
    'America/Los_Angeles': ('PST', 'PDT'),
    'America/Phoenix':     ('MST', 'MST'),  # no DST
    'America/Anchorage':   ('AKST', 'AKDT'),
    'Pacific/Honolulu':    ('HST', 'HST'),
    'Asia/Calcutta':       ('IST', 'IST'),
    'Asia/Kolkata':        ('IST', 'IST'),
    'Europe/London':       ('GMT', 'BST'),
    'Europe/Berlin':       ('CET', 'CEST'),
    'Europe/Paris':        ('CET', 'CEST'),
    'Australia/Sydney':    ('AEST', 'AEDT'),
    'UTC':                 ('UTC', 'UTC'),
}

def format_time_in_tz(start_time_utc, tz_name):
    """Render time as e.g. '2:00 PM EST'."""
    if start_time_utc.tzinfo is None:
        start_time_utc = start_time_utc.replace(tzinfo=timezone.utc)
    try:
        tz = ZoneInfo(tz_name) if tz_name else ZoneInfo('UTC')
    except Exception:
        tz = ZoneInfo('UTC')
        tz_name = 'UTC'
    local = start_time_utc.astimezone(tz)
    # Get abbreviation
    if tz_name in TZ_ABBR_OVERRIDES:
        std, dst = TZ_ABBR_OVERRIDES[tz_name]
        # Check if current is DST
        abbr = dst if local.dst() and local.dst().total_seconds() != 0 else std
    else:
        abbr = local.tzname() or tz_name.split('/')[-1]
    # Format like "2:00 PM EST" — drop leading 0 from hour, lowercase am/pm? They wrote uppercase
    hour_str = local.strftime('%-I:%M %p')   # 2:00 PM
    return f'{hour_str} {abbr}'

# ──────────────────────────────────────────────────────────────────────────────
# Reminder body
# ──────────────────────────────────────────────────────────────────────────────

def extract_first_name(raw):
    """Take ONLY the first word, strip punctuation. Returns '' if nothing usable."""
    if not raw: return ''
    import re
    s = str(raw).strip()
    if not s: return ''
    # Split on any non-letter and take the first non-empty token
    tokens = re.split(r'[^A-Za-z\-\']+', s)
    for t in tokens:
        t = t.strip(" -'")
        if t and any(c.isalpha() for c in t):
            return t
    return ''

def build_html_body(first_name, time_local_str, sender_first_name, event_id):
    invite_url = f'https://cal.com/booking/{event_id}'
    text = (
        f"Hey {first_name},<br><br>"
        f"Just a quick reminder, we have the call scheduled today for <b>{time_local_str}</b>.<br><br>"
        f'Invite Link: <a href="{invite_url}">{invite_url}</a><br><br>'
        f"Talk soon!<br>"
        f"{sender_first_name}"
    )
    return text

def sender_first_name_from_ae(ae_name, ae_email):
    """Derive a first name to sign with."""
    fn = extract_first_name(ae_name)
    if fn: return fn
    if ae_email and '@' in ae_email:
        local = ae_email.split('@')[0]
        first = local.split('.')[0]
        return first.capitalize() if first else 'Team Gushwork'
    return 'Team Gushwork'

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Send 2h-before-call booking reminders.')
    ap.add_argument('--dry-run', action='store_true', help='Plan only; no Sequencer POSTs, no DB inserts.')
    ap.add_argument('--window-h', type=int, default=DEFAULT_WINDOW_H, help='Hours before call to target (default 2).')
    ap.add_argument('--tolerance-min', type=int, default=DEFAULT_TOL_MIN, help='± minutes around target (default 30).')
    args = ap.parse_args()

    if not SEQUENCER_API_KEY:
        print('ERROR: SEQUENCER_API_KEY not set', file=sys.stderr); sys.exit(1)
    if not DATABASE_URL:
        print('ERROR: DATABASE_URL not set', file=sys.stderr); sys.exit(1)

    now_utc = datetime.now(timezone.utc)
    target  = now_utc + timedelta(hours=args.window_h)
    win_start = target - timedelta(minutes=args.tolerance_min)
    win_end   = target + timedelta(minutes=args.tolerance_min)

    mode = 'DRY-RUN' if args.dry_run else 'LIVE'
    print(f'[{now_utc.isoformat()}] ═══ Booking Reminder ({mode}) ═══')
    print(f'  Target: bookings starting in [{win_start.isoformat()}, {win_end.isoformat()}]')

    con = db_connect()
    try:
        ensure_tracking_table(con)
        bookings = fetch_upcoming_bookings(con, win_start, win_end)
        print(f'  Found {len(bookings)} booking(s) to remind')

        if not bookings:
            return

        s = sequencer_session()
        sent_ok = 0; failed = 0
        skipped_missing_email = 0; skipped_missing_event = 0; skipped_no_first_name = 0
        skipped_no_lead = 0; skipped_no_thread = 0
        for b in bookings:
            try:
                email     = (b.get('prospect_email') or '').strip()
                event_id  = (b.get('event_id') or '').strip()
                first_name = extract_first_name(b.get('prospect_first_name'))

                # ── HARD SAFETY GUARDS — never send without these ──────────
                if not email or '@' not in email:
                    print(f'  [SKIP] missing/invalid prospect_email: {email!r}  event_id={event_id}')
                    skipped_missing_email += 1; continue
                if not event_id:
                    print(f'  [SKIP] {email}: missing event_id — cannot construct cal link')
                    skipped_missing_event += 1; continue
                if not first_name:
                    print(f'  [SKIP] {email}: cannot extract first_name from {b.get("prospect_first_name")!r}')
                    skipped_no_first_name += 1; continue

                time_str = format_time_in_tz(b['start_time_utc'], b.get('attendee_time_zone') or 'UTC')

                # Look up lead → most recent reply (+ its sender_email_id) → in-thread send
                lead_id = find_lead_by_email(s, email)
                if not lead_id:
                    print(f'  [SKIP] {email}: lead not found in Sequencer')
                    skipped_no_lead += 1; continue

                reply_id, sender_email_id = find_most_recent_reply(s, lead_id)
                if not reply_id:
                    print(f'  [SKIP] {email}: no prior reply thread (lead {lead_id})')
                    skipped_no_thread += 1; continue

                # Signature = the gushwork mailbox name on this thread (Anna/Alison/Grace/...)
                sender_first = get_sender_first_name(s, sender_email_id) or 'Team Gushwork'
                body = build_html_body(first_name, time_str, sender_first, event_id)

                print(f'  [{"DRY" if args.dry_run else "SEND"}] {email}  | {time_str}  | reply_id={reply_id}  | sender={sender_first}')
                print(f'           body: "Hey {first_name}, call today at {time_str}, link: https://cal.com/booking/{event_id}"')

                if args.dry_run:
                    sent_ok += 1
                    continue

                r = send_in_thread_reply(s, reply_id, body)
                if r.status_code in (200, 201, 202):
                    mark_sent(con, event_id, email, reply_id, r.status_code, r.text[:500])
                    sent_ok += 1
                    print(f'           ✓ sent (HTTP {r.status_code})')
                else:
                    failed += 1
                    print(f'           ✗ FAILED HTTP {r.status_code}: {r.text[:300]}')
                    mark_sent(con, event_id, email, reply_id, r.status_code, r.text[:500])

            except Exception as e:
                failed += 1
                print(f'  [ERR] {b.get("prospect_email")}: {e}')
                traceback.print_exc()

        print(f'\n  Summary:')
        print(f'    sent:                  {sent_ok}')
        print(f'    failed (after POST):   {failed}')
        print(f'    skipped no email:      {skipped_missing_email}')
        print(f'    skipped no event_id:   {skipped_missing_event}')
        print(f'    skipped no first_name: {skipped_no_first_name}')
        print(f'    skipped no lead:       {skipped_no_lead}')
        print(f'    skipped no thread:     {skipped_no_thread}')
    finally:
        con.close()

if __name__ == '__main__':
    main()
