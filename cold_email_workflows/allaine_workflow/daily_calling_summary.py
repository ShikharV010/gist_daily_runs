"""
Daily Allaine calling summary — fires once at 6 AM IST.

Reports calls placed between 5 PM IST (previous day) and 6 AM IST (today).
The summary is attributed to the previous day (e.g. a 6 AM IST run on
2026-04-28 reports the effort of 27th April).

Two sections:
  1. New Leads — campaign 3212549 (Allaine - Cold Email)
  2. No Shows  — campaign 3218289 (Allaine - No Show Leads)

Per section: total calls, unique contacts, re-attempts, demos booked
(disposition exact match: "Qualified : DM : Meeting Booked").
"""
import os
import sys
import time
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

# Portable env loader: master local → project parent → project local.
# In CI / GitHub Actions, env vars come from secrets (load_dotenv no-ops).
load_dotenv('/Users/shikhar.vermagushwork.ai/Documents/claude/projects/.env')
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

JC_BASE       = 'https://api.justcall.io/v2.1'
JC_AUTH       = os.getenv('JUSTCALL_AUTHENTICATION')
SLACK_TOKEN   = os.getenv('SLACK_BOT_TOKEN')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL_ID', 'C0ARFBBN3TN')

CAMP_COLD     = 3212549
CAMP_NO_SHOW  = 3218289
DEMO_DISPO    = 'Qualified : DM : Meeting Booked'

IST_OFFSET    = timedelta(hours=5, minutes=30)


def ordinal(n):
    if 11 <= n <= 13: return f"{n}th"
    return f"{n}{ {1:'st', 2:'nd', 3:'rd'}.get(n % 10, 'th') }"


def fetch_calls(campaign_id, from_param, to_param):
    """Paginate all calls in the window. Wider window OK — we filter precisely later."""
    calls = []
    page = 0
    while True:
        ok = False
        for attempt in range(3):
            try:
                r = requests.get(f'{JC_BASE}/sales_dialer/calls',
                                 headers={'Authorization': JC_AUTH},
                                 params={'campaign_id': campaign_id,
                                         'from_datetime': from_param,
                                         'to_datetime':   to_param,
                                         'per_page': 100,
                                         'page': page,
                                         'sort': 'id', 'order': 'desc'},
                                 timeout=60)
                if r.status_code == 200:
                    ok = True; break
                if r.status_code == 429:
                    time.sleep(5 * (attempt + 1)); continue
                print(f'  WARN camp={campaign_id} page={page} status={r.status_code}: {r.text[:200]}')
                return calls
            except Exception as e:
                if attempt == 2:
                    print(f'  ERROR camp={campaign_id} page={page}: {e}')
                    return calls
                time.sleep(2 ** attempt)
        if not ok: return calls
        d = r.json()
        batch = d.get('data', [])
        calls += batch
        if not d.get('next_page_link'): break
        page += 1
        time.sleep(0.3)
    return calls


def filter_to_window(calls, window_start_utc, window_end_utc):
    """Use call_date + call_time (UTC) to narrow precisely to the IST window."""
    out = []
    for c in calls:
        cd = c.get('call_date', '')
        ct = c.get('call_time', '00:00:00')
        try:
            dt = datetime.strptime(f"{cd} {ct}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if window_start_utc <= dt < window_end_utc:
            out.append(c)
    return out


def aggregate(calls):
    total      = len(calls)
    unique     = len({c.get('contact_id') for c in calls if c.get('contact_id')})
    reattempts = total - unique
    demos      = sum(1 for c in calls if (c.get('call_info') or {}).get('disposition') == DEMO_DISPO)
    return {'total': total, 'unique': unique, 'reattempts': reattempts, 'demos': demos}


def post_slack(date_label, cold, no_show):
    if not SLACK_TOKEN:
        print('SLACK_BOT_TOKEN not set — skipping')
        return False
    blocks = [
        {"type": "header", "text": {"type": "plain_text",
            "text": f"📞 {date_label}, Calling Summary"}},
        {"type": "section", "text": {"type": "mrkdwn",
            "text": "*New Leads — Cold Email (camp 3212549)*"}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Total leads called*\n{cold['total']}"},
            {"type": "mrkdwn", "text": f"*Unique leads called*\n{cold['unique']}"},
            {"type": "mrkdwn", "text": f"*Re-attempts made*\n{cold['reattempts']}"},
            {"type": "mrkdwn", "text": f"*Demos booked*\n{cold['demos']}"},
        ]},
        {"type": "divider"},
        {"type": "section", "text": {"type": "mrkdwn",
            "text": "*No Shows (camp 3218289)*"}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Total no-shows called*\n{no_show['total']}"},
            {"type": "mrkdwn", "text": f"*Unique no-show leads*\n{no_show['unique']}"},
            {"type": "mrkdwn", "text": f"*Re-attempts*\n{no_show['reattempts']}"},
            {"type": "mrkdwn", "text": f"*Demos re-booked*\n{no_show['demos']}"},
        ]},
    ]
    r = requests.post('https://slack.com/api/chat.postMessage',
                      headers={'Authorization': f'Bearer {SLACK_TOKEN}',
                               'Content-Type': 'application/json'},
                      json={'channel': SLACK_CHANNEL, 'blocks': blocks, 'unfurl_links': False},
                      timeout=15)
    res = r.json()
    if not res.get('ok'):
        print(f'Slack error: {res}')
    return res.get('ok', False)


def main():
    if not JC_AUTH:
        print('JUSTCALL_AUTHENTICATION missing — aborting'); sys.exit(1)

    now_utc       = datetime.now(timezone.utc)
    now_ist       = now_utc + IST_OFFSET
    today_ist     = now_ist.date()
    yesterday_ist = today_ist - timedelta(days=1)

    # Precise UTC window: 5 PM IST yesterday → 6 AM IST today
    window_start_ist = datetime(yesterday_ist.year, yesterday_ist.month, yesterday_ist.day, 17, 0, 0)
    window_end_ist   = datetime(today_ist.year, today_ist.month, today_ist.day, 6, 0, 0)
    window_start_utc = (window_start_ist - IST_OFFSET).replace(tzinfo=timezone.utc)
    window_end_utc   = (window_end_ist   - IST_OFFSET).replace(tzinfo=timezone.utc)

    # API range — generous on the start, capped to "now" since JustCall rejects
    # future to_datetime values. Python filter narrows precisely afterwards.
    from_param = (yesterday_ist - timedelta(days=1)).strftime('%Y-%m-%d')
    to_param   = now_ist.strftime('%Y-%m-%d %H:%M:%S')

    date_label = f"{ordinal(yesterday_ist.day)} {yesterday_ist.strftime('%B %Y')}"

    print(f'Window UTC: {window_start_utc} → {window_end_utc}')
    print(f'API range:  {from_param} → {to_param}')
    print(f'Date label: {date_label}')

    print('\nFetching Cold Email calls (camp 3212549)...')
    cold_calls = fetch_calls(CAMP_COLD, from_param, to_param)
    print(f'  Raw: {len(cold_calls)} calls in API range')
    cold_calls = filter_to_window(cold_calls, window_start_utc, window_end_utc)
    print(f'  In IST window: {len(cold_calls)}')
    cold_stats = aggregate(cold_calls)
    print(f'  Stats: {cold_stats}')

    print('\nFetching No Show calls (camp 3218289)...')
    no_show_calls = fetch_calls(CAMP_NO_SHOW, from_param, to_param)
    print(f'  Raw: {len(no_show_calls)} calls in API range')
    no_show_calls = filter_to_window(no_show_calls, window_start_utc, window_end_utc)
    print(f'  In IST window: {len(no_show_calls)}')
    no_show_stats = aggregate(no_show_calls)
    print(f'  Stats: {no_show_stats}')

    print('\nPosting to Slack...')
    ok = post_slack(date_label, cold_stats, no_show_stats)
    print(f'Slack posted: {ok}')


if __name__ == '__main__':
    main()
