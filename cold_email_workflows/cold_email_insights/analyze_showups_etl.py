#!/usr/bin/env python3
"""
analyze_showups_etl.py  v1.0
Query DB for all Gushwork Email show-ups → run Claude analysis on Sybill transcripts
→ save to data/showup_analysis.json

Incremental: skips companies that already have `pain_points_addressed_by_ae` field.
New show-ups are appended; existing records are never re-analyzed unless missing that field.

Run: python analyze_showups_etl.py
"""
import json, os, re, time, psycopg2, psycopg2.extras, anthropic
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

DB_URL   = os.getenv('DATABASE_URL', 'postgresql://airbyte_user:airbyte_user_password@gw-rds-analytics.celzx4qnlkfp.us-east-1.rds.amazonaws.com:5432/gw_prod')
OUT_DIR  = os.path.join(os.path.dirname(__file__), 'data')
OUT_FILE = os.path.join(OUT_DIR, 'showup_analysis.json')
CLIENT   = anthropic.Anthropic()
WORKERS  = 4

# ── 1. Load existing analysis ─────────────────────────────────────────────────
os.makedirs(OUT_DIR, exist_ok=True)
existing = {}
if os.path.exists(OUT_FILE):
    with open(OUT_FILE) as f:
        existing = json.load(f)
print(f"Loaded {len(existing)} existing records from {OUT_FILE}")

# ── 2. Pull show-up data + transcripts from DB ────────────────────────────────
print("Fetching show-up data + transcripts from PostgreSQL...")
conn = psycopg2.connect(DB_URL)
cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

cur.execute("""
    SELECT
        b.prospect_first_name,
        b.prospect_email,
        b.prospect_company,
        b.prospect_website,
        b.demo_scheduled_date,
        b.ae_name,
        b.source,
        s.meeting_id,
        s.title          AS meeting_title,
        s.start_time,
        s.duration_seconds,
        s.participants_names,
        s.url            AS sybill_url,
        t.transcript
    FROM gist.gtm_inbound_demo_bookings b
    JOIN gist.sybill_meetings s
        ON s.title ILIKE '%%' || b.prospect_company || '%%'
    LEFT JOIN gist.sybill_meetings_transcript t
        ON t.meeting_id = s.meeting_id
    WHERE b.source ILIKE '%%gushwork%%email%%'
      AND b.show_status = 'Y'
      AND b.is_latest   = true
    ORDER BY b.demo_scheduled_date DESC, b.prospect_company
""")
rows = cur.fetchall()
conn.close()

companies = defaultdict(list)
for r in rows:
    companies[r['prospect_company']].append(dict(r))
print(f"  {len(rows)} meeting records for {len(companies)} companies")

# ── 3. Determine which need analysis ──────────────────────────────────────────
to_analyze = {}
for company, meetings in companies.items():
    rec = existing.get(company, {})
    if 'pain_points_addressed_by_ae' not in rec:
        to_analyze[company] = meetings

print(f"  {len(to_analyze)} companies need analysis (skipping {len(companies) - len(to_analyze)} existing)")

# ── 4. Helpers ────────────────────────────────────────────────────────────────
def flatten_transcript(transcript_jsonb):
    if not transcript_jsonb:
        return ""
    lines = []
    for b in transcript_jsonb.get('batches', []):
        for s in b.get('batch', []):
            speaker = s.get('speaker_name', 'Unknown')
            text    = s.get('sentence_body', '')
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)

def extract_prospect_info(participants_names):
    if not participants_names:
        return [], []
    prospects = []; gushworkers = []
    for part in participants_names.split(','):
        part = part.strip()
        if not part: continue
        title_match = re.search(r'\(([^)]+)\)', part)
        domain_or_title = title_match.group(1) if title_match else ''
        if 'gushwork.ai' in part.lower() or 'fireflies' in part.lower():
            gushworkers.append(part)
        else:
            prospects.append({
                'name':  part.split('(')[0].split('|')[0].strip(),
                'raw':   part,
                'title': domain_or_title if not re.match(r'^[\w.-]+\.[a-z]{2,}$', domain_or_title) else ''
            })
    return prospects, gushworkers

def classify_industry(source, ae_email=''):
    src = (source or '').lower()
    if 'allaine' in src: return 'IT & Consulting'
    return 'Manufacturing'  # truck can be added later via campaign ID lookup

# ── 5. Build Claude prompt ────────────────────────────────────────────────────
def build_prompt(company, meta, meetings):
    sections = []
    for i, m in enumerate(meetings):
        transcript_text = flatten_transcript(m.get('transcript'))
        prospects, gushworkers = extract_prospect_info(m.get('participants_names', ''))
        sections.append(f"""
--- Meeting {i+1}: {m['meeting_title']} ---
Date: {m['demo_scheduled_date']}
Duration: {round((m.get('duration_seconds') or 0) / 60)} minutes
AE: {m['ae_name']}
Gushwork team: {', '.join(gushworkers)}
Prospect participants: {json.dumps(prospects)}
Sybill recording: {m.get('sybill_url', 'N/A')}

TRANSCRIPT:
{transcript_text}
""")

    industry = classify_industry(meta.get('source', ''))

    return f"""You are a senior sales intelligence analyst. Analyze this demo call transcript for a B2B SaaS sales deal.

PROSPECT:
- Name: {meta.get('prospect_first_name', 'Unknown')}
- Email: {meta.get('prospect_email')}
- Company: {company}
- Website: {meta.get('prospect_website', 'N/A')}
- Industry: {industry}
- Total meetings: {len(meetings)}

{''.join(sections)}

Return ONLY valid JSON (no markdown, no explanation). All descriptive string fields MUST be arrays of bullet strings, each ≤ 12 words, easy to read at a glance.

{{
  "company": "{company}",
  "prospect_name": "full name from transcript",
  "prospect_designation": "job title from transcript or participants list",
  "is_decision_maker": true/false,
  "decision_maker_reasoning": "one short sentence why or why not",

  "company_industry": "specific sub-industry (e.g. Manufacturing / Industrial Machinery)",

  "pain_points": [
    {{
      "pain_point": "short pain point label",
      "severity": "high/medium/low",
      "direct_quote": "exact quote or empty string",
      "addressed_in_call": true/false,
      "how_addressed": "brief note or empty string"
    }}
  ],

  "key_objections": [
    {{
      "objection": "short objection label",
      "how_handled": "brief note",
      "resolved": true/false
    }}
  ],

  "buying_signals": ["bullet ≤12 words", "..."],
  "negative_signals": ["bullet ≤12 words", "..."],

  "next_steps_discussed": true/false,
  "next_steps_details": ["bullet ≤12 words", "..."],
  "next_call_date": "specific date/time or null",
  "follow_up_materials_promised": ["bullet ≤12 words", "..."],

  "deal_closing_intent_score": 1,
  "deal_closing_intent_label": "Hot/Warm/Cold/Dead",
  "intent_reasoning": ["bullet ≤12 words", "..."],

  "call_quality_score": 1,
  "call_quality_notes": ["bullet ≤12 words", "..."],

  "key_insights": ["bullet ≤12 words", "..."],
  "recommended_next_action": "one specific action for sales team",

  "pain_points_addressed_by_ae": true/false,
  "pain_points_addressed_details": ["bullet ≤12 words for each addressed pain point", "..."]
}}"""

# ── 6. Analyze one company ────────────────────────────────────────────────────
def analyze_company(company, meetings):
    meta   = meetings[0]
    prompt = build_prompt(company, meta, meetings)

    for attempt in range(3):
        try:
            msg = CLIENT.messages.create(
                model='claude-sonnet-4-6',
                max_tokens=4096,
                messages=[{'role': 'user', 'content': prompt}]
            )
            raw   = msg.content[0].text.strip()
            start = raw.index('{')
            end   = raw.rindex('}') + 1
            result = json.loads(raw[start:end])

            # Ensure array fields are always lists
            for field in ['buying_signals', 'negative_signals', 'next_steps_details',
                          'follow_up_materials_promised', 'intent_reasoning',
                          'call_quality_notes', 'key_insights', 'pain_points_addressed_details']:
                if isinstance(result.get(field), str):
                    result[field] = [result[field]] if result[field] else []
                elif result.get(field) is None:
                    result[field] = []

            result['_meta'] = {
                'prospect_email':     meta['prospect_email'],
                'prospect_company':   company,
                'prospect_website':   meta.get('prospect_website'),
                'demo_date':          str(meta['demo_scheduled_date']),
                'ae_name':            meta['ae_name'],
                'industry':           classify_industry(meta.get('source', '')),
                'meeting_ids':        [m['meeting_id'] for m in meetings],
                'sybill_urls':        [m.get('sybill_url') for m in meetings],
                'total_duration_min': round(sum((m.get('duration_seconds') or 0) for m in meetings) / 60),
                'analyzed_at':        datetime.utcnow().isoformat() + 'Z',
            }
            return company, result

        except Exception as e:
            if attempt == 2:
                return company, {
                    'error': str(e), 'company': company,
                    '_meta': {'prospect_email': meta['prospect_email'],
                              'analyzed_at': datetime.utcnow().isoformat() + 'Z'}
                }
            time.sleep(2 ** attempt)

# ── 7. Run analysis in parallel ───────────────────────────────────────────────
if to_analyze:
    print(f"\nAnalyzing {len(to_analyze)} companies with claude-sonnet-4-6 ({WORKERS} workers)...")
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(analyze_company, co, mtgs): co
                   for co, mtgs in to_analyze.items()}
        for fut in as_completed(futures):
            company, result = fut.result()
            existing[company] = result
            done += 1
            score  = result.get('deal_closing_intent_score', '?')
            label  = result.get('deal_closing_intent_label', '?')
            err    = ' ERROR' if 'error' in result else ''
            print(f"  [{done}/{len(to_analyze)}] {company:45} → {label} ({score}/10){err}", flush=True)
else:
    print("No new companies to analyze.")

# ── 8. Save ───────────────────────────────────────────────────────────────────
with open(OUT_FILE, 'w') as f:
    json.dump(existing, f, indent=2, default=str)
print(f"\n✓ Saved {len(existing)} records → {OUT_FILE}")

# ── 9. Summary ────────────────────────────────────────────────────────────────
label_counts = {'Hot': 0, 'Warm': 0, 'Cold': 0, 'Dead': 0}
errors = 0
for rec in existing.values():
    if 'error' in rec:
        errors += 1
    else:
        lbl = rec.get('deal_closing_intent_label', '')
        if lbl in label_counts: label_counts[lbl] += 1

print(f"\nDeal Intent Breakdown ({len(existing)} total, {errors} errors):")
for lbl, ct in label_counts.items():
    print(f"  {lbl:6}: {ct}")

top = sorted(
    [r for r in existing.values() if 'error' not in r],
    key=lambda x: x.get('deal_closing_intent_score', 0), reverse=True
)[:5]
if top:
    print(f"\nTop 5 by Intent Score:")
    for r in top:
        m    = r.get('_meta', {})
        sc   = r.get('deal_closing_intent_score', '?')
        lbl  = r.get('deal_closing_intent_label', '?')
        dm   = r.get('is_decision_maker', '?')
        name = r.get('company', m.get('prospect_company', '?'))
        print(f"  [{sc}/10] {name:45} {lbl}  DM={dm}")
