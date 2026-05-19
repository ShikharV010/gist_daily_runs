"use client";

import { Check, Phone } from "lucide-react";
import { useState } from "react";
import { fmtTime, type Tz } from "@/lib/format";
import type { DialerRow } from "@/lib/types";

export default function DialerTable({ rows, tz }: { rows: DialerRow[]; tz: Tz }) {
  return (
    <div className="overflow-x-auto border border-[color:var(--border)] rounded">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--border)]/30 text-left text-xs uppercase tracking-wide">
          <tr>
            <Th>Name</Th>
            <Th>Company</Th>
            <Th>Website</Th>
            <Th>Reply</Th>
            <Th>Time of Reply</Th>
            <Th>Time of Call</Th>
            <Th>Call</Th>
            <Th>{"Call < 5 min"}</Th>
            <Th>Attempts</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-3 py-12 text-center text-sm text-[color:var(--muted)]">
                No positive replies yet. Rows appear here as Sequencer fires the
                Contact Interested webhook.
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
                <Td className="whitespace-nowrap">{fmtTime(r.reply_at, tz)}</Td>
                <Td className="whitespace-nowrap">{fmtTime(r.call_at, tz)}</Td>
                <Td>
                  <CallCell row={r} />
                </Td>
                <Td>
                  {r.call_within_5min ? (
                    <Check className="text-[color:var(--success)]" size={18} />
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{r.call_attempts || 0}</Td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function CallCell({ row }: { row: DialerRow }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "ringing" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (!row.phone) {
    return <span className="text-xs text-[color:var(--muted)]">no phone</span>;
  }

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
    <div className="flex items-center gap-2">
      <button
        onClick={placeCall}
        disabled={busy}
        title={errMsg ? `Call error: ${errMsg}` : "Initiate JustCall (rings Allaine first)"}
        className={`inline-flex items-center gap-1 px-3 py-1 rounded text-xs disabled:opacity-50 ${
          status === "ringing"
            ? "bg-[color:var(--success)] text-white"
            : status === "error"
            ? "bg-red-100 text-red-700"
            : "bg-[color:var(--accent)] text-white hover:opacity-90"
        }`}
      >
        <Phone size={14} /> {status === "ringing" ? "Ringing…" : "Call"}
      </button>
      <PhoneSourceBadge source={row.phone_source} />
    </div>
  );
}

export function PhoneSourceBadge({
  source,
}: {
  source: DialerRow["phone_source"];
}) {
  if (!source) return null;
  const label =
    source === "native" ? "native" : source === "enrichment" ? "enriched" : "web";
  const cls =
    source === "native"
      ? "bg-emerald-100 text-emerald-700"
      : source === "enrichment"
      ? "bg-blue-100 text-blue-700"
      : "bg-amber-100 text-amber-700";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
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
