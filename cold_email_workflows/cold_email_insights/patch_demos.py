"""
Quick patch: re-joins demo bookings onto existing metrics.json without re-fetching the API.
Also computes time_series, showups, and enhanced metrics.
Run after fixing DB query or whenever demo bookings change.
"""
import json, psycopg2, psycopg2.extras, os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

DB_URL   = os.getenv('DATABASE_URL', 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod')
OUT_FILE = os.path.join(os.path.dirname(__file__), 'data', 'metrics.json')

EDT = timezone(timedelta(hours=-4))  # EDT (US Eastern Daylight, Mar–Nov)

def to_est_date(val):
    if val is None: return None
    if isinstance(val, str):
        val = datetime.fromisoformat(val.replace('Z', '+00:00'))
    if val.tzinfo is None:
        val = val.replace(tzinfo=timezone.utc)
    return val.astimezone(EDT).strftime('%Y-%m-%d')

# ── Load existing metrics ─────────────────────────────────────────────────────
with open(OUT_FILE) as f:
    metrics = json.load(f)

# ── Fetch demo bookings from PostgreSQL ───────────────────────────────────────
print("Fetching demo bookings...", flush=True)
conn = psycopg2.connect(DB_URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("""
    SELECT
        prospect_email,
        show_status,
        source,
        source_categories,
        start_time_utc,
        created_at
    FROM gist.gtm_inbound_demo_bookings
    WHERE is_latest = true
""")
rows = cur.fetchall()
conn.close()

bookings = {}
for r in rows:
    email = (r['prospect_email'] or '').lower()
    if not email: continue
    bookings[email] = {
        'show_status':       r['show_status'],
        'source':            r['source'],
        'source_categories': r['source_categories'],
        'demo_date':         to_est_date(r['start_time_utc']),
        'booked_at':         to_est_date(r['created_at']),
    }
print(f"  {len(bookings)} demo bookings", flush=True)

# ── Patch interested_leads ────────────────────────────────────────────────────
for lead in metrics['interested_leads']:
    email   = (lead.get('email') or '').lower()
    booking = bookings.get(email)
    lead['booked_demo']   = booking is not None
    lead['demo_status']   = booking['show_status']   if booking else None
    lead['demo_date']     = booking['demo_date']     if booking else None
    lead['booked_at']     = booking['booked_at']     if booking else None
    lead['is_showup']     = booking['show_status'] == 'Y' if booking else False
    lead['source_bucket'] = booking['source_categories'] if booking else None
    # normalise date_received to EST date string for easy grouping
    lead['date_est'] = to_est_date(lead.get('date_received'))

# ── Recompute campaign stats ──────────────────────────────────────────────────
camp_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    camp_leads[lead['campaign_id']].append(lead)

for c in metrics['campaigns']:
    leads   = camp_leads.get(c['id'], [])
    demos   = [l for l in leads if l['booked_demo']]
    showups = [l for l in leads if l['is_showup']]
    total   = max(len(leads), 1)
    c['interested_count_enriched'] = len(leads)
    c['demos_booked']  = len(demos)
    c['showups']       = len(showups)
    c['demo_rate']     = round(len(demos)   / total * 100, 2)
    c['showup_rate']   = round(len(showups) / len(demos) * 100, 2) if demos else 0

# ── Recompute hook stats ──────────────────────────────────────────────────────
hook_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    hook_leads[lead['hook']].append(lead)

for h in metrics['hooks']:
    leads   = hook_leads.get(h['hook'], [])
    demos   = [l for l in leads if l['booked_demo']]
    showups = [l for l in leads if l['is_showup']]
    total   = max(len(leads), 1)
    h['interested'] = len(leads)
    h['demos']      = len(demos)
    h['showups']    = len(showups)
    h['demo_rate']   = round(len(demos)   / total * 100, 2)
    h['showup_rate'] = round(len(showups) / len(demos) * 100, 2) if demos else 0

# ── Recompute industry stats ──────────────────────────────────────────────────
industry_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    industry_leads[lead['industry']].append(lead)

for ind in metrics['industries']:
    leads   = industry_leads.get(ind['industry'], [])
    demos   = [l for l in leads if l['booked_demo']]
    showups = [l for l in leads if l['is_showup']]
    total   = max(len(leads), 1)
    total_d = max(len(demos), 1)
    ind['interested_enriched']      = len(leads)
    ind['demos_booked']             = len(demos)
    ind['showups']                  = len(showups)
    ind['demo_rate_from_interested']= round(len(demos)   / total   * 100, 2)
    ind['showup_rate_from_demos']   = round(len(showups) / total_d * 100, 2)

# ── Time series (daily, EST) ──────────────────────────────────────────────────
print("Building time series...", flush=True)
all_dates = set()
for lead in metrics['interested_leads']:
    if lead.get('date_est'):    all_dates.add(lead['date_est'])
    if lead.get('demo_date'):   all_dates.add(lead['demo_date'])

daily = {}
for d in sorted(all_dates):
    daily[d] = {
        'date': d,
        'interested': 0, 'demos': 0, 'showups': 0,
        'by_industry': defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
        'by_hook':     defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
        'by_campaign': defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
    }

for lead in metrics['interested_leads']:
    d_int  = lead.get('date_est')
    d_demo = lead.get('demo_date')
    ind    = lead.get('industry', 'Other')
    hook   = lead.get('hook', 'unknown')
    cid    = str(lead.get('campaign_id', ''))

    if d_int and d_int in daily:
        daily[d_int]['interested'] += 1
        daily[d_int]['by_industry'][ind]['interested'] += 1
        daily[d_int]['by_hook'][hook]['interested']    += 1
        daily[d_int]['by_campaign'][cid]['interested'] += 1

    if d_demo:
        if d_demo not in daily:
            daily[d_demo] = {
                'date': d_demo,
                'interested': 0, 'demos': 0, 'showups': 0,
                'by_industry': defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
                'by_hook':     defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
                'by_campaign': defaultdict(lambda: {'interested':0,'demos':0,'showups':0}),
            }
        daily[d_demo]['demos'] += 1
        daily[d_demo]['by_industry'][ind]['demos'] += 1
        daily[d_demo]['by_hook'][hook]['demos']    += 1
        daily[d_demo]['by_campaign'][cid]['demos'] += 1
        if lead.get('is_showup'):
            daily[d_demo]['showups'] += 1
            daily[d_demo]['by_industry'][ind]['showups'] += 1
            daily[d_demo]['by_hook'][hook]['showups']    += 1
            daily[d_demo]['by_campaign'][cid]['showups'] += 1

# Convert defaultdicts to plain dicts for JSON serialisation
daily_list = []
for d in sorted(daily.keys()):
    row = daily[d]
    daily_list.append({
        'date':        row['date'],
        'interested':  row['interested'],
        'demos':       row['demos'],
        'showups':     row['showups'],
        'by_industry': {k: dict(v) for k, v in row['by_industry'].items()},
        'by_hook':     {k: dict(v) for k, v in row['by_hook'].items()},
        'by_campaign': {k: dict(v) for k, v in row['by_campaign'].items()},
    })

metrics['time_series'] = {'daily': daily_list}

# ── Recompute totals ──────────────────────────────────────────────────────────
all_leads   = metrics['interested_leads']
total_int   = len(all_leads)
total_demos = sum(1 for l in all_leads if l['booked_demo'])
total_shows = sum(1 for l in all_leads if l['is_showup'])
contacted   = metrics['totals']['total_leads_contacted']
replied_cnt = sum(c.get('replied', 0) for c in metrics['campaigns'])

metrics['totals'].update({
    'total_interested_enriched': total_int,
    'total_demos':               total_demos,
    'total_showups':             total_shows,
    # funnel rates
    'reply_rate':                round(replied_cnt / max(contacted,1) * 100, 2),
    'interested_rate':           round(total_int   / max(contacted,1) * 100, 4),
    'demo_rate_from_interested': round(total_demos / max(total_int,1)  * 100, 2),
    'showup_rate_from_demos':    round(total_shows / max(total_demos,1)* 100, 2),
    # efficiency
    'emails_per_demo':           round(metrics['totals']['total_emails_sent'] / max(total_demos,1)),
    'interested_per_1000':       round(total_int   / max(contacted,1) * 1000, 2),
    'demos_per_1000':            round(total_demos / max(contacted,1) * 1000, 2),
    # date range
    'date_min': daily_list[0]['date']  if daily_list else None,
    'date_max': daily_list[-1]['date'] if daily_list else None,
})

metrics['generated_at'] = datetime.utcnow().isoformat() + 'Z'

with open(OUT_FILE, 'w') as f:
    json.dump(metrics, f, indent=2)

print(f"\n✓ Patched {OUT_FILE}")
t = metrics['totals']
print(f"  Interested: {t['total_interested_enriched']}  Demos: {t['total_demos']}  Show-ups: {t['total_showups']}")
print(f"  Date range: {t['date_min']} → {t['date_max']}")
print(f"  Time series days: {len(daily_list)}")
