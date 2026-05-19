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

export async function sendSms(
  toPhone: string,
  body: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const fromRaw = process.env.JUSTCALL_SMS_NUMBER;
  if (!fromRaw) {
    return {
      ok: false,
      status: 0,
      data: { error: "JUSTCALL_SMS_NUMBER env var not set" },
    };
  }
  const justcall_number = fromRaw.startsWith("+") ? fromRaw : `+${fromRaw}`;
  const contact_number = toPhone.startsWith("+") ? toPhone : `+${toPhone}`;

  const res = await fetch(`${JC_BASE}/texts/new`, {
    method: "POST",
    headers: jcHeaders(),
    body: JSON.stringify({
      justcall_number,
      contact_number,
      body,
      restrict_once: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}
