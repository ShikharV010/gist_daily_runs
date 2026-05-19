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
export function dialerHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
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
