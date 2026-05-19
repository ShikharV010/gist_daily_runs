import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { DialerRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await query<DialerRow>(
    `SELECT id::text, external_id, name, company, website, email, phone, phone_source,
            sequencer_thread_url, reply_at, call_at, call_within_5min, enrichment_status
     FROM gist.gtm_unified_db_source
     WHERE row_type = 'dialer'
     ORDER BY reply_at DESC
     LIMIT 500`
  );
  return NextResponse.json({ rows });
}
