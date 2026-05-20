// Standalone enrichment cascade for a single lead.
// Usage: node scripts/enrich_lead.mjs <email> [<linkedin_url>] [<first_name>] [<last_name>] [<website>]
//
// Reads keys from /Users/.../projects/.env

import fs from "node:fs";
import path from "node:path";

const ENV_PATH = "/Users/shikhar.vermagushwork.ai/Documents/claude/projects/.env";

function loadEnv() {
  const txt = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const [email, cliLinkedin, cliFirst, cliLast, cliWebsite] = process.argv.slice(2);
if (!email) {
  console.error("Usage: node scripts/enrich_lead.mjs <email> [<linkedin>] [<first>] [<last>] [<website>]");
  process.exit(1);
}

function digitsOnly(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, "");
  return d || null;
}

const SEQ_BASE = process.env.SEQUENCER_BASE_URL || "https://sequencer.gushwork.ai/api";
const SEQ_KEY = process.env.SEQUENCER_API_KEY;
const LM_KEY = process.env.LEADMAGIC_API_KEY;
const FE_KEY = process.env.FULLENRICH_API_KEY;

async function sequencerLeadByEmail(email) {
  try {
    const url = new URL(`${SEQ_BASE}/leads`);
    url.searchParams.set("search", email);
    url.searchParams.set("per_page", "5");
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${SEQ_KEY}`, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const items = j.data || [];
    const target = items.find(
      (l) => (l.email || "").toLowerCase() === email.toLowerCase()
    );
    if (!target?.id) return null;
    const r2 = await fetch(`${SEQ_BASE}/leads/${target.id}`, {
      headers: { Authorization: `Bearer ${SEQ_KEY}`, Accept: "application/json" },
    });
    if (!r2.ok) return target;
    const j2 = await r2.json();
    return j2.data || target;
  } catch (e) {
    console.error("[sequencer]", e.message);
    return null;
  }
}

async function leadMagic(linkedin) {
  try {
    const r = await fetch("https://api.leadmagic.io/phone-finder", {
      method: "POST",
      headers: { "X-API-Key": LM_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ profile_url: linkedin }),
    });
    const txt = await r.text();
    console.log(`  [LeadMagic] ${r.status}: ${txt.slice(0, 200)}`);
    if (!r.ok) return null;
    const j = JSON.parse(txt);
    return digitsOnly(j.mobile_number);
  } catch (e) {
    console.error("[leadmagic]", e.message);
    return null;
  }
}

async function fullEnrich(firstName, lastName, linkedin) {
  const submit = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
    method: "POST",
    headers: { Authorization: `Bearer ${FE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `oneoff_${Date.now()}`,
      datas: [
        {
          firstname: firstName || "",
          lastname: lastName || "",
          linkedin_url: linkedin || "",
          custom: { lead_id: "X" },
          enrich_fields: ["contact.phones"],
        },
      ],
    }),
  });
  const sj = await submit.json();
  console.log(`  [FullEnrich submit] ${submit.status}: ${JSON.stringify(sj).slice(0, 200)}`);
  const id = sj.enrichment_id;
  if (!id) return null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const p = await fetch(`https://app.fullenrich.com/api/v1/contact/enrich/bulk/${id}`, {
      headers: { Authorization: `Bearer ${FE_KEY}` },
    });
    const pj = await p.json();
    process.stdout.write(`.`);
    if (pj.status === "FINISHED" || pj.status === "COMPLETED") {
      const item = (pj.datas || [])[0];
      const c = item?.contact;
      const phone =
        c?.most_probable_phone ||
        c?.phones?.[0]?.number ||
        c?.phones?.[0]?.e164 ||
        null;
      console.log("");
      return digitsOnly(phone);
    }
  }
  console.log("\n  [FullEnrich] timed out");
  return null;
}

async function scrapeWebsite(websiteRaw) {
  if (!websiteRaw || /(instagram|facebook|linkedin|twitter|x\.com|tiktok|youtube)\./i.test(websiteRaw)) return null;
  const url = /^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const tel = html.match(/href\s*=\s*["']tel:([^"']+)["']/i);
    if (tel) {
      const d = digitsOnly(tel[1]);
      if (d && d.length >= 10) return d;
    }
    const patterns = [
      /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/,
      /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/,
      /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        const d = digitsOnly(m[0]);
        if (d && d.length >= 10 && d.length <= 15) return d;
      }
    }
    return null;
  } catch (e) {
    console.error("[scrape]", e.message);
    return null;
  }
}

// ── Run cascade ──────────────────────────────────────────────────────────────
console.log(`Enriching ${email}\n`);

console.log("1. Sequencer lookup…");
const lead = await sequencerLeadByEmail(email);
if (lead) {
  console.log(`   Found lead id=${lead.id} name="${lead.first_name || ""} ${lead.last_name || ""}" company="${lead.company || ""}"`);
} else {
  console.log("   not found");
}

const cvars = lead?.custom_variables || [];
const cvar = (name) =>
  cvars.find((v) => (v.name || "").toLowerCase().trim() === name.toLowerCase())?.value;

let phone =
  digitsOnly(cvar("phone number")) ||
  digitsOnly(cvar("phone")) ||
  digitsOnly(cvar("mobile")) ||
  digitsOnly(cvar("mobile_number")) ||
  null;
if (phone) {
  console.log(`   ✓ phone in custom_variables: +${phone}`);
}

const linkedin =
  cliLinkedin ||
  cvar("linkedin") ||
  cvar("linkedin_url") ||
  cvars.find((v) => /linkedin/i.test(v.name || ""))?.value ||
  null;

const firstName = cliFirst || lead?.first_name || null;
const lastName = cliLast || lead?.last_name || null;
const website = cliWebsite || `${email.split("@")[1]}`;

console.log(`\n   linkedin=${linkedin || "(none)"}`);
console.log(`   first=${firstName} last=${lastName} website=${website}\n`);

if (!phone && linkedin) {
  console.log("2. LeadMagic…");
  phone = await leadMagic(linkedin);
  if (phone) console.log(`   ✓ phone via LeadMagic: +${phone}\n`);
}

if (!phone && linkedin) {
  console.log("3. FullEnrich…");
  phone = await fullEnrich(firstName, lastName, linkedin);
  if (phone) console.log(`   ✓ phone via FullEnrich: +${phone}\n`);
}

if (!phone) {
  console.log(`4. Scraping ${website}…`);
  phone = await scrapeWebsite(website);
  if (phone) console.log(`   ✓ phone via website scrape: +${phone}\n`);
}

console.log("---");
if (phone) {
  console.log(`RESULT: +${phone}`);
} else {
  console.log(`RESULT: no phone found through any source`);
}
