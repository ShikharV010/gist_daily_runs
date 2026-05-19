import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { REMINDER_STATUS_OPTIONS, type ReminderStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    reminder_id?: string;
    status?: string;
  };
  if (!body.reminder_id || !body.status) {
    return NextResponse.json({ error: "reminder_id and status required" }, { status: 400 });
  }
  if (!REMINDER_STATUS_OPTIONS.includes(body.status as ReminderStatus)) {
    return NextResponse.json({ error: "invalid status value" }, { status: 400 });
  }

  const updated = await query<{ id: string }>(
    `UPDATE gist.gtm_unified_db_source
        SET status = $1
      WHERE id = $2 AND row_type = 'reminder'
      RETURNING id`,
    [body.status, body.reminder_id]
  );
  if (updated.length === 0) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  return NextResponse.json({ status: "ok" });
}
