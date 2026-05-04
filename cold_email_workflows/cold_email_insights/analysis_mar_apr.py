#!/usr/bin/env python3
"""
Detailed cold email analysis — March + April 2026.

Uses pre-aggregated endpoints for speed:
  POST /campaigns/{id}/stats              — totals + sequence_step_stats (per-step) by date range
  GET  /campaigns/{id}/line-area-chart-stats — daily timeseries (sent/replied/etc per day)

Outputs (in data/analysis/):
  campaigns_meta.csv          — one row per campaign with industry + routing
  steps_meta.csv              — sequence step details with subjects (incl. spintax variants)
  master_long.csv             — campaign × step × month
  campaign_daily.csv          — campaign × date long-format (for week/month rollups)
  summary_industry_month.csv  — industry × month
  summary_industry_week.csv   — industry × week (ISO)
  summary_routing_month.csv   — receiver routing × month
  summary_step_industry.csv   — industry × step_order rolled up
  summary_variant.csv         — N/A (variants are spintax — see notes)
  closes.csv                  — closes attributed to industry/campaign/step
"""
import os, re, json, csv, time, requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone
import psycopg2, psycopg2.extras

SEQ_KEY = os.getenv('SEQUENCER_API_KEY', '2|ACD0nLa4smQjXagVUXu7oDxHV8xKtcxyqsebZyyb59448700')
HEADERS = {'Authorization': f'Bearer {SEQ_KEY}', 'Content-Type': 'application/json'}
BASE = 'https://sequencer.gushwork.ai/api'
DB_URL = os.getenv('DATABASE_URL', 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'data', 'analysis')
os.makedirs(OUT_DIR, exist_ok=True)

PERIOD_START = date(2026, 3, 1)
PERIOD_END   = date(2026, 4, 30)
MONTHS = [
    ('2026-03', date(2026, 3, 1), date(2026, 3, 31)),
    ('2026-04', date(2026, 4, 1), date(2026, 4, 30)),
]

ACTIVE = {'Manufacturing', 'IT & Consulting', 'Truck Transportation', 'BCS', 'Commercial',
          'EWWS', 'Advertising', 'Medical Equipment', 'Equipment Rental'}

CLOSES_CSV = '/Users/shikhar.vermagushwork.ai/Downloads/gtm_inbound_onboarding_scheduled_visual_2026-05-04T18_55_30.106951595Z.csv'

# --- Industry / routing parsing ---------------------------------------------

_NAME_ALIASES = {
    'MFG Outbound': 'Manufacturing', 'MFG Outbound 1': 'Manufacturing',
    'Mfg': 'Manufacturing', 'Mfg (gush domain)': 'Manufacturing',
    'IT And Consulting': 'IT & Consulting',
    'Meta No Booking': 'Meta/Other',
}
_ROUTING_RE = re.compile(r'\s*[-|]\s*(?:Google|Microsoft|Apple|Outlook|Proofpoint|Mimecast|Yahoo|Custom|Batch)', re.IGNORECASE)
_DATE_RE = re.compile(r'\s*\(\d{2}[_/]\d{2}\).*$')

def industry_of(name):
    n = _DATE_RE.sub('', name).strip()
    m = _ROUTING_RE.search(n)
    if m: n = n[:m.start()].strip()
    return _NAME_ALIASES.get(n, n) or 'Other'

def routing_of(name):
    m = re.search(r'(Google|Microsoft|Apple|Yahoo)\s*[→\-]+\s*(Google|Outlook|Proofpoint|Mimecast|Custom\+Misc|Yahoo|Apple)',
                  name, re.IGNORECASE)
    if m:
        return (m.group(1).title(), m.group(2).title())
    return ('Unknown', 'Unknown')

def receiver_of(name):
    return routing_of(name)[1]

# --- HTTP helpers ------------------------------------------------------------

def get(path, params=None):
    for attempt in range(3):
        try:
            r = requests.get(f'{BASE}/{path}', headers=HEADERS, params=params or {}, timeout=60)
            if r.status_code == 200: return r.json()
            if r.status_code == 429: time.sleep(2 ** attempt); continue
            return None
        except Exception:
            time.sleep(2 ** attempt)
    return None

def post(path, body=None):
    for attempt in range(3):
        try:
            r = requests.post(f'{BASE}/{path}', headers=HEADERS, json=body or {}, timeout=60)
            if r.status_code in (200, 201): return r.json()
            if r.status_code == 429: time.sleep(2 ** attempt); continue
            return None
        except Exception:
            time.sleep(2 ** attempt)
    return None

# --- Date helpers ------------------------------------------------------------

def parse_dt(s):
    if not s: return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None

def to_date(s):
    dt = parse_dt(s)
    return dt.date() if dt else None

def in_period(d):
    return d and PERIOD_START <= d <= PERIOD_END

def iso_week(d):
    y, w, _ = d.isocalendar()
    # ISO week → start (Monday) of the week
    monday = d - timedelta(days=d.isoweekday() - 1)
    return f'{y}-W{w:02d}', monday.isoformat()

def month_label(d):
    return d.strftime('%Y-%m')

# --- Fetchers ---------------------------------------------------------------

def fetch_campaigns():
    print('Fetching campaigns...', flush=True)
    p = {'per_page': 100, 'page': 1}
    out = []
    while True:
        d = get('campaigns', p)
        if not d: break
        out.extend(d.get('data', []))
        meta = d.get('meta', {})
        if p['page'] >= meta.get('last_page', 1): break
        p['page'] += 1
    return out

def fetch_steps(cid):
    d = get(f'campaigns/{cid}/sequence-steps')
    return d.get('data', []) if d else []

def fetch_stats(cid, start, end):
    d = post(f'campaigns/{cid}/stats', {'start_date': start.isoformat(), 'end_date': end.isoformat()})
    return d.get('data', {}) if d else {}

def fetch_chart(cid, start, end):
    """Returns {label: [(date, n), ...]}."""
    d = get(f'campaigns/{cid}/line-area-chart-stats',
            {'start_date': start.isoformat(), 'end_date': end.isoformat()})
    if not d: return {}
    out = {}
    for series in d.get('data', []):
        out[series['label']] = [(to_date(dt_s), n) for dt_s, n in series.get('dates', []) if to_date(dt_s)]
    return out

# --- Closes & demos ---------------------------------------------------------

def fetch_demo_bookings():
    print('Fetching demo bookings...', flush=True)
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        WITH ranked AS (
            SELECT prospect_company, prospect_email, prospect_website,
                   demo_scheduled_date, created_at::date AS created_at_date,
                   show_status, source,
                   ROW_NUMBER() OVER (
                       PARTITION BY LOWER(prospect_email)
                       ORDER BY demo_scheduled_date DESC NULLS LAST,
                                CASE show_status WHEN 'Y' THEN 1 WHEN 'P' THEN 2
                                                  WHEN 'N' THEN 3 WHEN 'R' THEN 4
                                                  ELSE 5 END,
                                created_at DESC
                   ) AS rn
            FROM gist.gtm_inbound_demo_bookings
            WHERE is_latest = true AND prospect_email IS NOT NULL
        )
        SELECT * FROM ranked WHERE rn = 1
          AND source ILIKE '%%gushwork%%email%%'
    """)
    rows = cur.fetchall()
    conn.close()
    today = date.today()
    out = []
    for r in rows:
        em = (r['prospect_email'] or '').lower()
        ds = r['demo_scheduled_date']
        adj = 'N' if (r['show_status'] == 'P' and ds and ds < today) else r['show_status']
        out.append({
            'email': em, 'company': r['prospect_company'] or '',
            'website': r['prospect_website'] or '',
            'demo_scheduled_date': ds, 'created_at_date': r['created_at_date'],
            'show_status': r['show_status'], 'show_status_adj': adj,
        })
    print(f'  {len(out)} demos', flush=True)
    return out

def parse_close_date(s):
    if not s: return None
    s = s.strip()
    for fmt in ['%Y-%m-%d', '%B %d, %Y', '%A, %B %d, %Y', '%b %d, %Y']:
        try: return datetime.strptime(s, fmt).date()
        except: pass
    return None

def load_closes():
    print('Loading closes CSV...', flush=True)
    rows = []
    with open(CLOSES_CSV) as f:
        for r in csv.DictReader(f):
            if (r.get('Source') or '').strip().lower() != 'cold email':
                continue
            email = (r.get('Email') or '').strip().lower()
            try: arr = float((r.get('ARR') or '0').replace('$','').replace(',',''))
            except: arr = 0
            try: mrr = float((r.get('MRR') or '0').replace('$','').replace(',',''))
            except: mrr = 0
            rows.append({
                'email': email, 'company': (r.get('Company') or '').strip(),
                'website': (r.get('Website') or '').strip(),
                'arr': arr, 'mrr': mrr,
                'demo_date': parse_close_date(r.get('Demo Date')),
                'onboarding_date': parse_close_date(r.get('Onboarding Call Date')),
                'cs_name': (r.get('CS Name') or '').strip(),
                'ae_email': (r.get('AE Email') or '').strip(),
            })
    # Add the 2 manual MFG closes if missing
    manual = [
        {'email':'johnny@divinedesignmanufacturing.com','company':'Divine Design Manufacturing','website':'divinedesignmanufacturing.com',
         'arr':9600,'mrr':800,'cs_name':'amitesh.girotiya@gushwork.ai','ae_email':'arabind.mishra@gushwork.ai',
         'demo_date':date(2026,2,6),'onboarding_date':date(2026,2,18)},
        {'email':'jmatheney@icon-mh.com','company':'Icon Material Handling','website':'icon-mh.com',
         'arr':7200,'mrr':600,'cs_name':'sushanth.raj@gushwork.ai','ae_email':'ajith.ponicherry@gushwork.ai',
         'demo_date':date(2026,2,18),'onboarding_date':date(2026,2,20)},
    ]
    existing = {r['email'] for r in rows}
    for m in manual:
        if m['email'] not in existing: rows.append(m)
    print(f'  {len(rows)} cold-email closes (ARR ${sum(r["arr"] for r in rows):,.0f})', flush=True)
    return rows

# --- Lead → step attribution (only for interested leads) --------------------

def fetch_interested_lead_step_attr():
    print('Fetching interested leads + step attribution...', flush=True)
    raw = []
    p = {'per_page': 100, 'page': 1, 'filters[tag_ids][]': 11}
    while True:
        d = get('leads', p)
        if not d: break
        raw.extend(d.get('data', []))
        meta = d.get('meta', {})
        if p['page'] >= meta.get('last_page', 1): break
        p['page'] += 1
    print(f'  {len(raw)} interested leads', flush=True)

    out = {}
    lock = Lock()
    done = [0]
    def fetch_one(L):
        lid = L['id']; em = (L.get('email') or '').lower()
        if not em: return
        d = get(f'leads/{lid}/sent-emails', {'per_page': 50})
        if not d: return
        emails = d.get('data', [])
        # Pick the email that triggered the interest (interested=True), else latest with reply
        best = None
        for e in emails:
            if e.get('interested'):
                if not best or (parse_dt(e.get('sent_at') or '') or datetime.min.replace(tzinfo=timezone.utc)) > (parse_dt(best.get('sent_at') or '') or datetime.min.replace(tzinfo=timezone.utc)):
                    best = e
        if not best:
            for e in emails:
                if (e.get('replies') or 0) > 0:
                    if not best or (parse_dt(e.get('sent_at') or '') or datetime.min.replace(tzinfo=timezone.utc)) > (parse_dt(best.get('sent_at') or '') or datetime.min.replace(tzinfo=timezone.utc)):
                        best = e
        if not best and emails: best = emails[0]
        if best:
            with lock:
                out[em] = {
                    'step_id':     best.get('sequence_step_id'),
                    'campaign_id': best.get('campaign_id'),
                    'sent_at':     to_date(best.get('sent_at')),
                }

    with ThreadPoolExecutor(max_workers=20) as ex:
        futs = [ex.submit(fetch_one, L) for L in raw]
        for fut in as_completed(futs):
            try: fut.result()
            except Exception: pass
            with lock:
                done[0] += 1
                if done[0] % 100 == 0:
                    print(f'    [{done[0]}/{len(raw)}]', flush=True)
    return out

# --- Main ------------------------------------------------------------------

def main():
    t0 = time.time()
    print(f'Period: {PERIOD_START} → {PERIOD_END}', flush=True)

    campaigns = fetch_campaigns()
    # Include any campaign in target industries regardless of current status (paused campaigns
    # that sent in March/April should still count). We trust industry_of() to bucket correctly.
    relevant = [c for c in campaigns if industry_of(c['name']) in ACTIVE]
    print(f'  {len(relevant)} campaigns in target industries (any status)', flush=True)

    # 1. Sequence steps
    print('Fetching sequence steps...', flush=True)
    step_meta = {}
    cid_meta = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(fetch_steps, c['id']): c for c in relevant}
        for fut in as_completed(futs):
            c = futs[fut]
            steps = []
            try: steps = fut.result()
            except Exception: pass
            ind = industry_of(c['name'])
            sender, recv = routing_of(c['name'])
            cid_meta[c['id']] = {
                'campaign_id': c['id'], 'campaign_name': c['name'],
                'industry': ind, 'sender': sender, 'receiver': recv,
                'status': c.get('status', ''),
                'total_leads_alltime': c.get('total_leads', 0),
            }
            for s in steps:
                step_meta[s['id']] = {
                    'campaign_id': c['id'], 'campaign_name': c['name'],
                    'industry': ind, 'sender': sender, 'receiver': recv,
                    'step_id': s['id'],
                    'step_order': s.get('order') if s.get('order') is not None else 0,
                    'subject': (s.get('email_subject') or '').strip()[:300],
                    'wait_days': s.get('wait_in_days', 0),
                    'variant_from_step': s.get('variant_from_step'),
                    'variant': s.get('variant'),
                }
    print(f'  {len(step_meta)} steps total', flush=True)

    # Write campaigns_meta + steps_meta
    with open(os.path.join(OUT_DIR, 'campaigns_meta.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['campaign_id','campaign_name','industry','sender','receiver','status','total_leads_alltime'])
        for cid, m in sorted(cid_meta.items()):
            w.writerow([cid, m['campaign_name'], m['industry'], m['sender'], m['receiver'], m['status'], m['total_leads_alltime']])
    with open(os.path.join(OUT_DIR, 'steps_meta.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['step_id','campaign_id','campaign_name','industry','sender','receiver','step_order','subject','wait_days','variant','variant_from_step'])
        for sid, m in sorted(step_meta.items(), key=lambda x: (x[1]['campaign_id'], x[1]['step_order'])):
            w.writerow([sid, m['campaign_id'], m['campaign_name'], m['industry'], m['sender'], m['receiver'],
                        m['step_order'], m['subject'], m['wait_days'], m['variant'], m['variant_from_step']])

    # 2. Per-campaign per-month stats (with sequence_step_stats)
    print('Fetching per-campaign stats by month (and combined)...', flush=True)
    # Structure: stats[(cid, month_label)] = {totals, step_stats}
    stats_by_cm = {}
    def fetch_one_month(cid, month_label, start, end):
        return (cid, month_label, fetch_stats(cid, start, end))
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = []
        for c in relevant:
            for label, start, end in MONTHS + [('TOTAL', PERIOD_START, PERIOD_END)]:
                futs.append(ex.submit(fetch_one_month, c['id'], label, start, end))
        for fut in as_completed(futs):
            cid, label, data = fut.result()
            stats_by_cm[(cid, label)] = data
    print(f'  fetched stats for {len(relevant)} campaigns × 3 windows = {len(stats_by_cm)} responses', flush=True)

    # 3. Per-campaign daily timeseries (line-area-chart-stats)
    print('Fetching daily timeseries...', flush=True)
    daily_by_cid = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(fetch_chart, c['id'], PERIOD_START, PERIOD_END): c['id'] for c in relevant}
        for fut in as_completed(futs):
            cid = futs[fut]
            try: daily_by_cid[cid] = fut.result()
            except Exception: daily_by_cid[cid] = {}
    print(f'  {len(daily_by_cid)} timeseries fetched', flush=True)

    # 4. Demos & closes
    demo_list = fetch_demo_bookings()
    demos_by_email = {d['email']: d for d in demo_list}
    closes = load_closes()
    closes_by_email = {c['email']: c for c in closes}

    # 5. Interested → step attribution
    int_attr = fetch_interested_lead_step_attr()
    print(f'  attributed {len(int_attr)} interested leads to steps', flush=True)

    # 6. Build outputs --------------------------------------------------------
    print('Writing outputs...', flush=True)

    # 6a. master_long.csv: campaign × step × month
    with open(os.path.join(OUT_DIR, 'master_long.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['campaign_id','campaign_name','industry','sender','receiver',
                    'month','step_id','step_order','subject',
                    'sent','leads_contacted','unique_replies','unique_opens','interested','bounced','unsubscribed'])
        for cid, cm in cid_meta.items():
            for label, _, _ in MONTHS:
                d = stats_by_cm.get((cid, label), {})
                for sss in d.get('sequence_step_stats', []):
                    sid = sss.get('sequence_step_id')
                    sm = step_meta.get(sid, {})
                    w.writerow([cid, cm['campaign_name'], cm['industry'], cm['sender'], cm['receiver'],
                                label, sid, sm.get('step_order', 0), sss.get('email_subject',''),
                                sss.get('sent', 0), sss.get('leads_contacted', 0),
                                sss.get('unique_replies', 0), sss.get('unique_opens', 0),
                                sss.get('interested', 0), sss.get('bounced', 0),
                                sss.get('unsubscribed', 0)])

    # 6b. campaign_daily.csv: campaign × date (long form)
    with open(os.path.join(OUT_DIR, 'campaign_daily.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['campaign_id','campaign_name','industry','sender','receiver','date','metric','value'])
        for cid, daily in daily_by_cid.items():
            cm = cid_meta.get(cid, {})
            for metric, points in daily.items():
                for d, n in points:
                    if not d or not in_period(d): continue
                    w.writerow([cid, cm.get('campaign_name',''), cm.get('industry',''),
                                cm.get('sender',''), cm.get('receiver',''), d.isoformat(), metric, n])

    # Helpers for daily aggregation
    def get_daily_metric(cid, metric_label):
        return daily_by_cid.get(cid, {}).get(metric_label, [])

    # Map metric labels (varies by API). Probe what labels we have:
    seen_labels = set()
    for daily in daily_by_cid.values():
        seen_labels.update(daily.keys())
    print(f'  daily metric labels seen: {sorted(seen_labels)}', flush=True)

    # Sum daily values by industry × month and × week
    def sum_daily(predicate_kind):
        """predicate_kind: 'month' or 'week'. Returns dict[(industry,bucket)] -> {metric: count}."""
        out = defaultdict(lambda: defaultdict(int))
        for cid, daily in daily_by_cid.items():
            ind = cid_meta.get(cid, {}).get('industry', 'Unknown')
            for metric, points in daily.items():
                for d, n in points:
                    if not d or not in_period(d): continue
                    bucket = month_label(d) if predicate_kind == 'month' else iso_week(d)[0]
                    out[(ind, bucket)][metric] += n
        return out

    industry_month = sum_daily('month')
    industry_week  = sum_daily('week')

    # Demo/close attribution per industry × month (using demo_scheduled_date)
    demo_im = defaultdict(lambda: {'demos':0, 'shows':0, 'closes':0, 'arr':0, 'mrr':0})
    for d in demo_list:
        ds = d['demo_scheduled_date']
        if not ds or not in_period(ds): continue
        em = d['email']
        attr = int_attr.get(em)
        if not attr: continue
        ind = step_meta.get(attr.get('step_id'), {}).get('industry')
        if not ind or ind not in ACTIVE: continue
        k = (ind, month_label(ds))
        demo_im[k]['demos'] += 1
        if d['show_status_adj'] == 'Y': demo_im[k]['shows'] += 1
        c = closes_by_email.get(em)
        if c:
            demo_im[k]['closes'] += 1; demo_im[k]['arr'] += c['arr']; demo_im[k]['mrr'] += c['mrr']

    # 6c. summary_industry_month.csv — sum the campaign-month /stats (NOT timeseries),
    # since timeseries doesn't include leads_contacted (a unique-lead count).
    s_im = defaultdict(lambda: {'sent':0,'leads_contacted':0,'unique_replies':0,'interested':0,'bounced':0,'unsubscribed':0})
    for cid, cm in cid_meta.items():
        ind = cm['industry']
        for label, _, _ in MONTHS:
            d = stats_by_cm.get((cid, label), {}) or {}
            s_im[(ind, label)]['sent']            += int(d.get('emails_sent', 0) or 0)
            s_im[(ind, label)]['leads_contacted'] += int(d.get('total_leads_contacted', 0) or 0)
            s_im[(ind, label)]['unique_replies']  += int(d.get('unique_replies_per_contact', 0) or 0)
            s_im[(ind, label)]['interested']      += int(d.get('interested', 0) or 0)
            s_im[(ind, label)]['bounced']         += int(d.get('bounced', 0) or 0)
            s_im[(ind, label)]['unsubscribed']    += int(d.get('unsubscribed', 0) or 0)
    with open(os.path.join(OUT_DIR, 'summary_industry_month.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['industry','month','sent','leads_contacted','unique_replies','interested','bounced','unsubscribed',
                    'demos','shows','closes','arr','mrr',
                    'reply_rate_per_lead','interest_rate_per_lead','interest_rate_per_reply',
                    'demo_per_interested','close_per_demo','close_per_interested'])
        all_keys = set(s_im.keys()) | set(demo_im.keys())
        for k in sorted(all_keys):
            ind, mo = k
            v = s_im.get(k, {'sent':0,'leads_contacted':0,'unique_replies':0,'interested':0,'bounced':0,'unsubscribed':0})
            d = demo_im.get(k, {})
            demos = d.get('demos', 0); shows = d.get('shows', 0); closes_ = d.get('closes', 0)
            arr = d.get('arr', 0); mrr = d.get('mrr', 0)
            cont1 = max(v['leads_contacted'], 1); int1 = max(v['interested'], 1); rep1 = max(v['unique_replies'], 1); demo1 = max(demos, 1)
            w.writerow([ind, mo, v['sent'], v['leads_contacted'], v['unique_replies'], v['interested'], v['bounced'], v['unsubscribed'],
                        demos, shows, closes_, arr, mrr,
                        round(v['unique_replies']/cont1*100, 4), round(v['interested']/cont1*100, 4),
                        round(v['interested']/rep1*100, 2) if v['unique_replies'] else 0,
                        round(demos/int1*100, 2) if v['interested'] else 0,
                        round(closes_/demo1*100, 2) if demos else 0,
                        round(closes_/int1*100, 2) if v['interested'] else 0])

    # 6d. summary_industry_week.csv — from daily timeseries.
    # NOTE: timeseries metrics are event counts, NOT unique-leads. So "replies" here
    # counts reply events (not unique repliers). For unique-lead-based rates, use the
    # monthly summary. Weekly is best for trend visualization.
    with open(os.path.join(OUT_DIR, 'summary_industry_week.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['industry','week','week_start','sent','replies_events','interested_events','bounced','unique_opens'])
        # Re-aggregate weekly with proper week_start label
        wk_agg = defaultdict(lambda: defaultdict(int))
        for cid, daily in daily_by_cid.items():
            ind = cid_meta.get(cid, {}).get('industry', 'Unknown')
            for metric, points in daily.items():
                for d, n in points:
                    if not d or not in_period(d): continue
                    wk_label, wk_start = iso_week(d)
                    wk_agg[(ind, wk_label, wk_start)][metric] += n
        for (ind, wk, ws) in sorted(wk_agg.keys()):
            m = wk_agg[(ind, wk, ws)]
            w.writerow([ind, wk, ws,
                        m.get('Sent', 0), m.get('Replied', 0), m.get('Interested', 0),
                        m.get('Bounced', 0), m.get('Unique Opens', 0)])

    # 6e. summary_routing_month.csv (receiver × month) — use /stats responses for proper denominators
    routing_month = defaultdict(lambda: {'sent':0,'leads_contacted':0,'unique_replies':0,'interested':0,'bounced':0,'unsubscribed':0})
    for cid, cm in cid_meta.items():
        recv = cm['receiver']
        for label, _, _ in MONTHS:
            d = stats_by_cm.get((cid, label), {}) or {}
            routing_month[(recv, label)]['sent']            += int(d.get('emails_sent', 0) or 0)
            routing_month[(recv, label)]['leads_contacted'] += int(d.get('total_leads_contacted', 0) or 0)
            routing_month[(recv, label)]['unique_replies']  += int(d.get('unique_replies_per_contact', 0) or 0)
            routing_month[(recv, label)]['interested']      += int(d.get('interested', 0) or 0)
            routing_month[(recv, label)]['bounced']         += int(d.get('bounced', 0) or 0)
            routing_month[(recv, label)]['unsubscribed']    += int(d.get('unsubscribed', 0) or 0)
    # Demo/close by receiver
    demo_rm = defaultdict(lambda: {'demos':0, 'shows':0, 'closes':0, 'arr':0, 'mrr':0})
    for d in demo_list:
        ds = d['demo_scheduled_date']
        if not ds or not in_period(ds): continue
        em = d['email']; attr = int_attr.get(em)
        if not attr: continue
        cid = attr.get('campaign_id')
        recv = cid_meta.get(cid, {}).get('receiver', 'Unknown')
        k = (recv, month_label(ds))
        demo_rm[k]['demos'] += 1
        if d['show_status_adj'] == 'Y': demo_rm[k]['shows'] += 1
        c = closes_by_email.get(em)
        if c: demo_rm[k]['closes'] += 1; demo_rm[k]['arr'] += c['arr']; demo_rm[k]['mrr'] += c['mrr']
    with open(os.path.join(OUT_DIR, 'summary_routing_month.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['receiver','month','sent','leads_contacted','unique_replies','interested','bounced',
                    'demos','shows','closes','arr','mrr',
                    'reply_rate','interest_rate','demos_per_interested','close_per_demo'])
        keys = set(routing_month.keys()) | set(demo_rm.keys())
        for k in sorted(keys):
            recv, mo = k
            v = routing_month.get(k, {'sent':0,'leads_contacted':0,'unique_replies':0,'interested':0,'bounced':0})
            d = demo_rm.get(k, {})
            demos = d.get('demos',0); shows = d.get('shows',0); closes_ = d.get('closes',0)
            arr = d.get('arr',0); mrr = d.get('mrr',0)
            cont1 = max(v['leads_contacted'], 1); int1 = max(v['interested'], 1); demo1 = max(demos, 1)
            w.writerow([recv, mo, v['sent'], v['leads_contacted'], v['unique_replies'], v['interested'], v['bounced'],
                        demos, shows, closes_, arr, mrr,
                        round(v['unique_replies']/cont1*100, 4), round(v['interested']/cont1*100, 4),
                        round(demos/int1*100, 2) if v['interested'] else 0,
                        round(closes_/demo1*100, 2) if demos else 0])

    # 6f. summary_step_industry.csv: industry × step_order rolled up
    step_ind = defaultdict(lambda: {'sent':0,'leads_contacted':0,'replies':0,'interested':0,'bounced':0,'demos':0,'closes':0})
    for cid, cm in cid_meta.items():
        d = stats_by_cm.get((cid, 'TOTAL'), {})
        for sss in d.get('sequence_step_stats', []):
            sid = sss.get('sequence_step_id')
            sm = step_meta.get(sid, {})
            ind = sm.get('industry', 'Unknown'); so = sm.get('step_order', 0)
            k = (ind, so)
            step_ind[k]['sent']            += sss.get('sent', 0)
            step_ind[k]['leads_contacted'] += sss.get('leads_contacted', 0)
            step_ind[k]['replies']         += sss.get('unique_replies', 0)
            step_ind[k]['interested']      += sss.get('interested', 0)
            step_ind[k]['bounced']         += sss.get('bounced', 0)
    # Demo/close by step → industry
    for em, attr in int_attr.items():
        sid = attr.get('step_id'); sm = step_meta.get(sid, {})
        if not sm: continue
        ind = sm.get('industry'); so = sm.get('step_order', 0)
        if ind not in ACTIVE: continue
        d = demos_by_email.get(em)
        if d and d['demo_scheduled_date'] and in_period(d['demo_scheduled_date']):
            step_ind[(ind, so)]['demos'] += 1
            if closes_by_email.get(em):
                step_ind[(ind, so)]['closes'] += 1
    with open(os.path.join(OUT_DIR, 'summary_step_industry.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['industry','step_order','sent','leads_contacted','unique_replies','interested','bounced','demos','closes',
                    'reply_rate','interest_rate','demos_per_interested','close_per_demo'])
        for k in sorted(step_ind.keys()):
            ind, so = k; v = step_ind[k]
            cont = max(v['leads_contacted'], 1); int1 = max(v['interested'], 1); d1 = max(v['demos'], 1)
            w.writerow([ind, so, v['sent'], v['leads_contacted'], v['replies'], v['interested'], v['bounced'],
                        v['demos'], v['closes'],
                        round(v['replies']/cont*100, 4), round(v['interested']/cont*100, 4),
                        round(v['demos']/int1*100, 2) if v['interested'] else 0,
                        round(v['closes']/d1*100, 2) if v['demos'] else 0])

    # 6g. closes.csv with step attribution
    with open(os.path.join(OUT_DIR, 'closes.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['email','company','website','arr','mrr','cs_name','ae_email','demo_date','onboarding_date',
                    'matched_step_id','matched_campaign_id','matched_industry','matched_receiver','matched_step_order','matched_subject'])
        for c in closes:
            attr = int_attr.get(c['email'], {})
            sid = attr.get('step_id')
            sm = step_meta.get(sid, {})
            w.writerow([c['email'], c['company'], c['website'], c['arr'], c['mrr'],
                        c['cs_name'], c.get('ae_email',''),
                        c['demo_date'].isoformat() if c.get('demo_date') else '',
                        c['onboarding_date'].isoformat() if c.get('onboarding_date') else '',
                        sid or '', attr.get('campaign_id', ''),
                        sm.get('industry',''), sm.get('receiver',''),
                        sm.get('step_order','') if sm else '',
                        sm.get('subject','')[:200] if sm else ''])

    # 6h. Notes file explaining variants
    with open(os.path.join(OUT_DIR, 'NOTES.md'), 'w') as f:
        f.write("""# Detailed Cold Email Analysis — March + April 2026

## Files
- `campaigns_meta.csv` — campaigns in target industries with industry + sender→receiver routing
- `steps_meta.csv` — sequence step subjects and order
- `master_long.csv` — campaign × step × month with sent/replied/interested/bounced (per-step pivot source)
- `campaign_daily.csv` — campaign × date long-form (lets you pivot to any time bucket)
- `summary_industry_month.csv` — industry × month with demos/closes/ARR
- `summary_industry_week.csv` — industry × ISO-week
- `summary_routing_month.csv` — receiver provider (Outlook/Proofpoint/Google/etc.) × month
- `summary_step_industry.csv` — industry × step_order (variants combined; period-total)
- `closes.csv` — closes attributed to step/campaign/industry/receiver

## Variants — important
What we call "A/B variants" in Sequencer-Bison's data model are NOT separate sequence steps.
They are **spintax** inside a single step's subject and body, e.g.
`{Hidden|Untapped|Overlooked} inbound demand for {COMPANY}`.
The API returns ONE row per step regardless of which curly-brace variant landed in the recipient's inbox.
There is no per-variant breakdown of sent/reply/interest counts in the public API.

If you need true variant-level analysis, that would require the underlying email send logs
(which spin was selected per send) — not currently exposed.

## Step attribution for demos / closes
The step that "drove" a demo or close = the step that triggered the lead's "Interested" tagging.
This comes from `/leads/{id}/sent-emails` filtered to records with `interested=true` (latest by sent_at).
Demos and closes are then attributed back to that step's industry/campaign/receiver.

## Time bucketing
- Sent / replied / interested / bounced — bucketed by `sent_at` of the email
- Demos — bucketed by `demo_scheduled_date`
- Closes — bucketed by `Onboarding Call Date` (proxy for revenue-recognition)
""")

    print(f'\n✓ done in {time.time()-t0:.1f}s — outputs in {OUT_DIR}', flush=True)
    for fn in sorted(os.listdir(OUT_DIR)):
        path = os.path.join(OUT_DIR, fn)
        size = os.path.getsize(path)
        print(f'    {fn:35s} {size:>10,} bytes')

if __name__ == '__main__':
    main()
