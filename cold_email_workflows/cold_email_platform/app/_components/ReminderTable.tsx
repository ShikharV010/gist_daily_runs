"use client";

import { Mail, MessageSquare, Phone } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtTime, type Tz } from "@/lib/format";
import {
  REMINDER_STATUS_OPTIONS,
  type ReminderRow,
  type ReminderStatus,
} from "@/lib/types";
import { PhoneSourceBadge } from "./DialerTable";

export default function ReminderTable({ rows, tz }: { rows: ReminderRow[]; tz: Tz }) {
  const stats = useMemo(() => {
    const total = rows.length;
    const confirmed = rows.filter((r) => r.status === "Confirmed").length;
    const cancelled = rows.filter((r) => r.status === "Cancelled").length;
    return { total, confirmed, cancelled };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Bookings Today" value={stats.total} tone="neutral" />
        <StatCard label="Confirmed" value={stats.confirmed} tone="success" />
        <StatCard label="Cancelled" value={stats.cancelled} tone="danger" />
      </div>

      <div className="overflow-x-auto border border-[color:var(--border)] rounded">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--border)]/30 text-left text-xs uppercase tracking-wide">
            <Headers />
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-sm text-[color:var(--muted)]">
                  No bookings for today yet. This list refreshes at 6 PM IST.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
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
                        <CallBtn row={r} />
                        <SmsBtn row={r} />
                        <EmailBtn row={r} />
                      </div>
                      <PhoneSourceBadge source={r.phone_source} />
                    </div>
                  </Td>
                  <Td>{r.call_attempts || 0}</Td>
                  <Td>
                    <StatusDropdown row={r} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Headers() {
  return (
    <tr>
      <Th>Name</Th>
      <Th>Company</Th>
      <Th>Website</Th>
      <Th>Reply</Th>
      <Th>Demo</Th>
      <Th>Actions</Th>
      <Th>Attempts</Th>
      <Th>Status</Th>
    </tr>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "success" | "danger";
}) {
  const cls =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "danger"
      ? "border-red-200 bg-red-50"
      : "border-[color:var(--border)] bg-white";
  return (
    <div className={`border rounded p-4 ${cls}`}>
      <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value.toLocaleString()}</div>
    </div>
  );
}

function CallBtn({ row }: { row: ReminderRow }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "ringing" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (!row.phone) return <span className="text-xs text-[color:var(--muted)]">no phone</span>;

  async function placeCall() {
    setBusy(true);
    setErrMsg(null);
    try {
      const res = await fetch("/api/actions/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_id: row.id }),
      });
      if (res.ok) {
        setStatus("ringing");
        setTimeout(() => setStatus("idle"), 4000);
      } else {
        const j = await res.json().catch(() => ({}));
        setStatus("error");
        setErrMsg(j?.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : "call failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={placeCall}
      disabled={busy}
      title={errMsg ? `Call error: ${errMsg}` : "Initiate JustCall (rings Allaine first)"}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-50 ${
        status === "ringing"
          ? "bg-[color:var(--success)] text-white"
          : status === "error"
          ? "bg-red-100 text-red-700"
          : "bg-[color:var(--accent)] text-white hover:opacity-90"
      }`}
    >
      <Phone size={14} />
    </button>
  );
}

function SmsBtn({ row }: { row: ReminderRow }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  if (!row.phone) return null;

  async function send() {
    setBusy(true);
    setErrMsg(null);
    try {
      const res = await fetch("/api/actions/sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminder_id: row.id }),
      });
      if (res.ok) {
        setStatus("sent");
      } else {
        const j = await res.json().catch(() => ({}));
        setStatus("error");
        setErrMsg(j?.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : "send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={send}
      disabled={busy}
      title={errMsg ? `SMS error: ${errMsg}` : "Send reminder SMS via JustCall"}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-50 ${
        status === "sent"
          ? "bg-[color:var(--success)] text-white"
          : status === "error"
          ? "bg-red-100 text-red-700"
          : "bg-[color:var(--border)] text-[color:var(--foreground)] hover:bg-[color:var(--border)]/80"
      }`}
    >
      <MessageSquare size={14} />
    </button>
  );
}

function EmailBtn({ row }: { row: ReminderRow }) {
  if (!row.sequencer_thread_url) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-[color:var(--border)]/40 text-[color:var(--muted)]">
        <Mail size={14} />
      </span>
    );
  }
  return (
    <a
      href={row.sequencer_thread_url}
      target="_blank"
      rel="noreferrer"
      title="Open Sequencer conversation"
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-[color:var(--border)] text-[color:var(--foreground)] hover:bg-[color:var(--border)]/80"
    >
      <Mail size={14} />
    </a>
  );
}

function StatusDropdown({ row }: { row: ReminderRow }) {
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
