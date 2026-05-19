"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import DialerTable from "./DialerTable";
import ReminderTable from "./ReminderTable";
import AnalyticsTab from "./AnalyticsTab";
import type { DialerRow, ReminderRow } from "@/lib/types";
import type { Tz } from "@/lib/format";

const POLL_MS = 10_000;
const TZ_STORAGE_KEY = "icep:tz";

const TZ_LABEL: Record<Tz, string> = {
  IST: "Asia/Kolkata",
  EST: "America/New_York",
};

export default function Dashboard() {
  const [dialer, setDialer] = useState<DialerRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [tz, setTz] = useState<Tz>("IST");

  // Restore tz preference from localStorage.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(TZ_STORAGE_KEY) : null;
    if (saved === "IST" || saved === "EST") setTz(saved);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(TZ_STORAGE_KEY, tz);
  }, [tz]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [d, r] = await Promise.all([
          fetch("/api/dialer-rows", { cache: "no-store" }).then((res) => res.json()),
          fetch("/api/reminder-rows", { cache: "no-store" }).then((res) => res.json()),
        ]);
        if (cancelled) return;
        setDialer(d.rows ?? []);
        setReminders(r.rows ?? []);
        setLastSync(new Date());
      } catch {
        // swallow — try again next tick
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8 w-full">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">In Cold Email Platform</h1>
          <p className="text-sm text-[color:var(--muted)]">
            Live dialing queue + appointment reminders
          </p>
        </div>
        <div className="flex items-center gap-3">
          <TzToggle value={tz} onChange={setTz} />
          <div className="text-xs text-[color:var(--muted)]">
            {lastSync
              ? `Last synced ${lastSync.toLocaleTimeString("en-IN", { timeZone: TZ_LABEL[tz] })}`
              : "Syncing…"}
          </div>
        </div>
      </header>

      <Tabs.Root defaultValue="dialer" className="w-full">
        <Tabs.List className="flex border-b border-[color:var(--border)] mb-4">
          <TabTrigger value="dialer" count={dialer.length}>
            5 min Dialing
          </TabTrigger>
          <TabTrigger value="reminders" count={reminders.length}>
            Appointment Reminders
          </TabTrigger>
          <TabTrigger value="analytics">Analytics</TabTrigger>
        </Tabs.List>
        <Tabs.Content value="dialer">
          <DialerTable rows={dialer} tz={tz} />
        </Tabs.Content>
        <Tabs.Content value="reminders">
          <ReminderTable rows={reminders} tz={tz} />
        </Tabs.Content>
        <Tabs.Content value="analytics">
          <AnalyticsTab tz={tz} />
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}

function TzToggle({ value, onChange }: { value: Tz; onChange: (tz: Tz) => void }) {
  return (
    <div className="inline-flex rounded border border-[color:var(--border)] overflow-hidden text-xs">
      {(["IST", "EST"] as Tz[]).map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-3 py-1 ${
            value === opt
              ? "bg-[color:var(--accent)] text-white"
              : "bg-transparent text-[color:var(--muted)] hover:bg-[color:var(--border)]/40"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function TabTrigger({
  value,
  children,
  count,
}: {
  value: string;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className="px-4 py-2 text-sm font-medium text-[color:var(--muted)] data-[state=active]:text-[color:var(--foreground)] data-[state=active]:border-b-2 data-[state=active]:border-[color:var(--accent)] -mb-px"
    >
      {children}
      {typeof count === "number" && (
        <span className="ml-2 text-xs text-[color:var(--muted)]">({count})</span>
      )}
    </Tabs.Trigger>
  );
}
