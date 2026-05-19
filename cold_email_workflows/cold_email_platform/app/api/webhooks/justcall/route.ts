// JustCall webhook receiver.
//
// JustCall v2 payload shape (Call completed in JustCall):
// {
//   "request_id": "...",
//   "type": "call.completed",
//   "data": {
//     "id": 178632100,
//     "contact_number": "1681381XXXX",
//     "call_date": "2024-01-18",          // agent local date
//     "call_time": "14:34:13",            // agent local time
//     "call_user_date": "2024-01-18",     // user-tz date
//     "call_user_time": "07:27:57",       // user-tz time
//     "call_info": {
//       "direction": "Incoming" | "Outgoing",
//       "type": "answered" | "missed" | ...,
//       "disposition": "",
//       "notes": ""
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
    datetime?: string; // some events use this directly
    call_info?: {
      direction?: string;
      type?: string;
      disposition?: string;
      notes?: string;
      missed_call_reason?: string;
    };
    // top-level fallbacks (older payload shapes)
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
  return (
    d.call_info?.disposition ||
    d.call_info?.notes ||
    d.disposition ||
    d.outcome ||
    d.disposition_code ||
    d.notes ||
    null
  );
}

function pickCallAt(d: JcPayload["data"]): Date {
  if (!d) return new Date();
  if (d.datetime) {
    const t = new Date(d.datetime);
    if (!isNaN(t.getTime())) return t;
  }
  // Combine date + time. JustCall doesn't ship a timezone with this — we treat
  // it as UTC. Off-by-hours is fine; the < 5 min check uses reply_at delta.
  const date = d.call_date || d.call_user_date;
  const time = d.call_time || d.call_user_time;
  if (date && time) {
    const t = new Date(`${date}T${time}Z`);
    if (!isNaN(t.getTime())) return t;
  }
  return new Date();
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-justcall-signature");
  if (process.env.JUSTCALL_WEBHOOK_SECRET && sig) {
    if (!verifyHmac(raw, sig, process.env.JUSTCALL_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let body: JcPayload;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const direction = pickDirection(body.data);
  // Only outbound calls matter for the dialing metric. JustCall uses "Outgoing".
  if (direction && !/(outbound|outgoing)/i.test(direction)) {
    return NextResponse.json({ status: "ignored", reason: "not outbound", direction });
  }

  const phone = digitsOnly(body.data?.contact_number || body.data?.dialed_number);
  if (!phone) {
    return NextResponse.json({ error: "no contact number in payload" }, { status: 400 });
  }

  const callAtIso = pickCallAt(body.data).toISOString();
  const disposition = pickDisposition(body.data);

  const updated = await query<{
    id: string;
    row_type: string;
    external_id: string;
  }>(
    `UPDATE gist.gtm_unified_db_source
        SET call_at = COALESCE(call_at, $1::timestamptz),
            call_within_5min = CASE
              WHEN call_at IS NOT NULL THEN call_within_5min
              WHEN reply_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM ($1::timestamptz - reply_at)) <= 300
            END,
            call_disposition = $3,
            call_attempts = COALESCE(call_attempts, 0) + 1
      WHERE phone = $2
      RETURNING id, row_type, external_id`,
    [callAtIso, phone, disposition]
  );

  return NextResponse.json({
    status: "ok",
    phone,
    rows_updated: updated.length,
    disposition,
    by_type: updated.reduce<Record<string, number>>((acc, r) => {
      acc[r.row_type] = (acc[r.row_type] || 0) + 1;
      return acc;
    }, {}),
  });
}
