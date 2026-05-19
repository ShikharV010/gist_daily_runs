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

function e164(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

/**
 * Initiate an outbound call via JustCall click-to-call.
 * JustCall rings the agent's phone (agent_number) first, then bridges to contact.
 */
export async function initiateCall(
  toPhone: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const fromRaw = process.env.JUSTCALL_SMS_NUMBER;
  if (!fromRaw) {
    return {
      ok: false,
      status: 0,
      data: { error: "JUSTCALL_SMS_NUMBER env var not set" },
    };
  }
  const agent_number = e164(fromRaw);
  const contact_number = e164(toPhone);

  const res = await fetch(`${JC_BASE}/calls/initiate`, {
    method: "POST",
    headers: jcHeaders(),
    body: JSON.stringify({ agent_number, contact_number }),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
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
  const res = await fetch(`${JC_BASE}/texts/new`, {
    method: "POST",
    headers: jcHeaders(),
    body: JSON.stringify({
      justcall_number: e164(fromRaw),
      contact_number: e164(toPhone),
      body,
      restrict_once: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}
