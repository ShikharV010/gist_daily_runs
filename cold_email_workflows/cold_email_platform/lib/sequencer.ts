// Sequencer (EmailBison white-labeled) helpers.

import { digitsOnly } from "./db";

const BASE = process.env.SEQUENCER_BASE_URL || "https://sequencer.gushwork.ai/api";
const PUBLIC_BASE = BASE.replace(/\/api\/?$/, "");

export type CustomVar = { name?: string; value?: string };

export function phoneFromCustomVars(vars: CustomVar[] | undefined): string | null {
  if (!vars) return null;
  for (const v of vars) {
    const key = (v.name || "").toLowerCase().trim();
    if (
      key === "phone number" ||
      key === "phone" ||
      key === "mobile" ||
      key === "phone_number" ||
      key === "mobile_number"
    ) {
      const d = digitsOnly(v.value);
      if (d) return d;
    }
  }
  return null;
}

export function linkedinFromCustomVars(vars: CustomVar[] | undefined): string | null {
  if (!vars) return null;
  for (const v of vars) {
    const key = (v.name || "").toLowerCase().trim();
    if (key.includes("linkedin")) {
      return (v.value || "").trim() || null;
    }
  }
  return null;
}

export function customVar(vars: CustomVar[] | undefined, name: string): string | null {
  if (!vars) return null;
  const target = name.toLowerCase().trim();
  for (const v of vars) {
    if ((v.name || "").toLowerCase().trim() === target) {
      return (v.value || "").trim() || null;
    }
  }
  return null;
}

export function threadUrl(opts: {
  campaignId?: number | string;
  leadId?: number | string;
  replyUuid?: string;
}): string | null {
  // Gushwork Sequencer inbox URL format: /inbox/replies/{reply_uuid}.
  if (opts.replyUuid) {
    return `${PUBLIC_BASE}/inbox/replies/${opts.replyUuid}`;
  }
  return null;
}

// ── Lookup lead by email (for reminder enrichment) ────────────────────────────

type SeqLeadSummary = {
  id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
};

type SeqLeadFull = SeqLeadSummary & {
  custom_variables?: CustomVar[];
};

function seqHeaders() {
  const token = process.env.SEQUENCER_API_KEY;
  if (!token) throw new Error("SEQUENCER_API_KEY not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Look up a lead in Sequencer by email and return its full record (including
 * custom_variables, where phone + linkedin often live). Returns null if not found.
 */
export async function lookupLeadByEmail(email: string): Promise<SeqLeadFull | null> {
  try {
    const url = new URL(`${BASE}/leads`);
    url.searchParams.set("search", email);
    url.searchParams.set("per_page", "5");
    const res = await fetch(url.toString(), {
      headers: seqHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: SeqLeadSummary[] };
    const target = (data.data || []).find(
      (l) => (l.email || "").toLowerCase() === email.toLowerCase()
    );
    if (!target?.id) return null;

    const detailRes = await fetch(`${BASE}/leads/${target.id}`, {
      headers: seqHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!detailRes.ok) return target as SeqLeadFull;
    const detailJson = (await detailRes.json()) as { data?: SeqLeadFull };
    return detailJson.data || (target as SeqLeadFull);
  } catch {
    return null;
  }
}
