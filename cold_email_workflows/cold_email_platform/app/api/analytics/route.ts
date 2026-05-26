// Analytics for the 5-min dialing tab.
// All metrics are scoped to the last 30 days (for stat cards + by-day chart)
// or last 12 weeks (for by-week chart). This keeps cards consistent with the
// charts and removes the "all-time totals don't match the chart" confusion.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AnalyticsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const IANA: Record<string, string> = {
  IST: "Asia/Kolkata",
  EST: "America/New_York",
};

export async function GET(req: NextRequest) {
  const tzParam = (req.nextUrl.searchParams.get("tz") || "IST").toUpperCase();
  const tz = tzParam === "EST" ? "EST" : "IST";
  const iana = IANA[tz];

  // ── Totals (last 30 days in selected tz) ─────────────────────────────────
  // total_calls = sum of call_attempts (actual call volume; one lead = many calls)
  // calls_within_5min / calls_outside_5min = unique LEADS bucketed by their first call
  // bookings_within_5min / bookings_outside_5min = leads whose disposition contains 'meeting booked'
  const totalsRows = await query<{
    total_dialer_rows: string;
    total_calls: string;
    calls_within_5min: string;
    calls_outside_5min: string;
    bookings_within_5min: string;
    bookings_outside_5min: string;
  }>(
    `WITH scoped AS (
       SELECT *
         FROM gist.gtm_unified_db_source
        WHERE row_type = 'dialer'
          AND ((call_at IS NOT NULL AND call_at AT TIME ZONE $1 >= (NOW() AT TIME ZONE $1) - INTERVAL '30 days')
            OR (call_at IS NULL     AND reply_at AT TIME ZONE $1 >= (NOW() AT TIME ZONE $1) - INTERVAL '30 days'))
     )
     SELECT
       COUNT(*)                                                                                                       AS total_dialer_rows,
       COALESCE(SUM(call_attempts), 0)                                                                                AS total_calls,
       COUNT(*) FILTER (WHERE call_within_5min = true)                                                                AS calls_within_5min,
       COUNT(*) FILTER (WHERE call_within_5min = false)                                                               AS calls_outside_5min,
       COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND call_within_5min = true)                  AS bookings_within_5min,
       COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND call_within_5min = false)                 AS bookings_outside_5min
     FROM scoped`,
    [iana]
  );
  const totals = {
    total_dialer_rows: Number(totalsRows[0]?.total_dialer_rows || 0),
    total_calls: Number(totalsRows[0]?.total_calls || 0),
    calls_within_5min: Number(totalsRows[0]?.calls_within_5min || 0),
    calls_outside_5min: Number(totalsRows[0]?.calls_outside_5min || 0),
    bookings_within_5min: Number(totalsRows[0]?.bookings_within_5min || 0),
    bookings_outside_5min: Number(totalsRows[0]?.bookings_outside_5min || 0),
  };

  const bucketSql = (truncFn: "day" | "week") => `
    WITH cal AS (
      SELECT to_char(${
        truncFn === "day"
          ? "(call_at AT TIME ZONE $1)::date"
          : "date_trunc('week', call_at AT TIME ZONE $1)::date"
      }, 'YYYY-MM-DD') AS bucket,
             call_within_5min,
             call_disposition
        FROM gist.gtm_unified_db_source
       WHERE row_type = 'dialer'
         AND call_at IS NOT NULL
         AND call_at AT TIME ZONE $1 >= (NOW() AT TIME ZONE $1) - INTERVAL '${truncFn === "day" ? "30 days" : "12 weeks"}'
    )
    SELECT bucket,
           COUNT(*) FILTER (WHERE call_within_5min = true)                                                AS calls_within_5min,
           COUNT(*) FILTER (WHERE call_within_5min = false)                                               AS calls_outside_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND call_within_5min = true)  AS bookings_within_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND call_within_5min = false) AS bookings_outside_5min
      FROM cal
     GROUP BY bucket
     ORDER BY bucket DESC
  `;

  type BucketRow = {
    bucket: string;
    calls_within_5min: string;
    calls_outside_5min: string;
    bookings_within_5min: string;
    bookings_outside_5min: string;
  };
  const byDay = await query<BucketRow>(bucketSql("day"), [iana]);
  const byWeek = await query<BucketRow>(bucketSql("week"), [iana]);
  const cast = (rs: BucketRow[]) =>
    rs.map((r) => ({
      bucket: r.bucket,
      calls_within_5min: Number(r.calls_within_5min),
      calls_outside_5min: Number(r.calls_outside_5min),
      bookings_within_5min: Number(r.bookings_within_5min),
      bookings_outside_5min: Number(r.bookings_outside_5min),
    }));

  const body: AnalyticsResponse = {
    tz,
    totals,
    by_day: cast(byDay),
    by_week: cast(byWeek),
  };
  return NextResponse.json(body);
}
