// Cron: every 15 min. Re-polls JustCall for dialer rows that may have missed
// their webhook updates, applies the truth from JustCall to gtm_unified_db_source.
//
// Window:
//   • created_at >= NOW() - 30 min                (new arrivals — primary)
//   • OR call_at IS NULL AND reply_at >= 24h     (never-called recent rows)
//   • OR call_disposition NOT 'meeting booked' AND reply_at >= 24h (might upgrade)
//
// Update rules (Meeting Booked is sticky — see also /api/webhooks/justcall):
//   • call_at        = earliest outbound call AFTER reply_at (fallback: earliest)
//   • call_attempts  = GREATEST(stored, JustCall outbound count)
//   • call_within_5min = (call_at >= reply_at) AND delta <= 300s
//   • call_disposition = Meeting Booked is preserved; otherwise latest JC dispo
//
// Scheduled by GHA: .github/workflows/cold_email_platform_dialer_backfill.yml

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type DialerRow = {
  id: string;
  email: string;
  phone: string;
  reply_at: string;
};

type JcCall = {
  id?: number | string;
  datetime?: string;
  call_date?: string;
  call_time?: string;
  call_user_date?: string;
  call_user_time?: string;
  call_info?: {
    direction?: string;
    disposition?: string | string[];
    outcomes?: string | string[];
    outcome?: string;
    disposition_code?: string;
    tag?: string;
    tags?: string | string[];
    notes?: string;
  };
  direction?: string;
  disposition?: string;
};

function toE164(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length >= 10) return `+${d}`;
  return null;
}

function callAt(c: JcCall): Date | null {
  if (c.datetime) {
    const t = new Date(c.datetime);
    if (!isNaN(t.getTime())) return t;
  }
  const date = c.call_date || c.call_user_date;
  const time = c.call_time || c.call_user_time;
  if (date && time) {
    const t = new Date(`${date}T${time}Z`);
    if (!isNaN(t.getTime())) return t;
  }
  return null;
}

function pickDirection(c: JcCall): string {
  return c.call_info?.direction || c.direction || "";
}

function pickDisposition(c: JcCall): string | null {
  const candidates: Array<string | string[] | undefined> = [
    c.call_info?.disposition,
    c.call_info?.outcomes,
    c.call_info?.outcome,
    c.call_info?.disposition_code,
    c.call_info?.tag,
    c.call_info?.tags,
    c.disposition,
    c.call_info?.notes,
  ];
  for (const v of candidates) {
    if (!v) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const j = v.filter(Boolean).map(String).join(", ").trim();
      if (j) return j;
    }
  }
  return null;
}

async function jcCallsForPhone(
  phone: string,
  token: string,
  diag: { rateLimitedHits: number; otherErrors: number; emptyResponses: number }
): Promise<JcCall[]> {
  const e164 = toE164(phone);
  if (!e164) return [];
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const headers = { Authorization: auth, Accept: "application/json" };
  const url = `https://api.justcall.io/v2.1/calls?contact_number=${encodeURIComponent(e164)}&per_page=100`;

  // Retry on 429 with a single back-off. JustCall's published limit is roughly
  // 1000/hour but bursts trigger per-second throttling — slow down on 429.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        diag.rateLimitedHits++;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        return [];
      }
      if (!res.ok) {
        diag.otherErrors++;
        return [];
      }
      const data = (await res.json()) as {
        data?: JcCall[];
        calls?: JcCall[];
        results?: JcCall[];
      };
      const batch =
        data.data || data.calls || data.results || (Array.isArray(data) ? (data as JcCall[]) : []);
      if (!batch.length) diag.emptyResponses++;
      return batch;
    } catch {
      diag.otherErrors++;
      return [];
    }
  }
  return [];
}

export async function GET(_req: NextRequest) {
  const token = process.env.JUSTCALL_AUTHENTICATION;
  if (!token) {
    return NextResponse.json({ error: "missing JUSTCALL_AUTHENTICATION" }, { status: 500 });
  }

  const rows = await query<DialerRow>(`
    SELECT id::text                                  AS id,
           email,
           phone,
           reply_at::text                            AS reply_at
      FROM gist.gtm_unified_db_source
     WHERE row_type = 'dialer'
       AND phone IS NOT NULL AND phone <> ''
       AND (
         created_at >= NOW() - INTERVAL '30 minutes'
         OR (call_at IS NULL AND reply_at >= NOW() - INTERVAL '24 hours')
         OR (
           (call_disposition IS NULL OR call_disposition NOT ILIKE '%meeting booked%')
           AND reply_at >= NOW() - INTERVAL '24 hours'
         )
       )
  `);

  let updated = 0;
  let noCalls = 0;
  let errors = 0;
  const diag = { rateLimitedHits: 0, otherErrors: 0, emptyResponses: 0 };

  // 3-way concurrency: JustCall throttles aggressive bursts. 67 rows × ~1.5s ≈ 35s
  // sequential vs ~12s at 3-way — well within Vercel's 300s function budget,
  // and friendly to the API.
  const concurrency = 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      const replyAt = new Date(r.reply_at);
      try {
        const calls = await jcCallsForPhone(r.phone, token, diag);
        const outbound = calls.filter((c) => /outbound|outgoing/i.test(pickDirection(c)));
        const parsed = outbound
          .map((c) => ({ t: callAt(c), disp: pickDisposition(c) }))
          .filter((x): x is { t: Date; disp: string | null } => x.t !== null);
        if (parsed.length === 0) {
          noCalls++;
          continue;
        }
        parsed.sort((a, b) => a.t.getTime() - b.t.getTime());
        // Earliest call AFTER reply (fallback: earliest call ever)
        const firstAfter = parsed.find((x) => x.t.getTime() >= replyAt.getTime());
        const firstCallAt = (firstAfter ?? parsed[0]).t;
        const attempts = outbound.length;
        // Sticky Meeting Booked: prefer it if seen on any call.
        const dispositions = parsed.map((x) => x.disp).filter(Boolean) as string[];
        const mb = dispositions.find((d) => /meeting booked/i.test(d));
        const bestDisp = mb || dispositions[dispositions.length - 1] || null;

        await query(
          `UPDATE gist.gtm_unified_db_source
              SET call_at = $1::timestamptz,
                  call_attempts = GREATEST(COALESCE(call_attempts, 0), $2::int),
                  call_within_5min = CASE
                    WHEN reply_at IS NULL THEN NULL
                    WHEN $1::timestamptz < reply_at THEN false
                    ELSE EXTRACT(EPOCH FROM ($1::timestamptz - reply_at)) <= 300
                  END,
                  call_disposition = CASE
                    WHEN call_disposition ILIKE '%meeting booked%'
                      AND ($3::text IS NULL OR $3::text NOT ILIKE '%meeting booked%')
                      THEN call_disposition
                    ELSE COALESCE(NULLIF($3::text, ''), call_disposition)
                  END
            WHERE id = $4::bigint`,
          [firstCallAt.toISOString(), attempts, bestDisp, r.id]
        );
        updated++;
      } catch (e) {
        errors++;
        console.warn(`[dialer-backfill] id=${r.id} phone=${r.phone} failed:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  return NextResponse.json({
    status: "ok",
    scanned: rows.length,
    updated,
    no_calls: noCalls,
    errors,
    diag,
  });
}
