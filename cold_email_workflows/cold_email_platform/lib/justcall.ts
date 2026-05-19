// JustCall API helpers.

const JC_BASE = "https://api.justcall.io/v2.1";

function jcHeaders() {
  const auth = process.env.JUSTCALL_AUTHENTICATION; // "Bearer key:secret"
  if (!auth) throw new Error("JUSTCALL_AUTHENTICATION not set");
  return {
    Authorization: auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`,
    "Content-Type": "application/json",
  };
}

/** Build a JustCall web-dialer URL pre-filled with the phone number. */
export function dialerUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
  return `https://app.justcall.io/app/dialer?phone=${encodeURIComponent(e164)}`;
}

export async function sendSms(toPhone: string, body: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${JC_BASE}/texts/new`, {
    method: "POST",
    headers: jcHeaders(),
    body: JSON.stringify({
      contact_number: toPhone.startsWith("+") ? toPhone : `+${toPhone}`,
      body,
      restrict_once: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}
