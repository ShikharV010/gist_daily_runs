import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { DialerRow } from "@/lib/types";

export const dynamic = "force-dynamic";

// Read-time dedup: hide any dialer row whose lead has since booked a demo.
export async function GET() {
  const rows = await query<DialerRow>(
    `
    WITH booked_emails AS (
      SELECT DISTINCT lower(prospect_email) AS email
      FROM gist.gtm_inbound_demo_bookings
      WHERE is_latest = true
        AND prospect_email LIKE '%@%'
    ),
    booked_domains AS (
      SELECT DISTINCT lower(
        regexp_replace(
          regexp_replace(prospect_website, '^https?://(www\\.)?', ''),
          '/.*$', ''
        )
      ) AS domain
      FROM gist.gtm_inbound_demo_bookings
      WHERE is_latest = true
        AND prospect_website IS NOT NULL
        AND prospect_website <> ''
    )
    SELECT d.id::text, d.external_id, d.name, d.company, d.website, d.email,
           d.phone, d.phone_source,
           d.sequencer_thread_url, d.reply_at, d.call_at,
           d.call_within_5min, d.call_attempts, d.call_disposition, d.enrichment_status
      FROM gist.gtm_unified_db_source d
     WHERE d.row_type = 'dialer'
       AND d.reply_at >= NOW() - INTERVAL '48 hours'
       AND lower(d.email) NOT IN (SELECT email FROM booked_emails)
       AND (d.domain IS NULL OR d.domain NOT IN (SELECT domain FROM booked_domains))
     ORDER BY d.reply_at DESC
     LIMIT 500
    `
  );
  return NextResponse.json({ rows });
}
