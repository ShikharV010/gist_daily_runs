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

export function dialerHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
  return `https://app.justcall.io/app/dialer?phone=${encodeURIComponent(e164)}`;
}
