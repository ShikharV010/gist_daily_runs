// Analytics for the 5-min dialing tab.
// Shows ALL-TIME data — totals, daily buckets, and weekly buckets cover
// every dialer row ever recorded.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AnalyticsResponse, DispositionRow, PhoneBookingRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const IANA: Record<string, string> = {
  IST: "Asia/Kolkata",
  EST: "America/New_York",
};

// Phrases inside a JustCall disposition that mean the rep did NOT speak to anyone.
const NOT_CONNECTED_RE = /(no answer|left vm|voicemail|invalid number|missed)/i;

export async function GET(req: NextRequest) {
  const tzParam = (req.nextUrl.searchParams.get("tz") || "IST").toUpperCase();
  const tz = tzParam === "EST" ? "EST" : "IST";
  const iana = IANA[tz];

  // ── Totals (all-time) ────────────────────────────────────────────────────
  // total_calls = sum of call_attempts (actual call volume; one lead = many calls)
  // calls_within_5min / calls_outside_5min = unique LEADS bucketed by their first call
  // bookings_within_5min / bookings_outside_5min = leads whose disposition contains 'meeting booked'
  //
  // The stored call_within_5min column may be wrong for older rows (the previous
  // webhook treated calls BEFORE the reply as "<5min" because the SQL didn't check
  // the sign of the delta). Compute it on the fly here so the dashboard is always
  // consistent: within_5min requires call_at >= reply_at AND delta <= 300s.
  const totalsRows = await query<{
    total_dialer_rows: string;
    total_calls: string;
    calls_within_5min: string;
    calls_outside_5min: string;
    bookings_within_5min: string;
    bookings_outside_5min: string;
  }>(
    `WITH d AS (
       SELECT call_attempts,
              call_disposition,
              CASE
                WHEN call_at IS NULL OR reply_at IS NULL THEN NULL
                WHEN call_at < reply_at THEN false
                ELSE EXTRACT(EPOCH FROM (call_at - reply_at)) <= 300
              END AS w5
         FROM gist.gtm_unified_db_source
        WHERE row_type = 'dialer'
     )
     SELECT
       COUNT(*)                                                                       AS total_dialer_rows,
       COALESCE(SUM(call_attempts), 0)                                                AS total_calls,
       COUNT(*) FILTER (WHERE w5 = true)                                              AS calls_within_5min,
       COUNT(*) FILTER (WHERE w5 = false)                                             AS calls_outside_5min,
       COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND w5 = true)  AS bookings_within_5min,
       COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND w5 = false) AS bookings_outside_5min
     FROM d`
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
             CASE
               WHEN reply_at IS NULL THEN NULL
               WHEN call_at < reply_at THEN false
               ELSE EXTRACT(EPOCH FROM (call_at - reply_at)) <= 300
             END AS w5,
             call_disposition
        FROM gist.gtm_unified_db_source
       WHERE row_type = 'dialer'
         AND call_at IS NOT NULL
    )
    SELECT bucket,
           COUNT(*) FILTER (WHERE w5 = true)                                                AS calls_within_5min,
           COUNT(*) FILTER (WHERE w5 = false)                                               AS calls_outside_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND w5 = true)  AS bookings_within_5min,
           COUNT(*) FILTER (WHERE call_disposition ILIKE '%meeting booked%' AND w5 = false) AS bookings_outside_5min
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

  // ── Disposition volume split ─────────────────────────────────────────────
  const dispRows = await query<{ disposition: string; leads: string; total_attempts: string }>(
    `SELECT call_disposition AS disposition,
            COUNT(*)::text AS leads,
            COALESCE(SUM(call_attempts), 0)::text AS total_attempts
       FROM gist.gtm_unified_db_source
      WHERE row_type = 'dialer' AND call_disposition IS NOT NULL
      GROUP BY call_disposition
      ORDER BY COUNT(*) DESC`
  );
  const dispositions: DispositionRow[] = dispRows.map((r) => ({
    disposition: r.disposition,
    leads: Number(r.leads),
    total_attempts: Number(r.total_attempts),
    connected: !NOT_CONNECTED_RE.test(r.disposition),
  }));
  const connectedLeads = dispositions
    .filter((d) => d.connected)
    .reduce((s, d) => s + d.leads, 0);
  const notConnectedLeads = dispositions
    .filter((d) => !d.connected)
    .reduce((s, d) => s + d.leads, 0);

  const fullTotals = {
    ...totals,
    connected_leads: connectedLeads,
    not_connected_leads: notConnectedLeads,
  };

  // ── Phone-call bookings list (Meeting Booked disposition, bucketed) ──────
  // mins_after_reply is signed: negative means the call happened BEFORE the
  // reply (anomaly — lead was in an earlier campaign, called for a different
  // reason, then later replied and was booked). UI shows these in ≥5min.
  const phoneBookingRows = await query<{
    id: string;
    external_id: string;
    name: string | null;
    email: string;
    phone: string | null;
    reply_at: string;
    call_at: string | null;
    mins_after_reply: string | null;
    call_attempts: string;
    call_disposition: string | null;
    sequencer_thread_url: string | null;
    within_5min: boolean | null;
  }>(
    `SELECT id::text                                                        AS id,
            external_id::text                                                AS external_id,
            name,
            email,
            phone,
            reply_at,
            call_at,
            CASE
              WHEN call_at IS NULL OR reply_at IS NULL THEN NULL
              ELSE ROUND((EXTRACT(EPOCH FROM (call_at - reply_at)) / 60.0)::numeric, 1)::text
            END                                                              AS mins_after_reply,
            COALESCE(call_attempts, 0)::text                                 AS call_attempts,
            call_disposition,
            sequencer_thread_url,
            CASE
              WHEN call_at IS NULL OR reply_at IS NULL THEN NULL
              WHEN call_at < reply_at THEN false
              ELSE EXTRACT(EPOCH FROM (call_at - reply_at)) <= 300
            END                                                              AS within_5min
       FROM gist.gtm_unified_db_source
      WHERE row_type = 'dialer'
        AND call_disposition ILIKE '%meeting booked%'
      ORDER BY reply_at DESC NULLS LAST`
  );
  const toBooking = (r: typeof phoneBookingRows[number]): PhoneBookingRow => ({
    id: r.id,
    external_id: r.external_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    reply_at: r.reply_at,
    call_at: r.call_at,
    mins_after_reply: r.mins_after_reply === null ? null : Number(r.mins_after_reply),
    call_attempts: Number(r.call_attempts),
    call_disposition: r.call_disposition,
    sequencer_thread_url: r.sequencer_thread_url,
  });
  const phone_bookings = {
    within_5min: phoneBookingRows.filter((r) => r.within_5min === true).map(toBooking),
    outside_5min: phoneBookingRows.filter((r) => r.within_5min !== true).map(toBooking),
  };

  const body: AnalyticsResponse = {
    tz,
    totals: fullTotals,
    by_day: cast(byDay),
    by_week: cast(byWeek),
    dispositions,
    phone_bookings,
  };
  return NextResponse.json(body);
}
