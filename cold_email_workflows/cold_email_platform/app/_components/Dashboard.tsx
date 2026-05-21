"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import DialerTable from "./DialerTable";
import ReminderTable from "./ReminderTable";
import AnalyticsTab from "./AnalyticsTab";
import type { DialerRow, ReminderRow } from "@/lib/types";
import type { Tz } from "@/lib/format";
import { ensureNotifPermission, notifyNewLead, preloadChime } from "@/lib/notify";

type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "icep:theme";

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
  const [theme, setTheme] = useState<Theme>("light");

  // Restore tz + theme prefs from localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedTz = window.localStorage.getItem(TZ_STORAGE_KEY);
    if (savedTz === "IST" || savedTz === "EST") setTz(savedTz);
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(TZ_STORAGE_KEY, tz);
  }, [tz]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Track which dialer rows we've already seen so we only chime on truly new ones.
  const seenDialerIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [d, r] = await Promise.all([
          fetch("/api/dialer-rows", { cache: "no-store" }).then((res) => res.json()),
          fetch("/api/reminder-rows", { cache: "no-store" }).then((res) => res.json()),
        ]);
        if (cancelled) return;
        const dialerRows: DialerRow[] = d.rows ?? [];
        setDialer(dialerRows);
        setReminders(r.rows ?? []);
        setLastSync(new Date());

        // Notify on new dialer rows (skip the first poll — those are pre-existing).
        if (seenDialerIds.current === null) {
          seenDialerIds.current = new Set(dialerRows.map((row) => row.id));
        } else {
          const seen = seenDialerIds.current;
          for (const row of dialerRows) {
            if (!seen.has(row.id)) {
              notifyNewLead({ name: row.name || row.email, company: row.company });
              seen.add(row.id);
            }
          }
        }
      } catch {
        // swallow — try again next tick
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    // Ask for notification permission once + preload chime audio so the first
    // new-row trigger has zero latency.
    ensureNotifPermission();
    preloadChime();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="max-w-screen-2xl mx-auto px-8 py-8 w-full">
      <header className="mb-6 flex items-baseline justify-between">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/gushwork-logo.svg" alt="Gushwork" className="h-7" />
          <div className="border-l border-[color:var(--border)] pl-3">
            <h1 className="text-2xl font-semibold">In-House Cold Email Platform</h1>
            <p className="text-sm text-[color:var(--muted)]">
              Live dialing queue + appointment reminders
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle theme={theme} onChange={setTheme} />
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

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      onClick={() => onChange(next)}
      title={`Switch to ${next} mode`}
      className="inline-flex items-center justify-center w-8 h-8 rounded border border-[color:var(--border)] hover:bg-[color:var(--border)]/40"
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
    </button>
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
