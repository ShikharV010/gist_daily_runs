// JustCall webhook receiver. Updates call_at, call_within_5min,
// call_disposition, and increments call_attempts on every event.

import { NextRequest, NextResponse } from "next/server";
import { query, digitsOnly } from "@/lib/db";
import { verifyHmac } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

type JcPayload = {
  event_id?: string;
  event_type?: string;
  data?: {
    id?: number | string;
    direction?: string;
    datetime?: string;
    contact_number?: string;
    dialed_number?: string;
    agent_number?: string;
    disposition?: string;
    disposition_code?: string;
    outcome?: string;
    notes?: string;
  };
};

function pickDisposition(d: JcPayload["data"]): string | null {
  if (!d) return null;
  return d.disposition || d.outcome || d.disposition_code || d.notes || null;
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

  if (body.data?.direction && !/outbound/i.test(body.data.direction)) {
    return NextResponse.json({ status: "ignored", reason: "not outbound" });
  }

  const phone = digitsOnly(body.data?.contact_number || body.data?.dialed_number);
  if (!phone) {
    return NextResponse.json({ error: "no contact number in payload" }, { status: 400 });
  }

  const callAtIso = (body.data?.datetime ? new Date(body.data.datetime) : new Date()).toISOString();
  const disposition = pickDisposition(body.data);

  // - First call's timestamp wins (call_at = COALESCE(call_at, $1)).
  // - call_within_5min is computed from that first call only.
  // - call_attempts increments on EVERY webhook event.
  // - call_disposition always reflects the latest call.
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
