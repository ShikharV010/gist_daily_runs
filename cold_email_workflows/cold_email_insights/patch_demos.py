"""
Quick patch: re-joins demo bookings onto existing metrics.json without re-fetching the API.
Run this after fixing the DB query or whenever the demo bookings change.
"""
import json, psycopg2, psycopg2.extras, os
from collections import defaultdict

DB_URL  = 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod'
OUT_FILE = os.path.join(os.path.dirname(__file__), 'data', 'metrics.json')

# Load existing metrics
with open(OUT_FILE) as f:
    metrics = json.load(f)

# Fetch demo bookings
print("Fetching demo bookings...", flush=True)
conn = psycopg2.connect(DB_URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("""
    SELECT
        prospect_email,
        show_status,
        source,
        source_categories,
        created_at
    FROM gist.gtm_inbound_demo_bookings
    WHERE is_latest = true
""")
rows = cur.fetchall()
conn.close()
bookings = {(r['prospect_email'] or '').lower(): dict(r) for r in rows if r['prospect_email']}
print(f"  {len(bookings)} demo bookings", flush=True)

# Patch interested_leads
for lead in metrics['interested_leads']:
    email = (lead.get('email') or '').lower()
    booking = bookings.get(email)
    lead['booked_demo'] = booking is not None
    lead['demo_status'] = booking.get('show_status') if booking else None
    lead['source_bucket'] = booking.get('source_categories') if booking else None

# Recompute campaign-level demo counts
camp_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    camp_leads[lead['campaign_id']].append(lead)

for c in metrics['campaigns']:
    leads = camp_leads.get(c['id'], [])
    demos = [l for l in leads if l['booked_demo']]
    c['demos_booked'] = len(demos)
    c['demo_rate'] = round(len(demos) / len(leads) * 100, 2) if leads else 0

# Recompute hook-level demo counts
hook_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    hook_leads[lead['hook']].append(lead)

for h in metrics['hooks']:
    leads = hook_leads.get(h['hook'], [])
    demos = [l for l in leads if l['booked_demo']]
    h['demos'] = len(demos)
    h['demo_rate'] = round(len(demos) / len(leads) * 100, 2) if leads else 0

# Recompute industry-level demo counts
industry_leads = defaultdict(list)
for lead in metrics['interested_leads']:
    industry_leads[lead['industry']].append(lead)

for ind in metrics['industries']:
    leads = industry_leads.get(ind['industry'], [])
    demos = [l for l in leads if l['booked_demo']]
    ind['demos_booked'] = len(demos)
    ind['demo_rate_from_interested'] = round(len(demos) / len(leads) * 100, 2) if leads else 0

# Recompute totals
metrics['totals']['total_demos'] = sum(l['booked_demo'] for l in metrics['interested_leads'])

from datetime import datetime
metrics['generated_at'] = datetime.utcnow().isoformat() + 'Z'

with open(OUT_FILE, 'w') as f:
    json.dump(metrics, f, indent=2)

print(f"\n✓ Patched {OUT_FILE}", flush=True)
print(f"  Total demos: {metrics['totals']['total_demos']}", flush=True)
