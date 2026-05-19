// EmailBison send helper.
// EmailBison's send-manual-email endpoint shape varies by instance; the call here
// follows the v1 /api/manual-emails contract documented on dedi.emailbison.com.
// If your Sequencer instance exposes a different path, adjust REQUEST_URL.

const BASE = (process.env.EMAILBISON_INSTANCE_URL || "https://sequencer.gushwork.ai").replace(/\/$/, "");
const REQUEST_URL = `${BASE}/api/manual-emails`;

export async function sendManualEmail(opts: {
  toEmail: string;
  subject: string;
  htmlBody: string;
  senderEmailId?: number; // EmailBison sender_email.id; required by the API
  leadId?: number;        // optional: links the send back to a lead
}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const key = process.env.EMAILBISON_API_KEY;
  if (!key) return { ok: false, status: 0, data: { error: "EMAILBISON_API_KEY not set" } };

  const res = await fetch(REQUEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      to_email: opts.toEmail,
      subject: opts.subject,
      html_body: opts.htmlBody,
      sender_email_id: opts.senderEmailId,
      lead_id: opts.leadId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}
