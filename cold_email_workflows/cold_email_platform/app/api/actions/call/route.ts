// Initiate an outbound call via JustCall click-to-call. JustCall rings the
// agent's phone (Allaine) first, then bridges the call to the contact.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { initiateCall } from "@/lib/justcall";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { row_id?: string };
  if (!body.row_id) {
    return NextResponse.json({ error: "row_id required" }, { status: 400 });
  }

  const rows = await query<{ phone: string | null }>(
    `SELECT phone
       FROM gist.gtm_unified_db_source
      WHERE id = $1`,
    [body.row_id]
  );
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "row not found" }, { status: 404 });
  if (!row.phone) return NextResponse.json({ error: "no phone on row" }, { status: 400 });

  const out = await initiateCall(row.phone);
  if (!out.ok) {
    return NextResponse.json(
      { error: "JustCall initiate failed", status: out.status, data: out.data },
      { status: 502 }
    );
  }
  return NextResponse.json({ status: "initiated", data: out.data });
}
