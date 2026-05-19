# In Cold Email Platform

Two-tab ops dashboard:

1. **5 min Dialing** — every positive (`LEAD_INTERESTED`) reply from Sequencer fires a webhook here; we enrich phone (from EmailBison custom_variables, fallback LeadMagic) and append a row. Interns hit **Call** to open JustCall with the number pre-filled. A JustCall webhook fires on call completion → we record `call_at` and tick "Call < 5 min" if it happened within 5 minutes of the reply. A 15-min cron drops any row whose lead has since booked a demo.
2. **Appointment Reminders** — rebuilt daily at 6 PM IST from `gist.gtm_inbound_demo_bookings` (today's IST demos, source ∈ {`Gushwork Email`, `Gushwork Email(Allaine)`, `Emails from Gushwork`}). Each row has Call (JustCall), SMS (JustCall), and Email (EmailBison/Sequencer) buttons.

Stack: Next.js 16 (App Router) + Tailwind v4 + Radix Tabs · Postgres (`pg`) · Vercel Cron · deployed on Vercel.

## Setup

### 1. Storage

Single table: **`gist.gtm_unified_db_source`** (already created). Tab 1 rows have `row_type='dialer'`, Tab 2 rows have `row_type='reminder'`.

### 2. Env

Copy `.env.example` → `.env.local` and fill in. All keys also live in the shared `projects/.env`.

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | gist Postgres |
| `SEQUENCER_BASE_URL` | usually `https://sequencer.gushwork.ai/api`; used to build inbox links |
| `SEQUENCER_WEBHOOK_SECRET` | optional HMAC for `/api/webhooks/sequencer` |
| `JUSTCALL_AUTHENTICATION` | `Bearer key:secret` |
| `JUSTCALL_WEBHOOK_SECRET` | optional HMAC for `/api/webhooks/justcall` |
| `LEADMAGIC_API_KEY` | phone enrichment |
| `FULLENRICH_API_KEY` | phone enrichment (fallback, currently unused inline) |
| `EMAILBISON_API_KEY` | manual-email sends from Tab 2 |
| `EMAILBISON_INSTANCE_URL` | usually `https://sequencer.gushwork.ai` |
| `EMAILBISON_DEFAULT_SENDER_ID` | which connected sender to use for reminder emails |
| `CRON_SECRET` | Vercel injects automatically; the cron routes verify it |

### 3. Run locally


```bash
npm install
npm run dev
# http://localhost:3000
```

To test the Sequencer webhook locally, point ngrok at port 3000 and use the public URL in EmailBison.

### 4. Deploy to Vercel

```bash
# Create GitHub repo, push, then:
vercel link
vercel env add ...   # all vars from §2
vercel deploy --prod
```

`vercel.json` registers the two crons automatically on deploy.

### 5. Wire webhooks (after deploy)

**Sequencer (EmailBison)** — `https://sequencer.gushwork.ai` → Settings → Webhooks → Create:

- Name: `5-min dialing`
- URL: `https://<your-app>.vercel.app/api/webhooks/sequencer`
- Events: toggle ON only **Contact Interested**
- Hit "Send test webhook" to confirm 200 OK.

**JustCall** — App → Settings → Integrations → Webhooks → Add:

- URL: `https://<your-app>.vercel.app/api/webhooks/justcall`
- Event: **Call Completed** (or Call Started if you want dial-attempt time)
- Direction filter: Outbound

## Routes

| Route | Method | What it does |
| --- | --- | --- |
| `/` | GET | Dashboard (polls every 10s) |
| `/api/dialer-rows` | GET | All Tab 1 rows |
| `/api/reminder-rows` | GET | All Tab 2 rows |
| `/api/webhooks/sequencer` | POST | EmailBison `LEAD_INTERESTED` ingress |
| `/api/webhooks/justcall` | POST | JustCall call-completed ingress |
| `/api/cron/dedup-dialer` | GET | Every 15 min — drop rows whose lead booked a demo |
| `/api/cron/refresh-reminders` | GET | Daily 6 PM IST — rebuild Tab 2 |
| `/api/actions/sms` | POST | Send reminder SMS via JustCall |
| `/api/actions/email` | POST | Send reminder email via EmailBison |

## Inbox URL format

The Sequencer "View reply" link is built as `<base>/campaigns/{campaign_id}/inbox?reply={reply_uuid}`.
If your instance uses a different inbox URL, edit `lib/sequencer.ts → threadUrl()`.
