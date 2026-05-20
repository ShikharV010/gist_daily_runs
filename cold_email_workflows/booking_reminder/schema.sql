-- gist.gtm_booking_reminders_sent
-- Audit log + idempotency table for the booking reminder workflow.
-- Every row = one reminder email we either sent or attempted to send.
--
-- Run once (or re-run safely — every statement is idempotent).
-- Live deploys: the Python script also calls ensure_tracking_table() which
-- runs the CREATE TABLE IF NOT EXISTS portion.

CREATE TABLE IF NOT EXISTS gist.gtm_booking_reminders_sent (
    -- ─── Identity / idempotency ─────────────────────────────────────────
    event_id            TEXT NOT NULL,             -- cal.com booking event_id
    reminder_type       TEXT NOT NULL,             -- '2h_before' (future: '24h_before', '1h_before', etc.)
    PRIMARY KEY (event_id, reminder_type)
);

-- ─── Add the rich columns (idempotent — safe to re-run) ────────────────
ALTER TABLE gist.gtm_booking_reminders_sent
    ADD COLUMN IF NOT EXISTS prospect_email          TEXT,
    ADD COLUMN IF NOT EXISTS prospect_first_name     TEXT,
    ADD COLUMN IF NOT EXISTS prospect_company        TEXT,

    -- When the meeting actually starts (UTC + the prospect's TZ)
    ADD COLUMN IF NOT EXISTS meeting_start_utc       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS meeting_time_zone       TEXT,         -- e.g. 'America/New_York'
    ADD COLUMN IF NOT EXISTS meeting_local_time_str  TEXT,         -- e.g. '1:30 PM EDT' (exactly what we wrote in the email)

    -- Source attribution (which cold email campaign triggered the demo)
    ADD COLUMN IF NOT EXISTS source                  TEXT,         -- 'Gushwork Email', 'Gushwork Email(Allaine)', etc.
    ADD COLUMN IF NOT EXISTS ae_name                 TEXT,
    ADD COLUMN IF NOT EXISTS ae_email                TEXT,

    -- The gushwork mailbox engaged on the thread (Anna / Alison / Grace / ...)
    ADD COLUMN IF NOT EXISTS sender_email_id         BIGINT,
    ADD COLUMN IF NOT EXISTS sender_first_name       TEXT,         -- 'Anna' — used as the email signature
    ADD COLUMN IF NOT EXISTS sender_email_address    TEXT,         -- 'anna@gushworkclickai.com'

    -- Sequencer references
    ADD COLUMN IF NOT EXISTS sequencer_lead_id       BIGINT,
    ADD COLUMN IF NOT EXISTS sequencer_reply_id      BIGINT,       -- the thread we replied into
    ADD COLUMN IF NOT EXISTS sequencer_lead_url      TEXT,         -- https://sequencer.gushwork.ai/leads/<id>
    ADD COLUMN IF NOT EXISTS sequencer_reply_url     TEXT,         -- https://sequencer.gushwork.ai/replies/<id>

    -- The cal.com invite link we included in the reminder body
    ADD COLUMN IF NOT EXISTS cal_invite_url          TEXT,         -- https://cal.com/booking/<event_id>

    -- The reminder email itself (for full audit + replay if needed)
    ADD COLUMN IF NOT EXISTS email_subject           TEXT,
    ADD COLUMN IF NOT EXISTS email_body_html         TEXT,

    -- When we actually fired the POST + what came back
    ADD COLUMN IF NOT EXISTS sent_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS response_status         INT,
    ADD COLUMN IF NOT EXISTS response_body           TEXT,

    -- Did Sequencer accept the send (HTTP 200/201/202)?
    ADD COLUMN IF NOT EXISTS success                 BOOLEAN;

-- ─── Useful indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_booking_reminders_sent_at
    ON gist.gtm_booking_reminders_sent (sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_reminders_meeting_start
    ON gist.gtm_booking_reminders_sent (meeting_start_utc DESC);

CREATE INDEX IF NOT EXISTS idx_booking_reminders_prospect_email
    ON gist.gtm_booking_reminders_sent (prospect_email);

CREATE INDEX IF NOT EXISTS idx_booking_reminders_success
    ON gist.gtm_booking_reminders_sent (success);
