// Sequencer (EmailBison) webhook receiver.
// Cascade: custom_vars → LeadMagic → website scrape. (FullEnrich is skipped
// here because it polls 30–180s per call — too slow per-row in a webhook.)

import { NextRequest, NextResponse } from "next/server";
import { query, domainFromEmail } from "@/lib/db";
import { leadMagicPhone } from "@/lib/enrichment";
import { scrapePhoneFromWebsite } from "@/lib/scraper";
import { verifyHmac } from "@/lib/auth";
import {
  CustomVar,
  phoneFromCustomVars,
  linkedinFromCustomVars,
  customVar,
  threadUrl,
} from "@/lib/sequencer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type EmailBisonPayload = {
  event?: { type?: string; name?: string };
  data?: {
    reply?: {
      id?: number;
      uuid?: string;
      date_received?: string;
      created_at?: string;
    };
    lead?: {
      id?: number;
      email?: string;
      first_name?: string;
      last_name?: string;
      company?: string;
      title?: string;
      custom_variables?: CustomVar[];
    };
    campaign?: { id?: number; name?: string };
  };
};

type PhoneSource = "native" | "enrichment" | "website" | null;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig =
    req.headers.get("x-emailbison-signature") || req.headers.get("x-sequencer-signature");
  if (process.env.SEQUENCER_WEBHOOK_SECRET && sig) {
    if (!verifyHmac(raw, sig, process.env.SEQUENCER_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let body: EmailBisonPayload;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const eventType = body.event?.type || body.event?.name || "";
  if (!/interested/i.test(eventType)) {
    return NextResponse.json({ status: "ignored", event: eventType });
  }

  const lead = body.data?.lead;
  const reply = body.data?.reply;
  const campaign = body.data?.campaign;
  if (!lead?.id || !lead.email) {
    return NextResponse.json({ error: "missing lead.id or lead.email" }, { status: 400 });
  }

  const externalId = String(lead.id);
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || null;
  const email = lead.email;
  const domain = domainFromEmail(email);
  const company = lead.company || null;
  const website = customVar(lead.custom_variables, "website") || customVar(lead.custom_variables, "company_website") || null;

  const replyAtStr = reply?.date_received || reply?.created_at;
  const replyAt = replyAtStr ? new Date(replyAtStr) : new Date();
  const url = threadUrl({
    campaignId: campaign?.id,
    leadId: externalId,
    replyUuid: reply?.uuid,
  });

  // Cascade
  let phone: string | null = phoneFromCustomVars(lead.custom_variables);
  let phoneSource: PhoneSource = phone ? "native" : null;

  if (!phone) {
    const linkedin = linkedinFromCustomVars(lead.custom_variables);
    if (linkedin) {
      const p = await leadMagicPhone(linkedin);
      if (p) {
        phone = p;
        phoneSource = "enrichment";
      }
    }
  }

  if (!phone && website) {
    const p = await scrapePhoneFromWebsite(website);
    if (p) {
      phone = p;
      phoneSource = "website";
    }
  }

  const enrichmentStatus = phone ? "enriched" : "no_phone";

  const inserted = await query<{ id: string }>(
    `INSERT INTO gist.gtm_unified_db_source
       (row_type, external_id, name, company, website, email, domain, phone,
        phone_source, sequencer_thread_url, reply_at, enrichment_status)
     VALUES ('dialer', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (row_type, external_id) DO NOTHING
     RETURNING id`,
    [
      externalId,
      name,
      company,
      website,
      email,
      domain,
      phone,
      phoneSource,
      url,
      replyAt.toISOString(),
      enrichmentStatus,
    ]
  );

  return NextResponse.json({
    status: inserted.length ? "inserted" : "duplicate",
    lead_id: externalId,
    phone_found: Boolean(phone),
    phone_source: phoneSource,
    enrichment_status: enrichmentStatus,
  });
}
