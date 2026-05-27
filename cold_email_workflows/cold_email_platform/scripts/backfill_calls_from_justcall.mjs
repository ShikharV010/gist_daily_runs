// Backfills call_at, call_attempts, call_within_5min, and call_disposition on
// every dialer row by pulling the canonical record straight from JustCall's
// /v2.1/calls API. Use this to repair any disposition or attempt-count drift
// from the live webhook.
//
// Usage:
//   node scripts/backfill_calls_from_justcall.mjs            # default: all rows, last 90 days of calls
//   node scripts/backfill_calls_from_justcall.mjs --days 30  # narrower JC window
//   node scripts/backfill_calls_from_justcall.mjs --dry      # don't write, just report

import fs from "node:fs";
import pg from "pg";

const ENV = "/Users/shikhar.vermagushwork.ai/Documents/claude/projects/.env";
const txt = fs.readFileSync(ENV, "utf8");
for (const line of txt.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const args = process.argv.slice(2);
const DAYS = (() => {
  const i = args.indexOf("--days");
  return i >= 0 ? Number(args[i + 1]) : 90;
})();
const DRY = args.includes("--dry");

const JC_AUTH = process.env.JUSTCALL_AUTHENTICATION;
const JC_BASE = "https://api.justcall.io/v2.1";
const DB_URL = process.env.DATABASE_URL;

if (!JC_AUTH) throw new Error("JUSTCALL_AUTHENTICATION not set");
if (!DB_URL) throw new Error("DATABASE_URL not set");

const headers = {
  Authorization: JC_AUTH.startsWith("Bearer ") ? JC_AUTH : `Bearer ${JC_AUTH}`,
  Accept: "application/json",
};

function last10(s) {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

function asString(v) {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join(", ").trim() || null;
  return null;
}

function pickDirection(call) {
  return call?.call_info?.direction || call?.direction || null;
}

function pickDisposition(call) {
  const c = call?.call_info || {};
  return (
    asString(c.disposition) ||
    asString(c.outcomes) ||
    asString(c.outcome) ||
    asString(c.disposition_code) ||
    asString(c.tag) ||
    asString(c.tags) ||
    asString(call?.disposition) ||
    asString(call?.outcome) ||
    asString(call?.disposition_code) ||
    asString(call?.tags) ||
    asString(c.notes) ||
    asString(call?.notes) ||
    null
  );
}

function pickPhone(call) {
  return last10(call?.contact_number || call?.dialed_number);
}

function pickCallAt(call) {
  if (call?.datetime) {
    const t = new Date(call.datetime);
    if (!isNaN(t)) return t;
  }
  const date = call?.call_date || call?.call_user_date;
  const time = call?.call_time || call?.call_user_time;
  if (date && time) {
    const t = new Date(`${date}T${time}Z`);
    if (!isNaN(t)) return t;
  }
  return null;
}

// ── 1. Pull all JustCall outbound calls in the window ──────────────────────
async function fetchAllCalls() {
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  const sinceIso = since.toISOString().slice(0, 10);
  console.log(`Fetching JustCall calls since ${sinceIso} (${DAYS} days)…`);

  const all = [];
  let page = 0;
  const PER = 100;
  // Try several endpoint shapes JustCall supports — different accounts use different ones.
  for (;;) {
    const candidates = [
      `${JC_BASE}/calls?page=${page}&per_page=${PER}&from=${sinceIso}`,
      `${JC_BASE}/calls?page=${page}&per_page=${PER}`,
    ];
    let batch = null;
    let usedUrl = null;
    for (const url of candidates) {
      const r = await fetch(url, { headers });
      if (!r.ok) {
        if (page === 0) console.warn(`  ${r.status} ${url}`);
        continue;
      }
      const j = await r.json();
      batch = j.data || j.calls || j.results || (Array.isArray(j) ? j : null);
      usedUrl = url;
      if (batch != null) break;
    }
    if (!batch) {
      if (page === 0) throw new Error("Couldn't fetch JustCall calls — no endpoint matched");
      break;
    }
    if (!batch.length) break;

    // Filter to outbound only
    const out = batch.filter((c) => /(outbound|outgoing)/i.test(pickDirection(c) || ""));
    all.push(...out);
    console.log(`  page=${page} fetched=${batch.length} kept_outbound=${out.length} (cumulative ${all.length})`);
    page++;
    if (batch.length < PER) break;
    if (page > 200) {
      console.warn("  page cap (200) hit — stopping");
      break;
    }
  }
  return all;
}

// ── 2. Backfill ────────────────────────────────────────────────────────────
async function main() {
  const calls = await fetchAllCalls();
  console.log(`Total outbound calls fetched: ${calls.length}\n`);

  // Index by last 10 phone digits
  const byPhone = new Map();
  for (const c of calls) {
    const p = pickPhone(c);
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(c);
  }
  console.log(`Unique phones in JustCall: ${byPhone.size}\n`);

  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();

  const { rows: dialerRows } = await db.query(`
    SELECT id, phone, reply_at, call_at, call_attempts, call_disposition, call_within_5min
      FROM gist.gtm_unified_db_source
     WHERE row_type = 'dialer'
       AND phone IS NOT NULL
  `);
  console.log(`Dialer rows to evaluate: ${dialerRows.length}`);

  let updated = 0,
    unchanged = 0,
    noCalls = 0;

  for (const row of dialerRows) {
    const p = last10(row.phone);
    const matched = byPhone.get(p) || [];
    if (matched.length === 0) {
      noCalls++;
      continue;
    }
    // Sort chronologically; first call → call_at; latest non-empty disposition → disposition
    const sorted = matched
      .map((c) => ({ c, t: pickCallAt(c) }))
      .filter((x) => x.t)
      .sort((a, b) => a.t - b.t);
    if (sorted.length === 0) {
      noCalls++;
      continue;
    }

    const firstCallAt = sorted[0].t;
    const attempts = sorted.length;

    // Latest disposition wins (most recent with a non-empty value)
    let disposition = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const d = pickDisposition(sorted[i].c);
      if (d) {
        disposition = d;
        break;
      }
    }

    const replyAt = row.reply_at ? new Date(row.reply_at) : null;
    const within5 =
      replyAt && firstCallAt
        ? (firstCallAt - replyAt) / 1000 <= 300
        : null;

    // Skip rows where nothing meaningful would change
    const sameCallAt = row.call_at && new Date(row.call_at).getTime() === firstCallAt.getTime();
    const sameAttempts = row.call_attempts === attempts;
    const sameDisp = (row.call_disposition || null) === disposition;
    const sameWithin = row.call_within_5min === within5;
    if (sameCallAt && sameAttempts && sameDisp && sameWithin) {
      unchanged++;
      continue;
    }

    if (!DRY) {
      await db.query(
        `UPDATE gist.gtm_unified_db_source
            SET call_at          = $1,
                call_attempts    = $2,
                call_disposition = COALESCE($3, call_disposition),
                call_within_5min = $4
          WHERE id = $5`,
        [firstCallAt.toISOString(), attempts, disposition, within5, row.id]
      );
    }
    updated++;
    if (updated <= 30 || updated % 25 === 0) {
      console.log(
        `  row#${row.id} phone=${p} attempts=${row.call_attempts}→${attempts} disposition=${JSON.stringify(row.call_disposition)}→${JSON.stringify(
          disposition
        )} within5=${row.call_within_5min}→${within5}`
      );
    }
  }

  console.log(`\nDone. updated=${updated} unchanged=${unchanged} no_calls_in_jc=${noCalls}${DRY ? " (DRY RUN)" : ""}`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
