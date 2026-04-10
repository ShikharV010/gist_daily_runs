"""
Cold Email Insights ETL
Pulls data from Sequencer API + PostgreSQL → writes data/metrics.json

Run: python etl.py
Output: data/metrics.json (read by the Next.js dashboard)
"""

import requests, json, os, time, psycopg2, psycopg2.extras
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ── Config ─────────────────────────────────────────────────────────────────
BASE    = 'https://sequencer.gushwork.ai/api'
_api_key = os.getenv('SEQUENCER_API_KEY', '2|ACD0nLa4smQjXagVUXu7oDxHV8xKtcxyqsebZyyb59448700')
HEADERS = {
    'Authorization': f'Bearer {_api_key}',
    'Content-Type': 'application/json'
}
DB_URL  = os.getenv('DATABASE_URL', 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'data')
OUT_FILE = os.path.join(OUT_DIR, 'metrics.json')

INDUSTRY_MAP = {
    # Campaign IDs → industry label
    6: 'Manufacturing', 7: 'Manufacturing', 8: 'Manufacturing',
    29: 'IT & Consulting', 30: 'IT & Consulting', 31: 'IT & Consulting', 32: 'IT & Consulting',
    34: 'Truck Transportation', 35: 'Truck Transportation', 36: 'Truck Transportation', 37: 'Truck Transportation',
    9: 'Follow-ups',
    39: 'Meta/Other', 40: 'Meta/Other', 41: 'Meta/Other',
}

# ── Helpers ─────────────────────────────────────────────────────────────────
def get(path, params=None, retries=3):
    for i in range(retries):
        try:
            r = requests.get(f'{BASE}/{path}', headers=HEADERS, params=params, timeout=20)
            if r.status_code == 200:
                return r.json().get('data', [])
            if r.status_code == 429:
                time.sleep(2 ** i)
                continue
        except Exception:
            if i < retries - 1:
                time.sleep(2 ** i)
    return []

def get_paginated(path, params=None, max_pages=50):
    params = dict(params or {})
    params['per_page'] = 100
    results = []
    for page in range(1, max_pages + 1):
        params['page'] = page
        r = requests.get(f'{BASE}/{path}', headers=HEADERS, params=params, timeout=30)
        if r.status_code != 200:
            break
        d = r.json()
        data = d.get('data', [])
        if not data:
            break
        results.extend(data)
        meta = d.get('meta', {})
        if meta.get('current_page', page) >= meta.get('last_page', page):
            break
    return results

# ── Step 1: Get campaigns ────────────────────────────────────────────────────
def fetch_campaigns():
    print("Fetching campaigns...", flush=True)
    camps = get_paginated('campaigns')
    out = []
    for c in camps:
        cid = c['id']
        out.append({
            'id': cid,
            'name': c['name'],
            'status': c.get('status'),
            'industry': INDUSTRY_MAP.get(cid, 'Other'),
            'emails_sent': c.get('emails_sent', 0),
            'replied': c.get('replied', 0),
            'interested': c.get('interested', 0),
            'bounced': c.get('bounced', 0),
            'total_leads_contacted': c.get('total_leads_contacted', 0),
            'total_leads': c.get('total_leads', 0),
        })
    print(f"  {len(out)} campaigns", flush=True)
    return out

# ── Step 2: Build sequence step map per campaign ─────────────────────────────
def fetch_step_maps(campaigns):
    """Returns {campaign_id: {step_id: {order, variant, is_hook_a, is_hook_b}}}"""
    print("Fetching sequence steps...", flush=True)
    step_maps = {}
    for c in campaigns:
        cid = c['id']
        steps = get(f'campaigns/{cid}/sequence-steps')
        if not isinstance(steps, list):
            continue
        step_map = {}
        # Find step 1 primary and variant
        primary_step1_id = None
        for s in steps:
            if s.get('order') == 1 and not s.get('variant'):
                primary_step1_id = s['id']
                break
        for s in steps:
            sid = s['id']
            order = s.get('order')
            is_variant = s.get('variant', False)
            variant_from = s.get('variant_from_step')
            # Determine step number for variants (inherit from parent)
            if is_variant and variant_from:
                parent_order = next((x.get('order') for x in steps if x['id'] == variant_from), None)
                order = parent_order
            step_map[sid] = {
                'step_number': order,
                'is_variant': is_variant,
                'variant_from': variant_from,
                'is_hook_a': sid == primary_step1_id,
                'is_hook_b': is_variant and variant_from == primary_step1_id,
            }
        step_maps[cid] = step_map
    print(f"  Done for {len(step_maps)} campaigns", flush=True)
    return step_maps

# ── Step 3: Get all interested replies across campaigns ──────────────────────
def fetch_interested_leads(campaigns):
    print("Fetching interested replies...", flush=True)
    all_replies = []
    for c in campaigns:
        cid = c['id']
        interested = c.get('interested', 0) or 0
        if int(interested) == 0:
            continue
        print(f"  Camp {cid} ({c['name'][:40]}): {interested} interested", flush=True)
        replies = get_paginated(f'campaigns/{cid}/replies', {'interested': 'true'})
        for r in replies:
            if r.get('interested'):
                all_replies.append({
                    'reply_id': r['id'],
                    'lead_id': r['lead_id'],
                    'campaign_id': cid,
                    'campaign_name': c['name'],
                    'industry': c['industry'],
                    'scheduled_email_id': r.get('scheduled_email_id'),
                    'date_received': r.get('date_received'),
                    'from_email': r.get('from_email_address'),
                })
    print(f"  Total interested replies: {len(all_replies)}", flush=True)
    return all_replies

# ── Step 4: Get hook attribution for each interested lead ────────────────────
def fetch_hook_for_lead(lead_id, step_maps, campaign_id):
    """Returns {'hook': 'A'|'B'|'unknown', 'step_replied_to': int}"""
    emails = get(f'leads/{lead_id}/scheduled-emails')
    if not isinstance(emails, list):
        return {'hook': 'unknown', 'step_replied_to': None}
    step_map = step_maps.get(campaign_id, {})
    hook = 'unknown'
    for e in emails:
        sid = e.get('sequence_step_id')
        if sid in step_map:
            info = step_map[sid]
            if info['is_hook_a']:
                hook = 'A'
                break
            elif info['is_hook_b']:
                hook = 'B'
                break
    return {'hook': hook}

def enrich_with_hooks(interested_replies, step_maps):
    print(f"Enriching {len(interested_replies)} leads with hook attribution...", flush=True)
    # Dedupe leads (a lead may be interested in multiple campaigns)
    lead_camp_pairs = list({(r['lead_id'], r['campaign_id']) for r in interested_replies})

    def work(pair):
        lead_id, camp_id = pair
        return (lead_id, camp_id), fetch_hook_for_lead(lead_id, step_maps, camp_id)

    hook_map = {}
    with ThreadPoolExecutor(max_workers=15) as ex:
        futs = {ex.submit(work, p): p for p in lead_camp_pairs}
        done = 0
        for fut in as_completed(futs):
            key, result = fut.result()
            hook_map[key] = result
            done += 1
            if done % 50 == 0:
                print(f"  Hook attribution: {done}/{len(lead_camp_pairs)}", flush=True)

    for r in interested_replies:
        info = hook_map.get((r['lead_id'], r['campaign_id']), {'hook': 'unknown'})
        r['hook'] = info['hook']

    print("  Hook attribution done", flush=True)
    return interested_replies

# ── Step 5: Get demo bookings from PostgreSQL ─────────────────────────────────
def fetch_demo_bookings():
    print("Fetching demo bookings from PostgreSQL...", flush=True)
    try:
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
        return bookings
    except Exception as e:
        print(f"  WARN: DB error — {e}", flush=True)
        return {}

# ── Step 6: Aggregate metrics ─────────────────────────────────────────────────
def aggregate_metrics(campaigns, interested_replies, demo_bookings):
    print("Aggregating metrics...", flush=True)

    # Mark demo bookings
    for r in interested_replies:
        email = (r.get('from_email') or '').lower()
        booking = demo_bookings.get(email)
        r['booked_demo'] = booking is not None
        r['demo_status'] = booking.get('show_status') if booking else None
        r['source_bucket'] = booking.get('source_categories') if booking else None

    # ── Campaign metrics ──────────────────────────────────────────────────────
    camp_interested = defaultdict(list)
    for r in interested_replies:
        camp_interested[r['campaign_id']].append(r)

    campaign_metrics = []
    for c in campaigns:
        cid = c['id']
        interested_list = camp_interested.get(cid, [])
        demos = [r for r in interested_list if r['booked_demo']]
        hook_a = [r for r in interested_list if r['hook'] == 'A']
        hook_b = [r for r in interested_list if r['hook'] == 'B']
        total_contacted = c.get('total_leads_contacted') or 0
        campaign_metrics.append({
            'id': cid,
            'name': c['name'],
            'industry': c['industry'],
            'status': c['status'],
            'emails_sent': c['emails_sent'],
            'total_leads_contacted': total_contacted,
            'total_leads': c['total_leads'],
            'replied': c['replied'],
            'interested': c['interested'],
            'bounced': c['bounced'],
            'reply_rate': round(c['replied'] / total_contacted * 100, 2) if total_contacted else 0,
            'interested_rate': round((c['interested'] or 0) / total_contacted * 100, 2) if total_contacted else 0,
            'interested_count_enriched': len(interested_list),
            'demos_booked': len(demos),
            'demo_rate': round(len(demos) / len(interested_list) * 100, 2) if interested_list else 0,
            'hook_a_interested': len(hook_a),
            'hook_b_interested': len(hook_b),
        })

    # ── Hook metrics ─────────────────────────────────────────────────────────
    hook_a_leads = [r for r in interested_replies if r['hook'] == 'A']
    hook_b_leads = [r for r in interested_replies if r['hook'] == 'B']

    hook_metrics = [
        {
            'hook': 'A',
            'label': 'One-page breakdown',
            'interested': len(hook_a_leads),
            'demos': len([r for r in hook_a_leads if r['booked_demo']]),
            'demo_rate': round(len([r for r in hook_a_leads if r['booked_demo']]) / len(hook_a_leads) * 100, 2) if hook_a_leads else 0,
        },
        {
            'hook': 'B',
            'label': '4-5 pages build',
            'interested': len(hook_b_leads),
            'demos': len([r for r in hook_b_leads if r['booked_demo']]),
            'demo_rate': round(len([r for r in hook_b_leads if r['booked_demo']]) / len(hook_b_leads) * 100, 2) if hook_b_leads else 0,
        },
    ]

    # ── Industry metrics ──────────────────────────────────────────────────────
    industry_camps = defaultdict(list)
    for c in campaign_metrics:
        industry_camps[c['industry']].append(c)

    industry_metrics = []
    for industry, camps in industry_camps.items():
        total_contacted = sum(c['total_leads_contacted'] for c in camps)
        total_replied = sum(c['replied'] for c in camps)
        total_interested = sum(c['interested'] or 0 for c in camps)
        total_demos = sum(c['demos_booked'] for c in camps)
        total_sent = sum(c['emails_sent'] for c in camps)
        industry_metrics.append({
            'industry': industry,
            'campaigns': len(camps),
            'emails_sent': total_sent,
            'total_leads_contacted': total_contacted,
            'replied': total_replied,
            'interested': total_interested,
            'demos_booked': total_demos,
            'reply_rate': round(total_replied / total_contacted * 100, 2) if total_contacted else 0,
            'interested_rate': round(total_interested / total_contacted * 100, 2) if total_contacted else 0,
            'demo_rate_from_interested': round(total_demos / total_interested * 100, 2) if total_interested else 0,
        })

    # ── Interested leads detail ───────────────────────────────────────────────
    leads_detail = []
    for r in interested_replies:
        leads_detail.append({
            'lead_id': r['lead_id'],
            'email': r.get('from_email'),
            'campaign_id': r['campaign_id'],
            'campaign_name': r['campaign_name'],
            'industry': r['industry'],
            'hook': r['hook'],
            'booked_demo': r['booked_demo'],
            'demo_status': r.get('demo_status'),
            'date_received': r.get('date_received'),
        })

    return {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'campaigns': campaign_metrics,
        'hooks': hook_metrics,
        'industries': industry_metrics,
        'interested_leads': leads_detail,
        'totals': {
            'total_emails_sent': sum(c['emails_sent'] for c in campaign_metrics),
            'total_leads_contacted': sum(c['total_leads_contacted'] for c in campaign_metrics),
            'total_interested': sum(c['interested'] or 0 for c in campaign_metrics),
            'total_demos': sum(c['demos_booked'] for c in campaign_metrics),
            'total_reply_rate': round(
                sum(c['replied'] for c in campaign_metrics) /
                max(sum(c['total_leads_contacted'] for c in campaign_metrics), 1) * 100, 2),
        }
    }

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)

    campaigns = fetch_campaigns()
    step_maps = fetch_step_maps(campaigns)

    # Enrich campaigns with industry
    for c in campaigns:
        c['industry'] = INDUSTRY_MAP.get(c['id'], 'Other')

    interested_replies = fetch_interested_leads(campaigns)
    interested_replies = enrich_with_hooks(interested_replies, step_maps)
    demo_bookings = fetch_demo_bookings()

    metrics = aggregate_metrics(campaigns, interested_replies, demo_bookings)

    with open(OUT_FILE, 'w') as f:
        json.dump(metrics, f, indent=2)

    print(f"\n✓ Written to {OUT_FILE}", flush=True)
    print(f"  Campaigns: {len(metrics['campaigns'])}", flush=True)
    print(f"  Total interested: {metrics['totals']['total_interested']}", flush=True)
    print(f"  Total demos: {metrics['totals']['total_demos']}", flush=True)
