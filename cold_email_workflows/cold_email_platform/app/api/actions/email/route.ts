// Send an appointment-reminder email via EmailBison (Sequencer).
// Called from the Reminder Table Email button.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sendManualEmail } from "@/lib/emailbison";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

function fmtIst(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { reminder_id?: string };
  if (!body.reminder_id) {
    return NextResponse.json({ error: "reminder_id required" }, { status: 400 });
  }

  const rows = await query<{
    name: string | null;
    email: string;
    demo_at: string;
  }>(
    `SELECT name, email, demo_at
       FROM gist.gtm_unified_db_source
      WHERE id = $1 AND row_type = 'reminder'`,
    [body.reminder_id]
  );
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "row not found" }, { status: 404 });

  const firstName = (row.name || "there").split(" ")[0];
  const timeStr = `${fmtIst(row.demo_at)} IST`;
  const subject = `Reminder: Your Gushwork demo today at ${timeStr}`;
  const htmlBody = `
    <p>Hi ${firstName},</p>
    <p>Quick reminder that your demo with Gushwork is scheduled for <strong>${timeStr}</strong> today.</p>
    <p>If anything changes, just reply to this email and we'll reschedule.</p>
    <p>Talk soon!<br/>Gushwork</p>
  `;

  const senderId = process.env.EMAILBISON_DEFAULT_SENDER_ID
    ? Number(process.env.EMAILBISON_DEFAULT_SENDER_ID)
    : undefined;

  const out = await sendManualEmail({
    toEmail: row.email,
    subject,
    htmlBody,
    senderEmailId: senderId,
  });
  if (!out.ok) {
    return NextResponse.json(
      { error: "EmailBison send failed", status: out.status, data: out.data },
      { status: 502 }
    );
  }
  return NextResponse.json({ status: "sent" });
}
