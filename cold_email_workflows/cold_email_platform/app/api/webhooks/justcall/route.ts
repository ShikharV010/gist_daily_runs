// JustCall webhook receiver.
//
// Subscribe to BOTH events in JustCall → Settings → Webhooks (V2):
//   - "Call completed in JustCall"  → increments call_attempts, sets call_at
//   - "Call updated in JustCall"    → captures disposition (SDR marks it after the call)

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
      status?: string;
      disposition?: string;
      disposition_code?: string;
      notes?: string;
      tag?: string;
      tags?: string[] | string;
      outcomes?: string[] | string;
      outcome?: string;
      call_traits?: unknown;
      missed_call_reason?: string;
    };
    // top-level fallbacks
    direction?: string;
    disposition?: string;
    disposition_code?: string;
    outcome?: string;
    notes?: string;
    tags?: string[] | string;
  };
};

function pickDirection(d: JcPayload["data"]): string | null {
  if (!d) return null;
  return d.call_info?.direction || d.direction || null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    const joined = v.filter(Boolean).map(String).join(", ").trim();
    return joined || null;
  }
  return null;
}

function pickDisposition(d: JcPayload["data"]): string | null {
  if (!d) return null;
  const candidates: Array<string | null | undefined> = [
    asString(d.call_info?.disposition),
    asString(d.call_info?.outcomes),
    asString(d.call_info?.outcome),
    asString(d.call_info?.disposition_code),
    asString(d.call_info?.tag),
    asString(d.call_info?.tags),
    asString(d.disposition),
    asString(d.outcome),
    asString(d.disposition_code),
    asString(d.tags),
    asString(d.call_info?.notes),  // last resort — rep may have typed disposition into notes
    asString(d.notes),
  ];
  for (const c of candidates) {
    if (c && c.length) return c;
  }
  return null;
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

function last10(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length >= 10 ? phone.slice(-10) : phone;
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
    console.warn("[justcall] invalid JSON body");
    return NextResponse.json({ status: "ignored", reason: "invalid json" });
  }

  const eventType = (body.type || "").toLowerCase();
  const callId = body.data?.id ? String(body.data.id) : null;
  const direction = pickDirection(body.data);
  const phoneDigits = digitsOnly(body.data?.contact_number || body.data?.dialed_number);
  const phoneL10 = last10(phoneDigits);
  const disposition = pickDisposition(body.data);

  console.log(
    `[justcall] event=${eventType} call_id=${callId} dir=${direction} phone=${phoneDigits} disposition=${JSON.stringify(disposition)}`
  );

  const isCompleted = /call\.completed/.test(eventType);
  const isUpdated = /call\.updated/.test(eventType);
  if (!isCompleted && !isUpdated) {
    console.log(`[justcall] ignored: unsupported event "${eventType}"`);
    return NextResponse.json({ status: "ignored", reason: "unsupported event", type: eventType });
  }

  if (direction && !/(outbound|outgoing)/i.test(direction)) {
    console.log(`[justcall] ignored: not outbound (${direction})`);
    return NextResponse.json({ status: "ignored", reason: "not outbound", direction });
  }

  if (!phoneL10) {
    console.log(`[justcall] ignored: no contact number on payload`);
    return NextResponse.json({ status: "ignored", reason: "no contact number" });
  }

  const callAtIso = pickCallAt(body.data).toISOString();

  let updated: Array<{ id: string; row_type: string; external_id: string }> = [];

  if (isCompleted) {
    // First completion: stamp call_at, compute <5min, set disposition if any, bump attempts.
    //
    // call_within_5min: only true when call happened AFTER reply AND within 5 min.
    //                   The OLD logic counted negative deltas (call BEFORE reply, e.g.
    //                   the lead was in an earlier campaign) as "<5min" — wrong.
    //
    // call_disposition: STICKY for Meeting Booked — once a phone has booked a meeting,
    //                   later "No Answer" calls (e.g. confirmation calls) must NOT
    //                   overwrite that. This is the bug that caused the analytics tab
    //                   to undercount bookings.
    updated = await query<{ id: string; row_type: string; external_id: string }>(
      `UPDATE gist.gtm_unified_db_source
          SET call_at = COALESCE(call_at, $1::timestamptz),
              call_within_5min = CASE
                WHEN call_at IS NOT NULL THEN call_within_5min
                WHEN reply_at IS NULL THEN NULL
                ELSE ($1::timestamptz >= reply_at)
                  AND EXTRACT(EPOCH FROM ($1::timestamptz - reply_at)) <= 300
              END,
              call_disposition = CASE
                WHEN call_disposition ILIKE '%meeting booked%'
                  AND NULLIF($3, '') NOT ILIKE '%meeting booked%' THEN call_disposition
                ELSE COALESCE(NULLIF($3, ''), call_disposition)
              END,
              call_attempts = COALESCE(call_attempts, 0) + 1
        WHERE right(phone, 10) = $2
        RETURNING id, row_type, external_id`,
      [callAtIso, phoneL10, disposition ?? ""]
    );
  } else if (isUpdated) {
    // SDR updated the call (typically the disposition pick). Don't bump attempts,
    // don't touch call_at. Disposition is sticky on Meeting Booked.
    if (!disposition) {
      console.log(`[justcall] call.updated had no extractable disposition — payload.data keys: ${Object.keys(body.data || {}).join(",")} call_info keys: ${Object.keys(body.data?.call_info || {}).join(",")}`);
      return NextResponse.json({ status: "ignored", reason: "call.updated with no disposition" });
    }
    updated = await query<{ id: string; row_type: string; external_id: string }>(
      `UPDATE gist.gtm_unified_db_source
          SET call_disposition = CASE
                WHEN call_disposition ILIKE '%meeting booked%'
                  AND $2 NOT ILIKE '%meeting booked%' THEN call_disposition
                ELSE $2
              END
        WHERE right(phone, 10) = $1
        RETURNING id, row_type, external_id`,
      [phoneL10, disposition]
    );
  }

  if (updated.length === 0) {
    console.log(`[justcall] no rows matched phone last10="${phoneL10}" (event=${eventType})`);
  } else {
    console.log(
      `[justcall] updated ${updated.length} row(s): ${updated.map((u) => `${u.row_type}#${u.external_id}`).join(", ")}`
    );
  }

  return NextResponse.json({
    status: "ok",
    event: eventType,
    phone: phoneDigits,
    rows_updated: updated.length,
    disposition,
    by_type: updated.reduce<Record<string, number>>((acc, r) => {
      acc[r.row_type] = (acc[r.row_type] || 0) + 1;
      return acc;
    }, {}),
  });
}
