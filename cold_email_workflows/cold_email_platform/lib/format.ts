export type Tz = "IST" | "EST";

const TZ_TO_IANA: Record<Tz, string> = {
  IST: "Asia/Kolkata",
  EST: "America/New_York",
};

export function fmtTime(iso: string | null | undefined, tz: Tz = "IST"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    timeZone: TZ_TO_IANA[tz],
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Returns a URL that opens the JustCall web dialer with the number pre-filled.
 * Opens in a new tab.
 */
/** Normalize a phone string to E.164. If 10 digits, assume US (+1). */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) digits = "1" + digits; // assume US local → +1
  if (digits.length < 10) return null;
  return `+${digits}`;
}

export function dialerHref(phone: string | null | undefined): string | null {
  const e164 = toE164(phone);
  if (!e164) return null;
  return `https://app.justcall.io/dialer?numbers=${encodeURIComponent(e164)}`;
}

export function mailtoHref(
  email: string,
  subject?: string,
  body?: string
): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const qs = params.toString();
  return `mailto:${email}${qs ? "?" + qs : ""}`;
}
