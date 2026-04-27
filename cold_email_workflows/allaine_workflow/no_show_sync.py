"""
No-Show JustCall SalesDialer sync (Allaine - No Show Leads, campaign 3218289).

Each run:
  1. Push step — bookings with is_latest=true AND show_status='N' AND
     source ILIKE '%Gushwork Email%'. Use phone from booking record if
     present; else lookup Sequencer lead by email and enrich via the same
     LeadMagic→FullEnrich path used by justcall_sync. Push to camp 3218289
     with the standard 5 custom fields PLUS a Demo Date field (id 1228683).
  2. Removal step — bookings with is_latest=true AND show_status IN ('P','Y').
     If any of those prospects (by email or website domain) is currently in
     the No Show roster, DELETE them from the campaign (they came back).
"""
import os
import re
import csv
import time
import logging
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import psycopg2

import justcall_sync

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
JC_NO_SHOW_CAMP = 3218289
CF_DEMO_DATE    = 1228683

DB_URL          = os.getenv('DATABASE_URL')
SEQ_BASE        = os.getenv('SEQUENCER_BASE_URL', 'https://sequencer.gushwork.ai/api')
SEQ_TOKEN       = os.getenv('SEQUENCER_API_KEY')

PROJ_DIR        = os.path.dirname(__file__)
NO_PHONE_CSV    = os.path.join(PROJ_DIR, 'no_show_without_phone.csv')

NO_PHONE_HEADERS = ['date_utc', 'name', 'email', 'company', 'website',
                    'demo_date', 'reason']


def _digits(p): return re.sub(r'\D', '', str(p or ''))

def _bare_domain(url):
    u = str(url or '').strip().lower()
    u = re.sub(r'^https?://(www\d*\.)?', '', u)
    return u.split('/')[0].strip()

def _seq_session():
    s = requests.Session()
    s.headers.update({'Authorization': f'Bearer {SEQ_TOKEN}'})
    return s


# ── DB queries ────────────────────────────────────────────────────────────────
def get_no_show_bookings():
    """is_latest=true, show_status='N', source ILIKE '%Gushwork Email%'."""
    conn = psycopg2.connect(DB_URL)
    conn.set_session(readonly=True, autocommit=True)
    rows = []
    with conn.cursor() as cur:
        cur.execute("""
            SELECT prospect_first_name, prospect_email, prospect_phone_number,
                   prospect_company, prospect_website, demo_scheduled_date, source
            FROM gist.gtm_inbound_demo_bookings
            WHERE is_latest = true
              AND show_status = 'N'
              AND source ILIKE '%%Gushwork Email%%'
        """)
        cols = ['first_name','email','phone','company','website','demo_date','source']
        for r in cur.fetchall():
            rows.append(dict(zip(cols, r)))
    conn.close()
    return rows


def get_returned_bookings():
    """
    is_latest=true, show_status IN ('P','Y'). Returns sets of emails and
    website domains for fast lookup. No source filter — if a previously
    no-show'd prospect comes back via any channel, we should remove them.
    """
    conn = psycopg2.connect(DB_URL)
    conn.set_session(readonly=True, autocommit=True)
    emails, domains = set(), set()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT lower(prospect_email),
                   lower(regexp_replace(regexp_replace(prospect_website,
                          '^https?://(www\\.)?',''), '/.*$', ''))
            FROM gist.gtm_inbound_demo_bookings
            WHERE is_latest = true
              AND show_status IN ('P','Y')
        """)
        for email, dom in cur.fetchall():
            if email:  emails.add(email.strip())
            if dom:    domains.add(dom.strip())
    conn.close()
    return emails, domains


# ── Sequencer lookup ──────────────────────────────────────────────────────────
def lookup_sequencer_lead(email, sess):
    """Return flattened Sequencer lead dict, or None."""
    try:
        r = sess.get(f'{SEQ_BASE}/leads', params={'search': email, 'per_page': 5}, timeout=20)
        items = r.json().get('data', [])
        for item in items:
            if (item.get('email') or '').lower() == email.lower():
                # Now fetch full detail to get custom_variables
                full = sess.get(f'{SEQ_BASE}/leads/{item["id"]}', timeout=20).json().get('data', {})
                cv = {c['name']: (c.get('value') or '') for c in (full.get('custom_variables') or [])}
                return {
                    'lead_id':                full.get('id'),
                    'first_name':             full.get('first_name', '') or '',
                    'last_name':              full.get('last_name', '') or '',
                    'full_name':              cv.get('full_name')
                                                or f"{full.get('first_name','')} {full.get('last_name','')}".strip(),
                    'email':                  (full.get('email') or '').lower(),
                    'title':                  full.get('title', '') or '',
                    'company':                full.get('company', '') or '',
                    'linkedin_url':           cv.get('linkedin_url', ''),
                    'website_url':            cv.get('website_url', ''),
                    'industry_sub_category':  cv.get('industry_sub_category', ''),
                }
    except Exception as exc:
        log.warning(f"    Sequencer lookup failed for {email}: {exc}")
    return None


def latest_inbox_reply_uuid(lead_id, sess, sender_emails):
    """Same shape as allaine_cron.latest_inbox_reply_uuid but standalone."""
    try:
        r = sess.get(f'{SEQ_BASE}/leads/{lead_id}/replies', params={'per_page': 100}, timeout=20)
        replies = r.json().get('data', [])
    except Exception:
        return None
    if not replies: return None

    def pdt(rep):
        try: return datetime.fromisoformat(rep['date_received'].replace('Z', '+00:00'))
        except Exception: return datetime.min

    inbox = [r for r in replies
             if r.get('folder') == 'Inbox'
             and (r.get('from_email_address', '').lower() not in sender_emails)]
    if not inbox: return replies[-1].get('uuid')
    return sorted(inbox, key=pdt)[-1].get('uuid')


# ── No-phone log ──────────────────────────────────────────────────────────────
def _append_no_phone(booking, reason):
    new_file = not os.path.exists(NO_PHONE_CSV)
    with open(NO_PHONE_CSV, 'a', newline='') as f:
        w = csv.DictWriter(f, fieldnames=NO_PHONE_HEADERS)
        if new_file: w.writeheader()
        w.writerow({
            'date_utc':    datetime.utcnow().isoformat(),
            'name':        booking.get('first_name') or '',
            'email':       booking.get('email') or '',
            'company':     booking.get('company') or '',
            'website':     booking.get('website') or '',
            'demo_date':   str(booking.get('demo_date') or ''),
            'reason':      reason,
        })


# ── Date formatter ────────────────────────────────────────────────────────────
def _fmt_demo_date(d):
    if not d: return ''
    if hasattr(d, 'isoformat'): return d.isoformat()  # date / datetime
    return str(d)[:10]  # truncate timestamps to YYYY-MM-DD


# ── Push step ─────────────────────────────────────────────────────────────────
def push_no_shows(sender_emails):
    log.info("\n── No Show sync: pushing new no-show leads ──")
    bookings = get_no_show_bookings()
    log.info(f"  Bookings (no-show, Gushwork Email source): {len(bookings)}")
    if not bookings:
        return 0, 0

    # Current No Show roster (dedup by email AND phone)
    roster = justcall_sync.get_campaign_contacts(JC_NO_SHOW_CAMP)
    jc_emails = {(c.get('email') or '').strip().lower() for c in roster if c.get('email')}
    jc_phones = {_digits(c.get('phone_number')) for c in roster if c.get('phone_number')}
    log.info(f"  No Show roster: {len(roster)} contacts ({len(jc_emails)} emails, {len(jc_phones)} phones)")

    # Filter to brand-new leads
    fresh = []
    for b in bookings:
        e = (b.get('email') or '').strip().lower()
        if not e or e in jc_emails:
            continue
        ph = _digits(b.get('phone'))
        if ph and ph in jc_phones:
            continue
        fresh.append(b)
    log.info(f"  New to push: {len(fresh)}")
    if not fresh:
        return 0, 0

    # Lookup Sequencer leads + replies in parallel (one session per thread is fine,
    # but one session reused is simpler and works at this volume)
    sess = _seq_session()
    seq_leads = {}        # email → flattened lead dict (or None)
    reply_uuids = {}      # email → uuid

    def _lookup(b):
        e = b['email'].lower()
        slead = lookup_sequencer_lead(e, sess)
        uuid = None
        if slead and slead.get('lead_id'):
            uuid = latest_inbox_reply_uuid(slead['lead_id'], sess, sender_emails)
        return e, slead, uuid

    with ThreadPoolExecutor(max_workers=10) as ex:
        for fut in as_completed({ex.submit(_lookup, b): b for b in fresh}):
            e, slead, uuid = fut.result()
            seq_leads[e] = slead
            if uuid: reply_uuids[e] = uuid

    # Decide phone per booking
    needs_enrich = []   # leads to enrich (have linkedin_url but no phone)
    phone_map    = {}   # email → phone string (may be empty)

    for b in fresh:
        e = b['email'].lower()
        booking_phone = _digits(b.get('phone'))
        if booking_phone:
            phone_map[e] = booking_phone
            continue
        slead = seq_leads.get(e)
        if slead and slead.get('linkedin_url'):
            needs_enrich.append({
                'lead_id':      e,  # use email as the cache/result key here
                'first_name':   slead.get('first_name', ''),
                'last_name':    slead.get('last_name', ''),
                'linkedin_url': slead.get('linkedin_url'),
                'email':        e,
                'name':         slead.get('full_name', ''),
                'company':      slead.get('company', ''),
            })
        else:
            phone_map[e] = ''  # nothing to enrich with

    # Run enrichment (uses the shared phone cache from justcall_sync)
    if needs_enrich:
        log.info(f"  Enriching {len(needs_enrich)} no-show leads (LeadMagic→FullEnrich)...")
        enriched = justcall_sync.enrich_phones(needs_enrich)
        for entry in needs_enrich:
            phone_map[entry['email']] = enriched.get(entry['lead_id'], '') or ''

    # Push
    pushed, no_phone = 0, 0
    for b in fresh:
        e = b['email'].lower()
        phone = phone_map.get(e, '')
        if not phone:
            no_phone += 1
            _append_no_phone(b, reason='no_phone_after_enrichment'
                             if e in {x['email'] for x in needs_enrich}
                             else 'no_linkedin_for_enrichment')
            continue

        slead = seq_leads.get(e) or {}
        # Field map: prefer Sequencer values where present, else fall back to booking
        lead_for_post = {
            'first_name':            slead.get('first_name')   or (b.get('first_name') or ''),
            'last_name':             slead.get('last_name')    or '',
            'full_name':             slead.get('full_name')    or (b.get('first_name') or ''),
            'email':                 e,
            'title':                 slead.get('title')        or '',
            'company':               slead.get('company')      or (b.get('company') or ''),
            'linkedin_url':          slead.get('linkedin_url') or '',
            'website_url':           slead.get('website_url')  or _bare_domain(b.get('website')),
            'industry_sub_category': slead.get('industry_sub_category') or '',
        }
        extra = [{'id': str(CF_DEMO_DATE), 'value': _fmt_demo_date(b.get('demo_date'))}]
        cid = justcall_sync.post_contact(lead_for_post, phone, reply_uuids.get(e),
                                          campaign_id=JC_NO_SHOW_CAMP,
                                          extra_custom_fields=extra)
        if cid:
            pushed += 1
        time.sleep(0.1)

    log.info(f"  No Show pushed: {pushed} | no_phone: {no_phone}")
    return pushed, no_phone


# ── Removal step ──────────────────────────────────────────────────────────────
def remove_returned():
    log.info("\n── No Show sync: removing leads who booked again ──")
    returned_emails, returned_domains = get_returned_bookings()
    log.info(f"  Returned (P/Y) bookings: {len(returned_emails)} emails, {len(returned_domains)} website domains")

    contacts = justcall_sync.get_campaign_contacts(JC_NO_SHOW_CAMP)
    if not contacts:
        log.info("  No Show roster empty — nothing to remove.")
        return 0

    to_remove = []
    for c in contacts:
        email = (c.get('email') or '').strip().lower()
        if email and email in returned_emails:
            to_remove.append((c['id'], 'email')); continue
        cf = {f.get('label', '').lower(): (f.get('value') or '').strip().lower()
              for f in (c.get('custom_fields') or [])}
        wdom = _bare_domain(cf.get('website', ''))
        if wdom and wdom in returned_domains:
            to_remove.append((c['id'], 'website'))

    log.info(f"  Scanned {len(contacts)} | matched for removal: {len(to_remove)}")
    removed = 0
    for cid, _ in to_remove:
        if justcall_sync.delete_contact(cid, campaign_id=JC_NO_SHOW_CAMP):
            removed += 1
        time.sleep(0.1)
    log.info(f"  No Show removed: {removed}/{len(to_remove)}")
    return removed


# ── Entry point ───────────────────────────────────────────────────────────────
def run(sender_emails):
    """Called from allaine_cron.finalize_run after the Cold Email JC sync."""
    try:
        push_no_shows(sender_emails)
    except Exception as exc:
        log.error(f"  No Show push failed: {exc}", exc_info=True)
    try:
        remove_returned()
    except Exception as exc:
        log.error(f"  No Show remove failed: {exc}", exc_info=True)
