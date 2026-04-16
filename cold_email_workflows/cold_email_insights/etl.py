#!/usr/bin/env python3
"""
Cold Email Insights ETL  v2.0
Sequencer API + PostgreSQL → data/metrics.json

Run: python etl.py
"""
import requests, json, os, time, psycopg2, psycopg2.extras
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
BASE     = 'https://sequencer.gushwork.ai/api'
SEQ_KEY  = os.getenv('SEQUENCER_API_KEY', '2|ACD0nLa4smQjXagVUXu7oDxHV8xKtcxyqsebZyyb59448700')
DB_URL   = os.getenv('DATABASE_URL', 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod')
HEADERS  = {'Authorization': f'Bearer {SEQ_KEY}', 'Content-Type': 'application/json'}
OUT_DIR  = os.path.join(os.path.dirname(__file__), 'data')
OUT_FILE = os.path.join(OUT_DIR, 'metrics.json')
EST      = timezone(timedelta(hours=-4))

INTERESTED_TAG_ID = 11   # Sequencer tag for "Interested" leads

INDUSTRY_MAP = {
    2: 'Manufacturing', 5: 'Manufacturing', 6: 'Manufacturing',
    7: 'Manufacturing', 8: 'Manufacturing',
    29: 'IT & Consulting', 30: 'IT & Consulting',
    31: 'IT & Consulting', 32: 'IT & Consulting',
    34: 'Truck Transportation', 35: 'Truck Transportation',
    36: 'Truck Transportation', 37: 'Truck Transportation',
    9: 'Follow-ups',
    39: 'Meta/Other', 40: 'Meta/Other', 41: 'Meta/Other',
    42: 'BCS', 43: 'BCS', 44: 'BCS', 45: 'BCS',
}
ACTIVE = {'Manufacturing', 'IT & Consulting', 'Truck Transportation', 'BCS'}

# ── Helpers ───────────────────────────────────────────────────────────────────
def to_est(val):
    if not val: return None
    if isinstance(val, str):
        try: val = datetime.fromisoformat(val.replace('Z', '+00:00'))
        except: return None
    if not val.tzinfo: val = val.replace(tzinfo=timezone.utc)
    return val.astimezone(EST).strftime('%Y-%m-%d')

def api_pages(path, params=None, max_pages=200):
    params = dict(params or {}); params['per_page'] = 100
    out = []
    for page in range(1, max_pages + 1):
        params['page'] = page
        try:
            r = requests.get(f'{BASE}/{path}', headers=HEADERS,
                             params=params, timeout=30)
            if r.status_code != 200: break
            d = r.json(); data = d.get('data', [])
            if not data: break
            out.extend(data)
            meta = d.get('meta', {})
            if meta.get('current_page', page) >= meta.get('last_page', page): break
        except Exception as e:
            print(f'  WARN {path}: {e}')
            break
    return out

# ── 1. Campaigns ──────────────────────────────────────────────────────────────
def fetch_campaigns():
    print('Fetching campaigns...', flush=True)
    raw = api_pages('campaigns')
    out = []
    for c in raw:
        cid = c['id']
        out.append({
            'id':                    cid,
            'name':                  c['name'],
            'industry':              INDUSTRY_MAP.get(cid, 'Other'),
            'status':                c.get('status', ''),
            'emails_sent':           int(c.get('emails_sent') or 0),
            'total_leads':           int(c.get('total_leads') or 0),
            'total_leads_contacted': int(c.get('total_leads_contacted') or 0),
            'replied':               int(c.get('replied') or 0),
            'interested':            int(c.get('interested') or 0),
            'bounced':               int(c.get('bounced') or 0),
        })
    print(f'  {len(out)} campaigns', flush=True)
    return out

# ── 2. Interested leads via /leads tag filter (same approach as allaine_cron) ──
CAMP_WORKERS = 8

def _fetch_all_pages(path, params=None):
    """
    Fetch all pages of a paginated endpoint in parallel (page 1 sequential,
    remaining pages concurrent with up to 20 workers) — mirrors allaine_cron.
    """
    p = dict(params or {})
    p['per_page'] = 100
    p['page']     = 1
    r = requests.get(f'{BASE}/{path}', headers=HEADERS, params=p, timeout=30)
    r.raise_for_status()
    d         = r.json()
    items     = list(d.get('data', []))
    last_page = d.get('meta', {}).get('last_page', 1)
    if last_page <= 1:
        return items

    lock = Lock()

    def fetch_page(page):
        pp = dict(p); pp['page'] = page
        r2 = requests.get(f'{BASE}/{path}', headers=HEADERS, params=pp, timeout=30)
        r2.raise_for_status()
        return r2.json().get('data', [])

    with ThreadPoolExecutor(max_workers=20) as ex:
        futs = {ex.submit(fetch_page, pg): pg for pg in range(2, last_page + 1)}
        for fut in as_completed(futs):
            try:
                with lock:
                    items.extend(fut.result())
            except Exception as e:
                print(f'  WARN page fetch: {e}', flush=True)

    return items


def fetch_interested_leads(campaigns):
    """
    Fetch all leads with the Interested tag (id=11) from /leads endpoint.
    This mirrors allaine_cron: O(interested) not O(all_replies).
    Then attribute each lead to a campaign via campaign_id field on the lead object.
    """
    print('Fetching interested leads (tag filter, global)...', flush=True)

    id_to_camp = {c['id']: c for c in campaigns}

    raw_leads = _fetch_all_pages('leads', {'filters[tag_ids][]': INTERESTED_TAG_ID})
    print(f'  {len(raw_leads)} leads with Interested tag', flush=True)

    results = []
    for lead in raw_leads:
        email = (lead.get('email') or '').lower()
        if not email:
            continue

        # campaign_id lives in lead_campaign_data[] — find the entry where interested=true
        cid = None
        for lcd in (lead.get('lead_campaign_data') or []):
            if lcd.get('interested'):
                cid = lcd.get('campaign_id')
                break
        # Fall back to first campaign_data entry if none marked interested
        if cid is None:
            lcd0 = (lead.get('lead_campaign_data') or [{}])[0]
            cid  = lcd0.get('campaign_id')

        ind  = INDUSTRY_MAP.get(cid, 'Other') if cid else 'Unknown'
        camp = id_to_camp.get(cid, {})

        # Skip leads not in active industries
        if ind not in ACTIVE:
            continue

        # Best available date proxy for "when they became interested"
        # updated_at is set when lead status changes (reply / tag application)
        date_val = (lead.get('interested_at') or lead.get('replied_at') or
                    lead.get('updated_at')     or lead.get('created_at'))

        results.append({
            'lead_id':      lead.get('id'),
            'email':        email,
            'campaign_id':  cid,
            'campaign_name': camp.get('name', ''),
            'industry':     ind,
            'date_est':     to_est(date_val),
            'booked_demo':  False, 'is_showup': False,
            'show_status':  None,
            'demo_scheduled_date':  None,
            'demo_created_at_date': None,
        })

    # Dedupe by email (keep latest date_est)
    by_email: dict = {}
    for l in results:
        e = l['email']
        if not e:
            continue
        if e not in by_email or (l['date_est'] or '') > (by_email[e]['date_est'] or ''):
            by_email[e] = l
    deduped = list(by_email.values())
    print(f'  {len(deduped)} unique interested leads in active industries', flush=True)
    return deduped


def enrich_interested_dates(leads):
    """
    Fetch the first Inbox reply date per lead so the time series shows when
    prospects actually replied, not when the Allaine cron last updated them.
    Uses 20 concurrent workers — adds ~30s for ~600 leads.
    """
    print(f'Enriching {len(leads)} leads with actual reply dates (20 workers)...', flush=True)
    lock = Lock()
    done_ct = [0]

    def get_first_inbox_date(lead):
        lid = lead.get('lead_id')
        if not lid:
            return
        for attempt in range(3):
            try:
                r = requests.get(f'{BASE}/leads/{lid}/replies',
                                 headers=HEADERS, params={'per_page': 100}, timeout=30)
                if r.status_code == 200:
                    replies = r.json().get('data', [])
                    inbox = [rp for rp in replies if rp.get('folder') == 'Inbox']
                    if inbox:
                        inbox.sort(key=lambda x: x.get('date_received', ''))
                        lead['date_est'] = to_est(inbox[0].get('date_received'))
                    return
                elif r.status_code == 429:
                    time.sleep(2 ** attempt)
                else:
                    return
            except Exception:
                time.sleep(2 ** attempt)

    with ThreadPoolExecutor(max_workers=20) as ex:
        futs = [ex.submit(get_first_inbox_date, l) for l in leads]
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception:
                pass
            with lock:
                done_ct[0] += 1
                if done_ct[0] % 100 == 0:
                    print(f'  [{done_ct[0]}/{len(leads)}] reply dates fetched', flush=True)

    print(f'  Done', flush=True)
    return leads


# ── 3. Demo bookings from DB ──────────────────────────────────────────────────
def fetch_demo_bookings(interested_leads):
    print('Fetching demo bookings...', flush=True)
    email_to_ind = {l['email']: l['industry'] for l in interested_leads if l['email']}

    conn = psycopg2.connect(DB_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT prospect_company, prospect_email, prospect_website,
               ae_name, demo_scheduled_date,
               created_at::date AS created_at_date,
               show_status, source
        FROM gist.gtm_inbound_demo_bookings
        WHERE source ILIKE '%%gushwork%%email%%'
          AND is_latest = true
        ORDER BY demo_scheduled_date DESC
    """)
    rows = cur.fetchall()
    conn.close()

    today_d = datetime.now(EST).date()
    out = []
    for r in rows:
        email = (r['prospect_email'] or '').lower()
        src   = r.get('source') or ''
        if email in email_to_ind:       ind = email_to_ind[email]
        elif 'allaine' in src.lower(): ind = 'IT & Consulting'
        else:                          ind = 'Manufacturing'

        status = r['show_status']
        demo_d = r['demo_scheduled_date']
        status_adj = 'N' if (status == 'P' and demo_d and demo_d < today_d) else status

        out.append({
            'company':             r['prospect_company'] or '',
            'email':               email,
            'website':             r['prospect_website'] or '',
            'ae_name':             r['ae_name'] or '',
            'demo_scheduled_date': str(demo_d) if demo_d else None,
            'created_at_date':     str(r['created_at_date']) if r['created_at_date'] else None,
            'show_status':         status,
            'show_status_adj':     status_adj,
            'industry':            ind,
        })
    print(f'  {len(out)} bookings', flush=True)
    return out

# ── 4. Daily email stats from DB snapshots ────────────────────────────────────
def fetch_daily_email_stats(campaigns):
    """
    Daily send stats from gist.gtm_sequencer_campaign_stats (cumulative daily
    snapshots). Delta = today − yesterday gives actual sends per day.
    """
    print('Fetching daily email stats (DB snapshots)...', flush=True)
    active_camps = [c for c in campaigns if c['industry'] in ACTIVE]
    active_ids   = [c['id'] for c in active_camps]
    id_to_ind    = {c['id']: c['industry'] for c in campaigns}
    daily        = []

    try:
        conn = psycopg2.connect(DB_URL)
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # MAX() per campaign per day: table has ~40 intra-day snapshots per row,
        # taking the last (max) value before diffing gives correct daily deltas.
        cur.execute("""
            SELECT campaign_id::int AS cid, end_date AS start_date,
                   MAX(emails_sent::int)             AS emails_sent,
                   MAX(total_leads_contacted::int)   AS leads_contacted,
                   MAX(bounced::int)                 AS bounced
            FROM gist.gtm_sequencer_campaign_stats
            WHERE campaign_id::int = ANY(%s)
            GROUP BY campaign_id::int, end_date
            ORDER BY campaign_id::int, end_date
        """, (active_ids,))
        db_rows = cur.fetchall()
        conn.close()

        by_camp: dict = defaultdict(list)
        for r in db_rows:
            by_camp[r['cid']].append(dict(r))

        for cid, camp_rows in by_camp.items():
            prev_e = prev_l = prev_b = 0
            for row in camp_rows:
                de = max(0, row['emails_sent']     - prev_e)
                dl = max(0, row['leads_contacted'] - prev_l)
                db_ = max(0, (row['bounced'] or 0) - prev_b)
                if de or dl:
                    daily.append({
                        'date':          str(row['start_date']),
                        'campaign_id':   cid,
                        'industry':      id_to_ind.get(cid, 'Other'),
                        'emails_delta':  de,
                        'leads_delta':   dl,
                        'bounced_delta': db_,
                    })
                prev_e = row['emails_sent']
                prev_l = row['leads_contacted']
                prev_b = row['bounced'] or 0
    except Exception as e:
        print(f'  DB error: {e}', flush=True)

    daily.sort(key=lambda x: x['date'])
    print(f'  {len(daily)} daily rows', flush=True)
    return daily

# ── 5. Enrich leads with booking data ─────────────────────────────────────────
def enrich_leads(leads, bookings):
    by_email = {b['email']: b for b in bookings if b['email']}
    for l in leads:
        b = by_email.get(l['email'])
        if b:
            l['booked_demo']          = True
            l['show_status']          = b['show_status_adj']
            l['is_showup']            = b['show_status_adj'] == 'Y'
            l['demo_scheduled_date']  = b['demo_scheduled_date']
            l['demo_created_at_date'] = b['created_at_date']
    return leads

# ── 6. Per-campaign aggregates ────────────────────────────────────────────────
def build_campaign_stats(campaigns, leads, bookings):
    today_s = datetime.now(EST).strftime('%Y-%m-%d')
    leads_by_camp = defaultdict(list)
    for l in leads: leads_by_camp[l['campaign_id']].append(l)
    camp_emails = {cid: {l['email'] for l in ls} for cid, ls in leads_by_camp.items()}

    out = []
    for c in campaigns:
        if c['industry'] not in ACTIVE: continue
        cid    = c['id']
        ls     = leads_by_camp.get(cid, [])
        emails = camp_emails.get(cid, set())
        demos  = [l for l in ls if l['booked_demo']]
        shows  = [l for l in ls if l['is_showup']]
        pend   = sum(1 for b in bookings
                     if b['show_status'] == 'P'
                     and (b['demo_scheduled_date'] or '') >= today_s
                     and b['email'] in emails)

        sent  = max(c['emails_sent'], 1)
        cont  = max(c['total_leads_contacted'], 1)
        inte  = len(ls)
        nd    = len(demos)
        ns    = len(shows)
        np_d  = max(nd - pend, 0)

        out.append({
            'id': cid, 'name': c['name'], 'industry': c['industry'],
            'status': c['status'],
            'emails_sent':              c['emails_sent'],
            'total_leads':              c['total_leads'],
            'total_leads_contacted':    c['total_leads_contacted'],
            'replied':                  c['replied'],
            'bounced':                  c['bounced'],
            'interested':               inte,
            'demos_booked':             nd,
            'showups':                  ns,
            'pending_demos':            pend,
            'noshow':                   max(np_d - ns, 0),
            'reply_rate_per_sent':      round(c['replied'] / sent * 100, 2),
            'reply_rate_per_contacted': round(c['replied'] / cont * 100, 2),
            'bounce_rate':              round(c['bounced'] / cont * 100, 2),
            'int_rate_per_sent':        round(inte / sent * 100, 4),
            'int_rate_per_contacted':   round(inte / cont * 100, 4),
            'demos_per_sent':           round(nd   / sent * 100, 4),
            'demos_per_contacted':      round(nd   / cont * 100, 4),
            'showups_per_sent':         round(ns   / sent * 100, 4),
            'showups_per_contacted':    round(ns   / cont * 100, 4),
            'show_rate':                round(ns / np_d * 100, 1) if np_d else 0,
            'demos_per_interested':     round(nd / inte * 100, 1) if inte else 0,
            'showups_per_interested':   round(ns / inte * 100, 1) if inte else 0,
        })
    return out

# ── 7. Time series ────────────────────────────────────────────────────────────
def build_time_series(leads, bookings, daily_email):
    daily = defaultdict(lambda: {
        'date': '', 'emails_delta': 0, 'leads_delta': 0,
        'interested': 0, 'demos': 0, 'showups': 0,
        'by_industry': defaultdict(lambda: {
            'emails_delta': 0, 'leads_delta': 0,
            'interested': 0, 'demos': 0, 'showups': 0
        })
    })

    for row in daily_email:
        d = row['date']; ind = row['industry']
        daily[d]['date'] = d
        daily[d]['emails_delta'] += row['emails_delta']
        daily[d]['leads_delta']  += row['leads_delta']
        daily[d]['by_industry'][ind]['emails_delta'] += row['emails_delta']
        daily[d]['by_industry'][ind]['leads_delta']  += row['leads_delta']

    for l in leads:
        d = l.get('date_est')
        if not d: continue
        ind = l['industry']
        daily[d]['date'] = d
        daily[d]['interested'] += 1
        daily[d]['by_industry'][ind]['interested'] += 1

    # Demos/show-ups keyed by created_at_date (when booking was made, not when meeting is)
    for b in bookings:
        d = b.get('created_at_date'); ind = b['industry']
        if not d: continue
        if d not in daily:
            daily[d]['date'] = d
        daily[d]['demos'] += 1
        daily[d]['by_industry'][ind]['demos'] += 1
        if b['show_status_adj'] == 'Y':
            daily[d]['showups'] += 1
            daily[d]['by_industry'][ind]['showups'] += 1

    result = []
    for d in sorted(daily.keys()):
        row = daily[d]
        result.append({
            'date':          d,
            'emails_delta':  row['emails_delta'],
            'leads_delta':   row['leads_delta'],
            'interested':    row['interested'],
            'demos':         row['demos'],
            'showups':       row['showups'],
            'by_industry':   {k: dict(v) for k, v in row['by_industry'].items()},
        })
    return result

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)

    campaigns     = fetch_campaigns()
    int_leads     = fetch_interested_leads(campaigns)
    int_leads     = enrich_interested_dates(int_leads)
    bookings      = fetch_demo_bookings(int_leads)
    daily_email   = fetch_daily_email_stats(campaigns)
    int_leads     = enrich_leads(int_leads, bookings)
    camp_stats    = build_campaign_stats(campaigns, int_leads, bookings)
    time_series   = build_time_series(int_leads, bookings, daily_email)

    today_s  = datetime.now(EST).strftime('%Y-%m-%d')
    a_sent   = sum(c['emails_sent']           for c in camp_stats)
    a_cont   = sum(c['total_leads_contacted'] for c in camp_stats)
    a_rep    = sum(c['replied']               for c in camp_stats)
    a_boun   = sum(c['bounced']               for c in camp_stats)
    a_int    = sum(c['interested']            for c in camp_stats)
    a_demos  = sum(c['demos_booked']          for c in camp_stats)
    a_shows  = sum(c['showups']               for c in camp_stats)
    a_pend   = sum(1 for b in bookings
                   if b['show_status'] == 'P'
                   and (b['demo_scheduled_date'] or '') >= today_s)
    np_d     = max(a_demos - a_pend, 0)

    def r(n, d, digits=2):
        return round(n / max(d, 1) * 100, digits)

    metrics = {
        'generated_at':      datetime.utcnow().isoformat() + 'Z',
        'campaigns':         camp_stats,
        'interested_leads':  int_leads,
        'demo_bookings':     bookings,
        'daily_email_stats': daily_email,
        'time_series':       {'daily': time_series},
        'totals': {
            'emails_sent':              a_sent,
            'leads_contacted':          a_cont,
            'replied':                  a_rep,
            'bounced':                  a_boun,
            'bounce_rate':              r(a_boun, a_cont),
            'interested':               a_int,
            'demos_booked':             a_demos,
            'showups':                  a_shows,
            'pending_demos':            a_pend,
            'noshow':                   max(np_d - a_shows, 0),
            'reply_rate_per_sent':      r(a_rep,   a_sent),
            'reply_rate_per_contacted': r(a_rep,   a_cont),
            'int_rate_per_sent':        r(a_int,   a_sent,  4),
            'int_rate_per_contacted':   r(a_int,   a_cont,  4),
            'demos_per_sent':           r(a_demos, a_sent,  4),
            'demos_per_contacted':      r(a_demos, a_cont,  4),
            'showups_per_sent':         r(a_shows, a_sent,  4),
            'showups_per_contacted':    r(a_shows, a_cont,  4),
            'show_rate':                r(a_shows, np_d) if np_d else 0,
            'demos_per_interested':     r(a_demos, a_int),
            'showups_per_interested':   r(a_shows, a_int),
        },
    }

    with open(OUT_FILE, 'w') as f:
        json.dump(metrics, f, indent=2, default=str)

    t = metrics['totals']
    print(f'\n✓ {OUT_FILE}')
    print(f'  Sent {t["emails_sent"]:,}  Contacted {t["leads_contacted"]:,}')
    print(f'  Interested {t["interested"]}  Demos {t["demos_booked"]}  Shows {t["showups"]}  Pending {t["pending_demos"]}')
