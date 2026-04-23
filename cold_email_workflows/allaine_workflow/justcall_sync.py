"""
JustCall SalesDialer sync for Allaine workflow.
Handles: phone enrichment (LeadMagic → FullEnrich), push new contacts,
remove contacts whose lead matched a demo booking.
"""
import os
import csv
import json
import time
import logging
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, as_completed

import re
import requests

log = logging.getLogger(__name__)


def _digits_only(phone):
    """JustCall requires phone_number to be a digits-only string."""
    return re.sub(r'\D', '', str(phone or ''))

# ── Config ─────────────────────────────────────────────────────────────────────
JC_BASE      = 'https://api.justcall.io/v2.1'
JC_AUTH      = os.getenv('JUSTCALL_AUTHENTICATION')  # already 'Bearer key:secret'
JC_CAMPAIGN  = 3212549

LM_URL       = 'https://api.leadmagic.io/phone-finder'
LM_KEY       = os.getenv('LEADMAGIC_API_KEY')

FE_BASE      = 'https://app.fullenrich.com/api/v1'
FE_KEY       = os.getenv('FULLENRICH_API_KEY')

# Custom field key IDs (from campaign 3212549 inspection)
CF_LINKEDIN  = 1136513
CF_COMPANY   = 1136514
CF_WEBSITE   = 1139671
CF_INFO      = 1176311
CF_INDUSTRY  = 1227957

PROJ_DIR     = os.path.dirname(__file__)
PHONE_CACHE  = os.path.join(PROJ_DIR, 'enriched_phones.csv')
NO_PHONE_CSV = os.path.join(PROJ_DIR, 'leads_without_phone.csv')

DRY_RUN      = os.getenv('ALLAINE_DRY_RUN', '').lower() in ('1', 'true', 'yes')

NO_PHONE_HEADERS = ['date_utc', 'lead_id', 'name', 'email', 'linkedin_url',
                    'company', 'leadmagic_tried', 'fullenrich_tried', 'fullenrich_status']

# Polling FullEnrich inside the run: up to ~90s. Longer waits would overrun cron.
FE_POLL_SECONDS = 180
FE_POLL_INTERVAL = 5


def _jc_headers():
    return {'Authorization': JC_AUTH, 'Content-Type': 'application/json'}


# ── Phone cache (CSV: linkedin_url, phone, source) ───────────────────────────
# `phone` column may be empty string = "tried, not found" so we don't retry.
_phone_cache = None
_cache_lock  = Lock()


def _load_phone_cache():
    global _phone_cache
    if _phone_cache is not None:
        return _phone_cache
    cache = {}
    if os.path.exists(PHONE_CACHE):
        with open(PHONE_CACHE, newline='') as f:
            for row in csv.DictReader(f):
                url = (row.get('linkedin_url') or '').strip().lower()
                if url:
                    cache[url] = {'phone': row.get('phone') or '',
                                  'source': row.get('source') or ''}
    _phone_cache = cache
    log.info(f"  Phone cache loaded: {len(cache)} entries")
    return cache


def _save_phone_cache_entry(linkedin_url, phone, source):
    url = (linkedin_url or '').strip().lower()
    if not url: return
    with _cache_lock:
        cache = _load_phone_cache()
        cache[url] = {'phone': phone or '', 'source': source}
        new_file = not os.path.exists(PHONE_CACHE)
        with open(PHONE_CACHE, 'a', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['linkedin_url', 'phone', 'source'])
            if new_file: w.writeheader()
            w.writerow({'linkedin_url': url, 'phone': phone or '', 'source': source})


# ── Enrichment ────────────────────────────────────────────────────────────────
def _leadmagic_phone(linkedin_url):
    """Synchronous. Returns phone string or None."""
    try:
        r = requests.post(LM_URL,
                          headers={'X-API-Key': LM_KEY, 'Content-Type': 'application/json'},
                          json={'profile_url': linkedin_url}, timeout=20)
        if r.status_code != 200:
            log.warning(f"    LeadMagic {r.status_code}: {r.text[:120]}")
            return None
        d = r.json()
        return d.get('mobile_number') or None
    except Exception as e:
        log.warning(f"    LeadMagic error: {e}")
        return None


def _fullenrich_phones(leads):
    """
    Bulk-enrich a list of leads via FullEnrich, poll until done or timeout.
    leads: list of dicts with first_name, last_name, linkedin_url, lead_id.
    Returns dict {lead_id: phone_or_None}.
    """
    if not leads: return {}
    payload = {
        'name': f'allaine_cron_{int(time.time())}',
        'datas': [{
            'firstname':    l.get('first_name', ''),
            'lastname':     l.get('last_name', ''),
            'linkedin_url': l.get('linkedin_url', ''),
            'custom':       {'lead_id': str(l.get('lead_id', ''))},
            'enrich_fields': ['contact.phones'],
        } for l in leads]
    }
    try:
        r = requests.post(f'{FE_BASE}/contact/enrich/bulk',
                          headers={'Authorization': f'Bearer {FE_KEY}',
                                   'Content-Type': 'application/json'},
                          json=payload, timeout=30)
        if r.status_code != 200:
            log.warning(f"    FullEnrich submit {r.status_code}: {r.text[:200]}")
            return {}
        eid = r.json().get('enrichment_id')
        if not eid:
            return {}
    except Exception as e:
        log.warning(f"    FullEnrich submit error: {e}")
        return {}

    # Poll
    log.info(f"    FullEnrich submitted: {eid} ({len(leads)} leads)")
    deadline = time.time() + FE_POLL_SECONDS
    while time.time() < deadline:
        time.sleep(FE_POLL_INTERVAL)
        try:
            pr = requests.get(f'{FE_BASE}/contact/enrich/bulk/{eid}',
                              headers={'Authorization': f'Bearer {FE_KEY}'}, timeout=20)
            if pr.status_code != 200: continue
            pd = pr.json()
            if pd.get('status') == 'COMPLETED':
                out = {}
                for item in pd.get('datas', []):
                    lid = (item.get('custom') or {}).get('lead_id')
                    phones = item.get('contact', {}).get('phones') or []
                    if phones:
                        ph = phones[0]
                        phone = ph.get('number') or ph.get('e164') or ph.get('phone')
                        out[int(lid)] = phone if phone else None
                    else:
                        out[int(lid)] = None
                log.info(f"    FullEnrich completed: {sum(1 for p in out.values() if p)}/{len(out)} found")
                return out
        except Exception:
            pass
    log.warning(f"    FullEnrich timed out after {FE_POLL_SECONDS}s; skipping this batch")
    return {}  # empty = timed out; next run will retry via pending queue


def enrich_phones(leads):
    """
    leads: list of dicts {lead_id, first_name, last_name, linkedin_url, email, name, company}.
    Returns dict {lead_id: phone_or_empty_string}.
    Uses cache → LeadMagic (sync) → FullEnrich (async) order.
    Side effects: updates cache; appends failures to NO_PHONE_CSV.
    DRY_RUN: skip API calls, return cached values only; uncached → empty.
    """
    cache = _load_phone_cache()
    results = {}
    need_fe = []

    for lead in leads:
        url = (lead.get('linkedin_url') or '').strip().lower()
        if url and url in cache:
            # Cached timeouts are transient — don't trust them, retry enrichment.
            if cache[url].get('source') == 'fullenrich_timeout':
                pass
            else:
                results[lead['lead_id']] = cache[url]['phone'] or ''
                continue
        if not url:
            results[lead['lead_id']] = ''
            continue
        if DRY_RUN:
            log.info(f"    [DRY] would enrich {lead.get('linkedin_url')} via LeadMagic→FullEnrich")
            results[lead['lead_id']] = ''  # treat as "would need enrichment"
            continue
        phone = _leadmagic_phone(lead['linkedin_url'])
        if phone:
            _save_phone_cache_entry(url, phone, 'leadmagic')
            results[lead['lead_id']] = phone
        else:
            need_fe.append(lead)

    if need_fe:
        log.info(f"  FullEnrich fallback for {len(need_fe)} leads...")
        fe_results = _fullenrich_phones(need_fe)
        for lead in need_fe:
            lid = lead['lead_id']
            url = (lead.get('linkedin_url') or '').strip().lower()
            phone = fe_results.get(lid)
            if phone:
                _save_phone_cache_entry(url, phone, 'fullenrich')
                results[lid] = phone
            elif lid in fe_results:
                # FullEnrich explicitly returned no phone → cache as permanent no-phone
                _save_phone_cache_entry(url, '', 'fullenrich_none')
                results[lid] = ''
                _append_no_phone(lead, fe_status='none')
            else:
                # Timed out — don't cache, let next run retry
                results[lid] = ''

    return results


def _append_no_phone(lead, fe_status):
    from datetime import datetime, timezone
    new_file = not os.path.exists(NO_PHONE_CSV)
    with open(NO_PHONE_CSV, 'a', newline='') as f:
        w = csv.DictWriter(f, fieldnames=NO_PHONE_HEADERS)
        if new_file: w.writeheader()
        w.writerow({
            'date_utc':         datetime.now(timezone.utc).isoformat(),
            'lead_id':          lead.get('lead_id', ''),
            'name':             lead.get('name', ''),
            'email':            lead.get('email', ''),
            'linkedin_url':     lead.get('linkedin_url', ''),
            'company':          lead.get('company', ''),
            'leadmagic_tried':  'yes',
            'fullenrich_tried': 'yes',
            'fullenrich_status': fe_status,
        })


# ── JustCall API ──────────────────────────────────────────────────────────────
def get_campaign_contacts():
    """Return list of contacts currently in JC campaign (full records)."""
    contacts, page = [], 0
    while True:
        r = requests.get(f'{JC_BASE}/sales_dialer/campaigns/contacts',
                         headers=_jc_headers(),
                         params={'campaign_id': JC_CAMPAIGN, 'per_page': 50, 'page': page},
                         timeout=30)
        if r.status_code != 200:
            log.warning(f"    JC list {r.status_code}: {r.text[:200]}")
            break
        d = r.json()
        batch = d.get('data', [])
        contacts += batch
        if not d.get('next_page_link'): break
        page += 1
        if page > 200:  # safety
            break
    return contacts


def post_contact(lead, phone, reply_uuid):
    """
    Push a single contact to JC. `lead` is a dict with expected fields.
    Returns contact_id or None.
    """
    name = (lead.get('full_name') or f"{lead.get('first_name','')} {lead.get('last_name','')}".strip()
            or lead.get('email') or 'Unknown')
    info_url = f'https://sequencer.gushwork.ai/inbox/replies/{reply_uuid}' if reply_uuid else ''
    body = {
        'campaign_id': JC_CAMPAIGN,
        'name':        name,
        'phone_number': _digits_only(phone),
        'email':        lead.get('email', '') or '',
        'occupation':   lead.get('title', '') or '',
        'custom_fields': [
            {'id': str(CF_INFO),     'value': info_url},
            {'id': str(CF_COMPANY),  'value': lead.get('company', '') or ''},
            {'id': str(CF_LINKEDIN), 'value': lead.get('linkedin_url', '') or ''},
            {'id': str(CF_WEBSITE),  'value': lead.get('website_url', '') or ''},
            {'id': str(CF_INDUSTRY), 'value': lead.get('industry_sub_category', '') or ''},
        ],
    }
    if DRY_RUN:
        log.info(f"    [DRY] POST /sales_dialer/campaigns/contact: name={name!r} email={body['email']!r} phone={phone!r}")
        return -1
    for attempt in range(3):
        try:
            r = requests.post(f'{JC_BASE}/sales_dialer/campaigns/contact',
                              headers=_jc_headers(), json=body, timeout=20)
            if r.status_code in (200, 201):
                d = r.json().get('data', {})
                return d.get('id') or d.get('contact_id')
            if r.status_code == 429:
                time.sleep(2 ** attempt); continue
            log.warning(f"    JC add {r.status_code}: {r.text[:200]}")
            return None
        except Exception as e:
            if attempt == 2: log.warning(f"    JC add err: {e}")
            else: time.sleep(2 ** attempt)
    return None


def delete_contact(contact_id):
    """
    Remove a single contact from the JC campaign. Returns True on success.
    JustCall quirk: both ids as query params + non-empty body '{}'.
    """
    try:
        r = requests.delete(f'{JC_BASE}/sales_dialer/campaigns/contact',
                            headers=_jc_headers(),
                            params={'campaign_id': JC_CAMPAIGN, 'contact_id': contact_id},
                            data='{}', timeout=20)
        if r.status_code in (200, 204):
            return True
        log.warning(f"    JC del {contact_id} {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.warning(f"    JC del {contact_id} err: {e}")
    return False
