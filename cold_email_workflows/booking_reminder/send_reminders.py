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

# NOTE: schema is created/altered MANUALLY by the user (see schema.sql).
# This script never runs DDL — it assumes gist.gtm_booking_reminders_sent
# already exists with all columns. If columns are missing, the INSERT in
# log_send() will fail loudly with a clear error.

def fetch_upcoming_bookings(con, window_start_utc, window_end_utc, reminder_type=None):
    """Pull bookings starting in the window, source = Gushwork Email, not yet reminded.
    Excludes bookings already logged for the given reminder_type (defaults to REMINDER_TYPE).
    """
    rt = reminder_type or REMINDER_TYPE
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
        """, (rt, GUSHWORK_EMAIL_SOURCES_LIKE, window_start_utc, window_end_utc))
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

SEQUENCER_UI_BASE = 'https://sequencer.gushwork.ai'

def log_send(con, *, event_id, reminder_type, prospect_email, prospect_first_name,
             prospect_company, meeting_start_utc, meeting_time_zone, meeting_local_time_str,
             source, ae_name, ae_email, sender_email_id, sender_first_name, sender_email_address,
             sequencer_lead_id, sequencer_reply_id, sequencer_reply_uuid, cal_invite_url,
             email_subject, email_body_html, response_status, response_body, success):
    """Insert full audit record. Idempotent on (event_id, reminder_type)."""
    # Lead UI page doesn't expose a stable URL (leads have no UUID) — leave NULL.
    sequencer_lead_url  = None
    # Reply UI link uses the UUID, not the numeric id: /inbox/replies/{uuid}
    sequencer_reply_url = f'{SEQUENCER_UI_BASE}/inbox/replies/{sequencer_reply_uuid}' if sequencer_reply_uuid else None
    with con.cursor() as cur:
        cur.execute("""
        INSERT INTO gist.gtm_booking_reminders_sent (
            event_id, reminder_type,
            prospect_email, prospect_first_name, prospect_company,
            meeting_start_utc, meeting_time_zone, meeting_local_time_str,
            source, ae_name, ae_email,
            sender_email_id, sender_first_name, sender_email_address,
            sequencer_lead_id, sequencer_reply_id, sequencer_lead_url, sequencer_reply_url,
            cal_invite_url, email_subject, email_body_html,
            response_status, response_body, success
        ) VALUES (
            %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s
        )
        ON CONFLICT (event_id, reminder_type) DO NOTHING
        """, (
            event_id, reminder_type,
            prospect_email, prospect_first_name, prospect_company,
            meeting_start_utc, meeting_time_zone, meeting_local_time_str,
            source, ae_name, ae_email,
            sender_email_id, sender_first_name, sender_email_address,
            sequencer_lead_id, sequencer_reply_id, sequencer_lead_url, sequencer_reply_url,
            cal_invite_url, email_subject, (email_body_html or '')[:50000],
            response_status, (response_body or '')[:2000], success,
        ))
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

def _get_with_retry(s, url, params=None, attempts=4, timeout=30):
    """GET with retry on timeout / 5xx / 429. Returns response or None."""
    for a in range(attempts):
        try:
            r = s.get(url, params=params, timeout=timeout)
            if r.status_code == 200: return r
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** a)
                continue
            return r   # 4xx other than 429 — return as-is
        except requests.exceptions.Timeout:
            time.sleep(2 ** a)
        except requests.exceptions.RequestException:
            time.sleep(2 ** a)
    return None

def find_lead_by_email(s, email):
    r = _get_with_retry(s, f'{SEQUENCER_BASE}/leads', params={'search': email, 'per_page': 5})
    if not r or r.status_code != 200: return None
    for item in r.json().get('data', []):
        if (item.get('email') or '').lower() == email.lower():
            return item['id']
    return None

def find_most_recent_reply(s, lead_id):
    """Returns (reply_id, sender_email_id, reply_uuid)."""
    r = _get_with_retry(s, f'{SEQUENCER_BASE}/leads/{lead_id}/replies', params={'per_page': 10})
    if not r or r.status_code != 200: return (None, None, None)
    data = r.json().get('data', [])
    if not data: return (None, None, None)
    def keyfn(x):
        return x.get('created_at') or x.get('received_at') or ''
    latest = sorted(data, key=keyfn, reverse=True)[0]
    return latest.get('id'), latest.get('sender_email_id'), latest.get('uuid')

# Cache sender lookups within one run
_SENDER_CACHE = {}
_SENDER_DETAILS_CACHE = {}   # sender_email_id -> email_address
def get_sender_first_name(s, sender_email_id):
    if not sender_email_id: return None
    if sender_email_id in _SENDER_CACHE: return _SENDER_CACHE[sender_email_id]
    r = _get_with_retry(s, f'{SEQUENCER_BASE}/sender-emails/{sender_email_id}')
    if not r or r.status_code != 200:
        _SENDER_CACHE[sender_email_id] = None
        return None
    data = r.json().get('data') or {}
    name = data.get('name', '') or ''
    _SENDER_DETAILS_CACHE[sender_email_id] = data.get('email')
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

                reply_id, sender_email_id, reply_uuid = find_most_recent_reply(s, lead_id)
                if not reply_id:
                    print(f'  [SKIP] {email}: no prior reply thread (lead {lead_id})')
                    skipped_no_thread += 1; continue

                # Signature = the gushwork mailbox name on this thread (Anna/Alison/Grace/...)
                sender_first = get_sender_first_name(s, sender_email_id) or 'Team Gushwork'
                # Also fetch full sender details for audit logging
                sender_email_addr = None
                if sender_email_id and sender_email_id in _SENDER_DETAILS_CACHE:
                    sender_email_addr = _SENDER_DETAILS_CACHE[sender_email_id]
                elif sender_email_id:
                    try:
                        sr = s.get(f'{SEQUENCER_BASE}/sender-emails/{sender_email_id}', timeout=20).json()
                        sender_email_addr = (sr.get('data') or {}).get('email')
                        _SENDER_DETAILS_CACHE[sender_email_id] = sender_email_addr
                    except Exception: pass
                body = build_html_body(first_name, time_str, sender_first, event_id)
                subject = f'Reminder: our call today at {time_str}'
                cal_url = f'https://cal.com/booking/{event_id}'

                print(f'  [{"DRY" if args.dry_run else "SEND"}] {email}  | {time_str}  | reply_id={reply_id}  | sender={sender_first}')
                print(f'           body: "Hey {first_name}, call today at {time_str}, link: https://cal.com/booking/{event_id}"')

                if args.dry_run:
                    sent_ok += 1
                    continue

                r = send_in_thread_reply(s, reply_id, body)
                ok = r.status_code in (200, 201, 202)

                log_send(con,
                    event_id=event_id, reminder_type=REMINDER_TYPE,
                    prospect_email=email, prospect_first_name=first_name,
                    prospect_company=b.get('prospect_company'),
                    meeting_start_utc=b.get('start_time_utc'),
                    meeting_time_zone=b.get('attendee_time_zone'),
                    meeting_local_time_str=time_str,
                    source=b.get('source'),
                    ae_name=b.get('ae_name'), ae_email=b.get('ae_email'),
                    sender_email_id=sender_email_id,
                    sender_first_name=sender_first,
                    sender_email_address=sender_email_addr,
                    sequencer_lead_id=lead_id, sequencer_reply_id=reply_id,
                    sequencer_reply_uuid=reply_uuid,
                    cal_invite_url=cal_url,
                    email_subject=subject, email_body_html=body,
                    response_status=r.status_code, response_body=r.text[:500],
                    success=ok,
                )

                if ok:
                    sent_ok += 1
                    print(f'           ✓ sent (HTTP {r.status_code})')
                else:
                    failed += 1
                    print(f'           ✗ FAILED HTTP {r.status_code}: {r.text[:300]}')

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
