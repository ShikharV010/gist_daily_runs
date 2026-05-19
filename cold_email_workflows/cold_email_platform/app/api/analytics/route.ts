// Analytics for the 5-min dialing tab.
// Two metrics: calls-made-within-5-min, bookings-from-calls (Meeting Booked).
// Both attributed by call_at date in the requested timezone.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

const IANA: Record<string, string> = {
  IST: "Asia/Kolkata",
  EST: "America/New_York",
};

export type AnalyticsBucket = {
  bucket: string;             // YYYY-MM-DD for day, YYYY-MM-DD (Monday) for week
  calls_within_5min: number;
  bookings_from_calls: number;
};

export type AnalyticsResponse = {
  tz: "IST" | "EST";
  totals: {
    calls_within_5min: number;
    bookings_from_calls: number;
    total_dialer_rows: number;
  };
  by_day: AnalyticsBucket[];
  by_week: AnalyticsBucket[];
};

export async function GET(req: NextRequest) {
  const tzParam = (req.nextUrl.searchParams.get("tz") || "IST").toUpperCase();
  const tz = tzParam === "EST" ? "EST" : "IST";
  const iana = IANA[tz];

  // Totals
  const totalsRows = await query<{
    total_dialer_rows: string;
    calls_within_5min: string;
    bookings_from_calls: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE row_type = 'dialer')                                                  AS total_dialer_rows,
       COUNT(*) FILTER (WHERE row_type = 'dialer' AND call_within_5min = true)                      AS calls_within_5min,
       COUNT(*) FILTER (WHERE row_type = 'dialer' AND call_disposition ILIKE '%meeting booked%')    AS bookings_from_calls
     FROM gist.gtm_unified_db_source`
  );
  const totals = {
    total_dialer_rows: Number(totalsRows[0]?.total_dialer_rows || 0),
    calls_within_5min: Number(totalsRows[0]?.calls_within_5min || 0),
    bookings_from_calls: Number(totalsRows[0]?.bookings_from_calls || 0),
  };

  // By-day (last 30 days in tz)
  const byDay = await query<{ bucket: string; calls_within_5min: string; bookings_from_calls: string }>(
    `
    WITH cal AS (
      SELECT to_char((call_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS bucket,
             call_within_5min,
             call_disposition
        FROM gist.gtm_unified_db_source
       WHERE row_type = 'dialer'
         AND call_at IS NOT NULL
         AND call_at AT TIME ZONE $1 >= (NOW() AT TIME ZONE $1) - INTERVAL '30 days'
    )
    SELECT bucket,
           COUNT(*) FILTER (WHERE call_within_5min = true)                   AS calls_within_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%') AS bookings_from_calls
      FROM cal
     GROUP BY bucket
     ORDER BY bucket DESC
    `,
    [iana]
  );

  // By-week (Monday-anchored, last 12 weeks)
  const byWeek = await query<{ bucket: string; calls_within_5min: string; bookings_from_calls: string }>(
    `
    WITH cal AS (
      SELECT to_char(date_trunc('week', call_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS bucket,
             call_within_5min,
             call_disposition
        FROM gist.gtm_unified_db_source
       WHERE row_type = 'dialer'
         AND call_at IS NOT NULL
         AND call_at AT TIME ZONE $1 >= (NOW() AT TIME ZONE $1) - INTERVAL '12 weeks'
    )
    SELECT bucket,
           COUNT(*) FILTER (WHERE call_within_5min = true)                   AS calls_within_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%') AS bookings_from_calls
      FROM cal
     GROUP BY bucket
     ORDER BY bucket DESC
    `,
    [iana]
  );

  const cast = (rows: typeof byDay): AnalyticsBucket[] =>
    rows.map((r) => ({
      bucket: r.bucket,
      calls_within_5min: Number(r.calls_within_5min),
      bookings_from_calls: Number(r.bookings_from_calls),
    }));

  const body: AnalyticsResponse = {
    tz,
    totals,
    by_day: cast(byDay),
    by_week: cast(byWeek),
  };

  return NextResponse.json(body);
}
