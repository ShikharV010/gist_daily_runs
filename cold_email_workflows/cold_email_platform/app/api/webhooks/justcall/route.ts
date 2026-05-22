// JustCall webhook receiver.
//
// Subscribe to BOTH events in JustCall → Settings → Webhooks (V2):
//   - "Call completed in JustCall"  → increments call_attempts, sets call_at
//   - "Call updated in JustCall"    → captures disposition (SDR marks it after the call)
//
// Both should use the same URL: /api/webhooks/justcall
//
// JustCall v2 payload shape:
// {
//   "type": "call.completed" | "call.updated",
//   "data": {
//     "id": 178632100,
//     "contact_number": "1681381XXXX",
//     "call_date": "2024-01-18", "call_time": "14:34:13",
//     "call_info": {
//       "direction": "Incoming" | "Outgoing",
//       "type": "answered" | "missed",
//       "disposition": ""   // <- selected AFTER call ends, comes via call.updated
//     }
//   }
// }

import { NextRequest, NextResponse } from "next/server";
import { query, digitsOnly } from "@/lib/db";
import { verifyHmac } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

type JcPayload = {
  request_id?: string;
  type?: string;
  data?: {
    id?: number | string;
    contact_number?: string;
    dialed_number?: string;
    call_date?: string;
    call_time?: string;
    call_user_date?: string;
    call_user_time?: string;
    datetime?: string;
    call_info?: {
      direction?: string;
      type?: string;
      disposition?: string;
      notes?: string;
      missed_call_reason?: string;
    };
    direction?: string;
    disposition?: string;
    disposition_code?: string;
    outcome?: string;
    notes?: string;
  };
};

function pickDirection(d: JcPayload["data"]): string | null {
  if (!d) return null;
  return d.call_info?.direction || d.direction || null;
}

function pickDisposition(d: JcPayload["data"]): string | null {
  if (!d) return null;
  const raw =
    d.call_info?.disposition ||
    d.disposition ||
    d.outcome ||
    d.disposition_code ||
    d.call_info?.notes ||
    d.notes ||
    null;
  if (!raw) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

function pickCallAt(d: JcPayload["data"]): Date {
  if (!d) return new Date();
  if (d.datetime) {
    const t = new Date(d.datetime);
    if (!isNaN(t.getTime())) return t;
  }
  const date = d.call_date || d.call_user_date;
  const time = d.call_time || d.call_user_time;
  if (date && time) {
    const t = new Date(`${date}T${time}Z`);
    if (!isNaN(t.getTime())) return t;
  }
  return new Date();
}

/** Last 10 digits for fuzzy phone match (collapses country-code mismatches). */
function last10(phone: string | null): string | null {
  if (!phone) return null;
  return phone.slice(-10);
}

export async function GET() {
  return NextResponse.json({ status: "ok", route: "justcall-webhook" });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-justcall-signature");
  if (process.env.JUSTCALL_WEBHOOK_SECRET && sig) {
    if (!verifyHmac(raw, sig, process.env.JUSTCALL_WEBHOOK_SECRET)) {
      console.warn("[justcall] invalid signature, ignoring");
      return NextResponse.json({ status: "ignored", reason: "invalid signature" });
    }
  }

  let body: JcPayload;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ status: "ignored", reason: "invalid json" });
  }

  const eventType = (body.type || "").toLowerCase();
  const isCompleted = /call\.completed/.test(eventType);
  const isUpdated = /call\.updated/.test(eventType);
  if (!isCompleted && !isUpdated) {
    return NextResponse.json({ status: "ignored", reason: "unsupported event", type: eventType });
  }

  const direction = pickDirection(body.data);
  if (direction && !/(outbound|outgoing)/i.test(direction)) {
    return NextResponse.json({ status: "ignored", reason: "not outbound", direction });
  }

  const phone = digitsOnly(body.data?.contact_number || body.data?.dialed_number);
  const phoneLast10 = last10(phone);
  if (!phoneLast10) {
    return NextResponse.json({ status: "ignored", reason: "no contact number" });
  }

  const callAtIso = pickCallAt(body.data).toISOString();
  const disposition = pickDisposition(body.data);

  let updated: Array<{ id: string; row_type: string; external_id: string }> = [];

  if (isCompleted) {
    // First completion of THIS call: stamp call_at, compute < 5 min, set
    // disposition (if any), and bump attempts. We use right(phone, 10) to
    // tolerate country-code mismatches between our DB and JustCall.
    updated = await query<{ id: string; row_type: string; external_id: string }>(
      `UPDATE gist.gtm_unified_db_source
          SET call_at = COALESCE(call_at, $1::timestamptz),
              call_within_5min = CASE
                WHEN call_at IS NOT NULL THEN call_within_5min
                WHEN reply_at IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM ($1::timestamptz - reply_at)) <= 300
              END,
              call_disposition = COALESCE(NULLIF($3, ''), call_disposition),
              call_attempts = COALESCE(call_attempts, 0) + 1
        WHERE right(phone, 10) = $2
        RETURNING id, row_type, external_id`,
      [callAtIso, phoneLast10, disposition]
    );
  } else if (isUpdated) {
    // SDR updated the call (typically the disposition pick). Don't bump
    // attempts, don't touch call_at. Just overwrite disposition.
    if (!disposition) {
      return NextResponse.json({ status: "ignored", reason: "call.updated with no disposition" });
    }
    updated = await query<{ id: string; row_type: string; external_id: string }>(
      `UPDATE gist.gtm_unified_db_source
          SET call_disposition = $2
        WHERE right(phone, 10) = $1
        RETURNING id, row_type, external_id`,
      [phoneLast10, disposition]
    );
  }

  return NextResponse.json({
    status: "ok",
    event: eventType,
    phone,
    rows_updated: updated.length,
    disposition,
    by_type: updated.reduce<Record<string, number>>((acc, r) => {
      acc[r.row_type] = (acc[r.row_type] || 0) + 1;
      return acc;
    }, {}),
  });
}
