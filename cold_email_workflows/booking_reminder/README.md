# Booking Reminder

Sends a 2-hour-before-call reminder to every prospect with an upcoming Gushwork-Email-sourced demo.

## What it does

Every 30 min (GitHub Actions cron):
1. Query `gist.gtm_inbound_demo_bookings` for calls starting in **1h30m–2h30m** with `source ILIKE '%gushwork email%'`, `is_latest=true`, valid show_status.
2. Skip anything already reminded (tracked in `gist.gtm_booking_reminders_sent`).
3. For each booking:
   - Find the lead in Sequencer (by `prospect_email`)
   - Find their most-recent reply (the thread we'll reply into)
   - POST the reminder via `/api/replies/{reply_id}/reply` (in-thread, replies to existing conversation)
4. Log the send to `gist.gtm_booking_reminders_sent` so we never double-send.

## Email body

```
Hey {FIRST_NAME},

Just a quick reminder, we have the call scheduled today for 2:00 PM EST.

Calendar link: https://cal.com/booking/{event_id}

Talk soon!
{SENDER_FIRST_NAME}
```

Time is localized to the attendee's timezone with the right abbreviation (EST/CST/MST/PST/IST/etc).

## Local test

```bash
# from this folder
pip install -r requirements.txt
python send_reminders.py --dry-run                  # prints what would be sent
python send_reminders.py --window-h 2 --tolerance-min 30   # actual run
```

Required env (loads from `/Users/.../projects/.env` automatically in local dev):
- `DATABASE_URL`
- `SEQUENCER_API_KEY`

## Deploy

1. Copy `send_reminders.py` + `requirements.txt` →
   `~/GitHub - Clone/gist_daily_runs/cold_email_workflows/booking_reminder/`
2. Copy `booking_reminder.yml` →
   `~/GitHub - Clone/gist_daily_runs/.github/workflows/booking_reminder.yml`
3. In GitHub repo settings, add secrets:
   - `GW_PROD_DATABASE_URL`
   - `SEQUENCER_API_KEY`
4. Commit + push.
5. First run: trigger manually via "Run workflow" with `dry_run=true` to confirm zero errors.
6. Then let cron take over.

## Idempotency

The tracking table is **auto-created on first run** if missing:

```sql
CREATE TABLE gist.gtm_booking_reminders_sent (
    event_id        TEXT NOT NULL,
    reminder_type   TEXT NOT NULL,      -- '2h_before'
    prospect_email  TEXT,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sequencer_reply_id BIGINT,
    response_status INT,
    response_body   TEXT,
    PRIMARY KEY (event_id, reminder_type)
);
```

Even if cron fires twice (or you re-trigger), the same booking will never get two reminders.

## Edge cases handled

- **Lead not in Sequencer** → skip, log (the booking may have come from a different channel that bypassed Sequencer)
- **No prior reply thread** → skip (can't reply in-thread if there's no thread). These are rare — booked-but-never-replied prospects. Logged as `skipped_no_thread`.
- **show_status N / C / Cancelled** → excluded by SQL
- **Timezone abbreviation** — handles DST automatically (EST vs EDT, GMT vs BST)
- **GH Actions cron drift** — ±30 min tolerance covers it
- **`event_id` collision** — every cal.com booking has a unique event_id; primary key on (event_id, reminder_type) prevents dup sends

## To extend

- Add `1h_before` or `24h_before` reminders → call with `--window-h 1` and add a new `reminder_type` value
- Make body configurable via a `prompts/` folder like alfred-the-buttler does
- Add Slack webhook on failure → post to a #cold-email-ops channel
