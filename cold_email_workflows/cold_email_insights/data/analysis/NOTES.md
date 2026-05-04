# Detailed Cold Email Analysis — March + April 2026

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
