// Send an appointment-reminder SMS via JustCall.
// Called from the Reminder Table SMS button.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sendSms } from "@/lib/justcall";

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
    phone: string | null;
    demo_at: string;
  }>(
    `SELECT name, phone, demo_at
       FROM gist.gtm_unified_db_source
      WHERE id = $1 AND row_type = 'reminder'`,
    [body.reminder_id]
  );
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "row not found" }, { status: 404 });
  if (!row.phone) return NextResponse.json({ error: "no phone on row" }, { status: 400 });

  const firstName = (row.name || "there").split(" ")[0];
  const msg =
    `Hi ${firstName}, this is a reminder for your demo with Gushwork at ${fmtIst(row.demo_at)} IST today. ` +
    `Reply C to confirm or R to reschedule.`;

  const out = await sendSms(row.phone, msg);
  if (!out.ok) {
    return NextResponse.json(
      { error: "JustCall send failed", status: out.status, data: out.data },
      { status: 502 }
    );
  }
  return NextResponse.json({ status: "sent" });
}
