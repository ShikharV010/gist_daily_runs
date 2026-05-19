"use client";

import { Mail, MessageSquare, Phone } from "lucide-react";
import { useState } from "react";
import { fmtTime, dialerHref, type Tz } from "@/lib/format";
import {
  REMINDER_STATUS_OPTIONS,
  type ReminderRow,
  type ReminderStatus,
} from "@/lib/types";
import { PhoneSourceBadge } from "./DialerTable";

export default function ReminderTable({ rows, tz }: { rows: ReminderRow[]; tz: Tz }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-[color:var(--muted)] py-12 text-center border border-dashed border-[color:var(--border)] rounded">
        No bookings for today yet. This list refreshes at 6 PM IST.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border border-[color:var(--border)] rounded">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--border)]/30 text-left text-xs uppercase tracking-wide">
          <tr>
            <Th>Name</Th>
            <Th>Company</Th>
            <Th>Website</Th>
            <Th>Reply</Th>
            <Th>Demo</Th>
            <Th>Actions</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[color:var(--border)]">
              <Td>{r.name || r.email}</Td>
              <Td>{r.company || "—"}</Td>
              <Td>
                {r.website ? (
                  <a
                    href={normalizeUrl(r.website)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[color:var(--accent)] hover:underline"
                  >
                    {r.website}
                  </a>
                ) : (
                  "—"
                )}
              </Td>
              <Td>
                {r.sequencer_thread_url ? (
                  <a
                    href={r.sequencer_thread_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[color:var(--accent)] hover:underline"
                  >
                    View reply
                  </a>
                ) : (
                  "—"
                )}
              </Td>
              <Td className="whitespace-nowrap">{fmtTime(r.demo_at, tz)}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <CallBtn phone={r.phone} />
                    <SmsBtn row={r} />
                    <EmailBtn row={r} />
                  </div>
                  <PhoneSourceBadge source={r.phone_source} />
                </div>
              </Td>
              <Td>
                <StatusDropdown row={r} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallBtn({ phone }: { phone: string | null }) {
  const href = dialerHref(phone);
  if (!href) return <span className="text-xs text-[color:var(--muted)]">no phone</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Call via JustCall"
      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[color:var(--accent)] text-white text-xs hover:opacity-90"
    >
      <Phone size={14} />
    </a>
  );
}

function SmsBtn({ row }: { row: ReminderRow }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  if (!row.phone) return null;
  async function send() {
    setBusy(true);
    try {
      const res = await fetch("/api/actions/sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminder_id: row.id }),
      });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={send}
      disabled={busy}
      title="Send reminder SMS via JustCall"
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
        status === "sent"
          ? "bg-[color:var(--success)] text-white"
          : "bg-[color:var(--border)] text-[color:var(--foreground)] hover:bg-[color:var(--border)]/80"
      } disabled:opacity-50`}
    >
      <MessageSquare size={14} />
    </button>
  );
}

function EmailBtn({ row }: { row: ReminderRow }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  async function send() {
    setBusy(true);
    try {
      const res = await fetch("/api/actions/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminder_id: row.id }),
      });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={send}
      disabled={busy}
      title="Send reminder email via EmailBison"
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
        status === "sent"
          ? "bg-[color:var(--success)] text-white"
          : "bg-[color:var(--border)] text-[color:var(--foreground)] hover:bg-[color:var(--border)]/80"
      } disabled:opacity-50`}
    >
      <Mail size={14} />
    </button>
  );
}

function StatusDropdown({ row }: { row: ReminderRow }) {
  // Optimistic local state so the UI reflects the change before the poll re-fetches.
  const [value, setValue] = useState<ReminderStatus>(
    (row.status as ReminderStatus) || "Not yet dialed"
  );
  const [saving, setSaving] = useState(false);

  async function change(next: ReminderStatus) {
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await fetch("/api/actions/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminder_id: row.id, status: next }),
      });
      if (!res.ok) setValue(prev);
    } catch {
      setValue(prev);
    } finally {
      setSaving(false);
    }
  }

  const tone =
    value === "Confirmed"
      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
      : value === "Cancelled"
      ? "bg-red-50 text-red-700 border-red-300"
      : value === "Rescheduled"
      ? "bg-amber-50 text-amber-700 border-amber-300"
      : value === "Not Connected"
      ? "bg-slate-100 text-slate-700 border-slate-300"
      : "bg-white text-[color:var(--foreground)] border-[color:var(--border)]";

  return (
    <select
      value={value}
      onChange={(e) => change(e.target.value as ReminderStatus)}
      disabled={saving}
      className={`text-xs px-2 py-1 rounded border outline-none ${tone} disabled:opacity-50`}
    >
      {REMINDER_STATUS_OPTIONS.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium text-[color:var(--muted)]">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}

function normalizeUrl(s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}
