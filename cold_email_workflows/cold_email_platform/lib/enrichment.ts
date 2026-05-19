// Phone enrichment helpers.

import { digitsOnly } from "./db";

const LM_URL = "https://api.leadmagic.io/phone-finder";
const FE_BASE = "https://app.fullenrich.com/api/v1";

export async function leadMagicPhone(
  linkedinUrl: string | null | undefined
): Promise<string | null> {
  if (!linkedinUrl) return null;
  const key = process.env.LEADMAGIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(LM_URL, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ profile_url: linkedinUrl }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { mobile_number?: string };
    return digitsOnly(data.mobile_number);
  } catch {
    return null;
  }
}

// ── FullEnrich bulk submit + poll ─────────────────────────────────────────────

type FeLead = {
  leadId: string;
  firstName?: string;
  lastName?: string;
  linkedinUrl?: string;
};

async function feSubmit(leads: FeLead[]): Promise<string | null> {
  const key = process.env.FULLENRICH_API_KEY;
  if (!key || leads.length === 0) return null;
  try {
    const res = await fetch(`${FE_BASE}/contact/enrich/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `icep_${Date.now()}`,
        datas: leads.map((l) => ({
          firstname: l.firstName ?? "",
          lastname: l.lastName ?? "",
          linkedin_url: l.linkedinUrl ?? "",
          custom: { lead_id: l.leadId },
          enrich_fields: ["contact.phones"],
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { enrichment_id?: string };
    return data.enrichment_id || null;
  } catch {
    return null;
  }
}

async function fePoll(
  enrichmentId: string
): Promise<{ done: boolean; phones: Map<string, string | null> }> {
  const key = process.env.FULLENRICH_API_KEY;
  if (!key) return { done: true, phones: new Map() };
  try {
    const res = await fetch(`${FE_BASE}/contact/enrich/bulk/${enrichmentId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { done: false, phones: new Map() };
    const data = (await res.json()) as {
      status?: string;
      datas?: Array<{
        custom?: { lead_id?: string };
        contact?: { phones?: Array<{ number?: string; e164?: string; phone?: string }> };
      }>;
    };
    // FullEnrich emits status="FINISHED" on success (some older docs/snippets
    // mention COMPLETED — accept both to be safe).
    if (data.status !== "FINISHED" && data.status !== "COMPLETED") {
      return { done: false, phones: new Map() };
    }
    const out = new Map<string, string | null>();
    for (const item of data.datas || []) {
      const leadId = item.custom?.lead_id;
      if (!leadId) continue;
      const p = item.contact?.phones?.[0];
      const phone = p?.number ?? p?.e164 ?? p?.phone ?? null;
      out.set(leadId, digitsOnly(phone));
    }
    return { done: true, phones: out };
  } catch {
    return { done: false, phones: new Map() };
  }
}

/**
 * Bulk-enrich leads via FullEnrich. Submits then polls every 5s up to `timeoutMs`.
 * Returns a Map<leadId, phone-or-null>. Leads not in the map = unresolved (timeout).
 */
export async function waitForFullEnrich(
  leads: FeLead[],
  timeoutMs = 60_000
): Promise<Map<string, string | null>> {
  if (leads.length === 0) return new Map();
  const id = await feSubmit(leads);
  if (!id) return new Map();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const { done, phones } = await fePoll(id);
    if (done) return phones;
  }
  return new Map();
}
