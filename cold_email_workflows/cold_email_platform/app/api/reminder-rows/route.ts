import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { ReminderRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await query<ReminderRow>(
    `SELECT id::text, external_id, name, company, website, email, phone, phone_source,
            sequencer_thread_url, reply_at, demo_at, source,
            call_at, status, enrichment_status
     FROM gist.gtm_unified_db_source
     WHERE row_type = 'reminder'
     ORDER BY demo_at ASC`
  );
  return NextResponse.json({ rows });
}
