// Shared-secret auth for webhooks + Vercel cron routes.

import { createHmac, timingSafeEqual } from "crypto";

export function verifyHmac(
  body: string,
  signatureHeader: string | null,
  secret: string | undefined
): boolean {
  if (!secret) return true; // no secret configured -> skip (dev mode)
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = signatureHeader.replace(/^sha256=/, "");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyCron(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  return authHeader === `Bearer ${secret}`;
}
