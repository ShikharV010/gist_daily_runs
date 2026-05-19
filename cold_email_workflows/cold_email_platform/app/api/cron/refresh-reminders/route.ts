// Cron: daily at 6PM IST (= 12:30 UTC). Rebuilds reminder rows from today's
// gist.gtm_inbound_demo_bookings where source IN the Gushwork-email sources.
//
// For each booking that has no phone in the bookings table, runs the cascade:
//   Sequencer lookup → LeadMagic → FullEnrich (bulk) → website scrape
//
// Scheduled in vercel.json: "30 12 * * *"

import { NextRequest, NextResponse } from "next/server";
import { query, digitsOnly, domainFromEmail } from "@/lib/db";
import { verifyCron } from "@/lib/auth";
import { lookupLeadByEmail, phoneFromCustomVars, linkedinFromCustomVars } from "@/lib/sequencer";
import { leadMagicPhone, waitForFullEnrich } from "@/lib/enrichment";
import { scrapePhoneFromWebsite } from "@/lib/scraper";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SOURCES = ["Gushwork Email", "Gushwork Email(Allaine)", "Emails from Gushwork"];
const DEFAULT_STATUS = "Not yet dialed";

type Booking = {
  prospect_first_name: string | null;
  prospect_email: string;
  prospect_phone_number: string | null;
  prospect_company: string | null;
  prospect_website: string | null;
  start_time_utc: string;          // canonical demo time (UTC)
  attendee_time_zone: string | null;
  source: string;
};

type PhoneSource = "native" | "enrichment" | "website" | null;

type Enriched = {
  email: string;
  bookingRow: Booking;
  phone: string | null;
  phoneSource: PhoneSource;
  linkedin: string | null;
  firstName: string | null;
  lastName: string | null;
};

async function inParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return out;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 1) Today's bookings
  const bookings = await query<Booking>(
    `
    SELECT prospect_first_name,
           prospect_email,
           prospect_phone_number,
           prospect_company,
           prospect_website,
           start_time_utc,
           attendee_time_zone,
           source
    FROM gist.gtm_inbound_demo_bookings
    WHERE is_latest = true
      AND source = ANY($1::text[])
      AND prospect_email LIKE '%@%'
      AND start_time_utc IS NOT NULL
      AND (start_time_utc AT TIME ZONE 'Asia/Kolkata')::date
          = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    `,
    [SOURCES]
  );

  // 2) Seed with native phones; mark which need enrichment
  const enriched: Enriched[] = bookings.map((b) => {
    const email = (b.prospect_email || "").trim().toLowerCase();
    const native = digitsOnly(b.prospect_phone_number);
    return {
      email,
      bookingRow: b,
      phone: native,
      phoneSource: native ? ("native" as PhoneSource) : null,
      linkedin: null,
      firstName: b.prospect_first_name,
      lastName: null,
    };
  });

  // 3) For rows without a phone: lookup the lead in Sequencer (in parallel)
  //    to get LinkedIn URL (for LeadMagic/FullEnrich) and possibly a phone
  //    from custom_variables.
  const needLookup = enriched.filter((e) => !e.phone && e.email);
  await inParallel(needLookup, 8, async (e) => {
    const lead = await lookupLeadByEmail(e.email);
    if (!lead) return;
    // Only pull names from Sequencer if bookings didn't give us one — the
    // bookings prospect_first_name often already contains the full name.
    if (!e.firstName) {
      e.firstName = lead.first_name || null;
      e.lastName = lead.last_name || null;
    }
    const seqPhone = phoneFromCustomVars(lead.custom_variables);
    if (seqPhone) {
      e.phone = seqPhone;
      e.phoneSource = "native"; // Sequencer custom_vars = native field
      return;
    }
    e.linkedin = linkedinFromCustomVars(lead.custom_variables);
  });

  // 4) LeadMagic for rows with LinkedIn and still no phone (parallel)
  const needLM = enriched.filter((e) => !e.phone && e.linkedin);
  await inParallel(needLM, 6, async (e) => {
    const p = await leadMagicPhone(e.linkedin!);
    if (p) {
      e.phone = p;
      e.phoneSource = "enrichment";
    }
  });

  // 5) FullEnrich bulk for remaining rows that have LinkedIn
  const needFE = enriched.filter((e) => !e.phone && e.linkedin);
  if (needFE.length > 0) {
    const map = await waitForFullEnrich(
      needFE.map((e) => ({
        leadId: e.email,
        firstName: e.firstName ?? "",
        lastName: e.lastName ?? "",
        linkedinUrl: e.linkedin!,
      })),
      90_000
    );
    for (const e of needFE) {
      const p = map.get(e.email);
      if (p) {
        e.phone = p;
        e.phoneSource = "enrichment";
      }
    }
  }

  // 6) Website scrape for anything still without a phone (parallel)
  const needScrape = enriched.filter(
    (e) => !e.phone && e.bookingRow.prospect_website
  );
  await inParallel(needScrape, 6, async (e) => {
    const p = await scrapePhoneFromWebsite(e.bookingRow.prospect_website);
    if (p) {
      e.phone = p;
      e.phoneSource = "website";
    }
  });

  // 7) Wipe reminder rows, then insert
  await query(`DELETE FROM gist.gtm_unified_db_source WHERE row_type = 'reminder'`);

  const sourceCounts = { native: 0, enrichment: 0, website: 0, none: 0 };
  for (const e of enriched) {
    if (!e.email) continue;
    const b = e.bookingRow;
    const demoIso = new Date(b.start_time_utc).toISOString();
    const externalId = `${e.email}__${demoIso}`;
    const name =
      [e.firstName || "", e.lastName || ""].filter(Boolean).join(" ").trim() || null;
    const domain = domainFromEmail(e.email);

    await query(
      `INSERT INTO gist.gtm_unified_db_source
         (row_type, external_id, name, company, website, email, domain, phone,
          phone_source, demo_at, source, status, enrichment_status, refreshed_at)
       VALUES ('reminder', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       ON CONFLICT (row_type, external_id) DO UPDATE SET
         name = EXCLUDED.name,
         company = EXCLUDED.company,
         website = EXCLUDED.website,
         phone = EXCLUDED.phone,
         phone_source = EXCLUDED.phone_source,
         demo_at = EXCLUDED.demo_at,
         source = EXCLUDED.source,
         refreshed_at = NOW()`,
      [
        externalId,
        name,
        b.prospect_company || null,
        b.prospect_website || null,
        e.email,
        domain,
        e.phone,
        e.phoneSource,
        demoIso,
        b.source,
        DEFAULT_STATUS,
        e.phone ? "enriched" : "no_phone",
      ]
    );

    if (e.phoneSource === "native") sourceCounts.native++;
    else if (e.phoneSource === "enrichment") sourceCounts.enrichment++;
    else if (e.phoneSource === "website") sourceCounts.website++;
    else sourceCounts.none++;
  }

  return NextResponse.json({
    status: "ok",
    today_bookings: bookings.length,
    inserted: enriched.length,
    by_phone_source: sourceCounts,
  });
}
