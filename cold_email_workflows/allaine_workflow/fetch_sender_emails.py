#!/usr/bin/env python3
"""
Fetch all connected sender emails from the Sequencer and save to sender_emails.csv.
Run once manually, then auto-refreshed by allaine_cron.py if file is >24hrs old.
"""

import os
import csv
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv('/Users/shikhar.vermagushwork.ai/Documents/claude/projects/.env')
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

BASE    = os.getenv('SEQUENCER_BASE_URL', 'https://sequencer.gushwork.ai/api')
TOKEN   = os.getenv('SEQUENCER_API_KEY')
HEADERS = {'Authorization': f'Bearer {TOKEN}'}
OUT     = os.path.join(os.path.dirname(__file__), 'sender_emails.csv')


def fetch_page(page):
    r = requests.get(f"{BASE}/sender-emails", headers=HEADERS,
                     params={'per_page': 100, 'page': page}, timeout=20)
    r.raise_for_status()
    return r.json().get('data', [])


def main():
    first = requests.get(f"{BASE}/sender-emails", headers=HEADERS,
                         params={'per_page': 100, 'page': 1}, timeout=20).json()
    last_page = first['meta']['last_page']
    all_senders = list(first['data'])

    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = {ex.submit(fetch_page, p): p for p in range(2, last_page + 1)}
        for fut in as_completed(futures):
            all_senders.extend(fut.result())

    connected = [s for s in all_senders if s.get('status') == 'Connected']

    with open(OUT, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['id', 'email', 'name', 'type', 'daily_limit'])
        for s in connected:
            writer.writerow([s['id'], s['email'], s['name'], s['type'], s['daily_limit']])

    print(f"Saved {len(connected)} sender emails to {OUT}")


if __name__ == '__main__':
    main()
