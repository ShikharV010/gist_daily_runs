// Last-resort phone enrichment by scraping the company website homepage.

import { digitsOnly } from "./db";

const SKIP_HOSTS = [
  "instagram.com",
  "facebook.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
];

function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.toLowerCase() === "none") return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.toString();
  } catch {
    return null;
  }
}

function isSkippableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return true;
  }
}

/**
 * Pull a phone number out of html. Looks at tel: anchors first, then common
 * phone-number text patterns. Returns digits-only or null.
 */
function extractPhone(html: string): string | null {
  // 1) tel: links — most reliable
  const telMatch = html.match(/href\s*=\s*["']tel:([^"']+)["']/i);
  if (telMatch) {
    const d = digitsOnly(telMatch[1]);
    if (d && d.length >= 10) return d;
  }

  // 2) text-form phone patterns. Order matters: more specific first.
  const patterns = [
    /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/, // +91 (98) 7654 3210
    /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/,                          // (415) 555-1234
    /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/,                            // 415-555-1234
    /\b\d{10}\b/,                                                  // 4155551234
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const d = digitsOnly(m[0]);
      if (d && d.length >= 10 && d.length <= 15) return d;
    }
  }
  return null;
}

/**
 * Fetch the homepage of `websiteRaw` and try to extract a phone number from it.
 * Returns digits-only string or null. Skips social media URLs.
 */
export async function scrapePhoneFromWebsite(
  websiteRaw: string | null | undefined
): Promise<string | null> {
  const url = normalizeUrl(websiteRaw);
  if (!url) return null;
  if (isSkippableHost(url)) return null;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractPhone(html);
  } catch {
    return null;
  }
}
