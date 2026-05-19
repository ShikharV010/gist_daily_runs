// Cron: every 15 min, remove dialer rows whose lead has booked a demo.
// Match on lowercased email OR website domain against
// gist.gtm_inbound_demo_bookings (is_latest=true).
//
// Scheduled in vercel.json: "*/15 * * * *"

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { verifyCron } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!verifyCron(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const deleted = await query<{
    id: string;
    external_id: string;
    email: string;
    domain: string | null;
  }>(
    `
    WITH booked AS (
      SELECT DISTINCT lower(prospect_email) AS email
      FROM gist.gtm_inbound_demo_bookings
      WHERE is_latest = true
        AND prospect_email IS NOT NULL
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
    DELETE FROM gist.gtm_unified_db_source d
    WHERE d.row_type = 'dialer'
      AND (
        lower(d.email) IN (SELECT email FROM booked)
        OR (d.domain IS NOT NULL AND d.domain IN (SELECT domain FROM booked_domains))
      )
    RETURNING id, external_id, email, domain
    `
  );

  return NextResponse.json({
    status: "ok",
    deleted_count: deleted.length,
    deleted: deleted.slice(0, 50),
  });
}
