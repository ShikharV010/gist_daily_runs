"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsResponse, AnalyticsBucket } from "@/lib/types";
import type { Tz } from "@/lib/format";

type Granularity = "day" | "week";

export default function AnalyticsTab({ tz }: { tz: Tz }) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/analytics?tz=${tz}`, { cache: "no-store" });
        const j = (await res.json()) as AnalyticsResponse;
        if (!cancelled) setData(j);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tz]);

  const buckets = (granularity === "day" ? data?.by_day : data?.by_week) || [];
  // Charts want ascending order; the API returns descending so we reverse.
  const chartData = [...buckets].reverse();

  return (
    <div className="space-y-6">
      <p className="text-xs text-[color:var(--muted)] uppercase tracking-wide">
        All time · {tz}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <StatCard
          label="Total Call Attempts"
          value={data?.totals.total_calls ?? 0}
          tone="neutral"
          hint="every ring, repeats included"
        />
        <StatCard
          label="Leads first-called < 5 min"
          value={data?.totals.calls_within_5min ?? 0}
          tone="violet"
          hint="unique leads, first call within 5 min of reply"
        />
        <StatCard
          label="Leads first-called ≥ 5 min"
          value={data?.totals.calls_outside_5min ?? 0}
          tone="coral"
          hint="unique leads, first call after 5+ min"
        />
        <StatCard
          label="Bookings from < 5 min"
          value={data?.totals.bookings_within_5min ?? 0}
          tone="violetDeep"
          hint="Meeting Booked, first call < 5 min"
        />
        <StatCard
          label="Bookings from ≥ 5 min"
          value={data?.totals.bookings_outside_5min ?? 0}
          tone="pink"
          hint="Meeting Booked, first call ≥ 5 min"
        />
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">By {granularity}</h3>
        <div className="inline-flex rounded border border-[color:var(--border)] overflow-hidden text-xs">
          {(["day", "week"] as Granularity[]).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`px-3 py-1 ${
                granularity === g
                  ? "bg-[color:var(--accent)] text-white"
                  : "bg-transparent text-[color:var(--muted)] hover:bg-[color:var(--border)]/40"
              }`}
            >
              {g === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
      </div>

      <ChartCard
        title="Calls"
        data={chartData}
        loading={loading}
        series={[
          { key: "calls_within_5min", name: "< 5 min", fill: "#7c5cff" },
          { key: "calls_outside_5min", name: "≥ 5 min", fill: "#f4a98c" },
        ]}
      />
      <ChartCard
        title="Bookings"
        data={chartData}
        loading={loading}
        series={[
          { key: "bookings_within_5min", name: "From < 5 min calls", fill: "#5b3df0" },
          { key: "bookings_outside_5min", name: "From ≥ 5 min calls", fill: "#ec4899" },
        ]}
      />

      <BucketTable rows={buckets} granularity={granularity} />

      <DispositionSection data={data} />
    </div>
  );
}

function DispositionSection({ data }: { data: AnalyticsResponse | null }) {
  if (!data) return null;
  const connected = data.dispositions.filter((d) => d.connected);
  const notConnected = data.dispositions.filter((d) => !d.connected);
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Dispositions</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label="Connected"
          value={data.totals.connected_leads}
          tone="violet"
          hint="unique leads where the rep spoke to someone"
        />
        <StatCard
          label="Not connected"
          value={data.totals.not_connected_leads}
          tone="coral"
          hint="unique leads with no-answer / voicemail / invalid only"
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DispositionTable title="Connected"     rows={connected}     accent="text-violet-700 dark:text-violet-300" />
        <DispositionTable title="Not connected" rows={notConnected}  accent="text-orange-700 dark:text-orange-300" />
      </div>
    </div>
  );
}

function DispositionTable({
  title,
  rows,
  accent,
}: {
  title: string;
  rows: { disposition: string; leads: number; total_attempts: number }[];
  accent: string;
}) {
  const totalLeads = rows.reduce((s, r) => s + r.leads, 0) || 1;
  return (
    <div className="border border-[color:var(--border)] rounded">
      <div className={`px-3 py-2 text-xs font-medium uppercase tracking-wide ${accent}`}>
        {title} · {rows.reduce((s, r) => s + r.leads, 0)} leads · {rows.reduce((s, r) => s + r.total_attempts, 0)} attempts
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-sm text-[color:var(--muted)] text-center">No rows</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--border)]/30 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 font-medium text-[color:var(--muted)]">Disposition</th>
              <th className="px-3 py-2 font-medium text-[color:var(--muted)] text-right">Leads</th>
              <th className="px-3 py-2 font-medium text-[color:var(--muted)] text-right">Attempts</th>
              <th className="px-3 py-2 font-medium text-[color:var(--muted)] text-right">% of group</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.disposition} className="border-t border-[color:var(--border)]">
                <td className="px-3 py-2">{r.disposition}</td>
                <td className="px-3 py-2 text-right">{r.leads}</td>
                <td className="px-3 py-2 text-right">{r.total_attempts}</td>
                <td className="px-3 py-2 text-right text-[color:var(--muted)]">
                  {((100 * r.leads) / totalLeads).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type CardTone = "violet" | "violetDeep" | "coral" | "pink" | "success" | "muted" | "neutral";

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: CardTone;
  hint?: string;
}) {
  const cls =
    tone === "violet"
      ? "border-violet-300/50 bg-gradient-to-br from-violet-50 to-white text-violet-900 dark:border-violet-500/30 dark:from-violet-500/15 dark:to-violet-900/5 dark:text-violet-100"
      : tone === "violetDeep"
      ? "border-indigo-300/60 bg-gradient-to-br from-indigo-100 to-white text-indigo-900 dark:border-indigo-500/40 dark:from-indigo-500/20 dark:to-indigo-900/5 dark:text-indigo-100"
      : tone === "coral"
      ? "border-orange-300/50 bg-gradient-to-br from-orange-50 to-white text-orange-900 dark:border-orange-400/30 dark:from-orange-400/15 dark:to-orange-900/5 dark:text-orange-100"
      : tone === "pink"
      ? "border-pink-300/60 bg-gradient-to-br from-pink-50 to-white text-pink-900 dark:border-pink-500/30 dark:from-pink-500/15 dark:to-pink-900/5 dark:text-pink-100"
      : tone === "success"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/30"
      : tone === "muted"
      ? "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30"
      : "border-[color:var(--border)] bg-[color:var(--card)]";
  return (
    <div className={`border rounded-xl p-4 ${cls}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value.toLocaleString()}</div>
      {hint && <div className="text-[10px] opacity-60 mt-1 leading-tight">{hint}</div>}
    </div>
  );
}

function ChartCard({
  title,
  data,
  loading,
  series,
}: {
  title: string;
  data: AnalyticsBucket[];
  loading: boolean;
  series: { key: keyof AnalyticsBucket; name: string; fill: string }[];
}) {
  const gradId = (suffix: string) => `grad-${title.replace(/\s/g, "")}-${suffix}`;
  return (
    <div className="border border-[color:var(--border)] rounded-xl p-4 bg-[color:var(--card)]">
      <h4 className="text-sm font-medium mb-3">{title}</h4>
      {data.length === 0 ? (
        <div className="text-sm text-[color:var(--muted)] py-12 text-center">
          {loading ? "Loading…" : "No call data yet."}
        </div>
      ) : (
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={i} id={gradId(String(i))} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.fill} stopOpacity={1} />
                    <stop offset="100%" stopColor={s.fill} stopOpacity={0.55} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} />
              <XAxis dataKey="bucket" stroke="currentColor" strokeOpacity={0.5} fontSize={12} />
              <YAxis allowDecimals={false} stroke="currentColor" strokeOpacity={0.5} fontSize={12} />
              <Tooltip
                cursor={{ fill: "rgba(124, 92, 255, 0.08)" }}
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--foreground)",
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {series.map((s, i) => (
                <Bar
                  key={String(s.key)}
                  dataKey={String(s.key)}
                  name={s.name}
                  fill={`url(#${gradId(String(i))})`}
                  radius={[6, 6, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function BucketTable({
  rows,
  granularity,
}: {
  rows: AnalyticsBucket[];
  granularity: Granularity;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto border border-[color:var(--border)] rounded">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--border)]/30 text-left text-xs uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2 font-medium text-[color:var(--muted)]">
              {granularity === "day" ? "Day" : "Week of"}
            </th>
            <th className="px-3 py-2 font-medium text-[color:var(--muted)]">Calls &lt; 5</th>
            <th className="px-3 py-2 font-medium text-[color:var(--muted)]">Calls ≥ 5</th>
            <th className="px-3 py-2 font-medium text-[color:var(--muted)]">Bookings &lt; 5</th>
            <th className="px-3 py-2 font-medium text-[color:var(--muted)]">Bookings ≥ 5</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bucket} className="border-t border-[color:var(--border)]">
              <td className="px-3 py-2 whitespace-nowrap">{r.bucket}</td>
              <td className="px-3 py-2">{r.calls_within_5min}</td>
              <td className="px-3 py-2">{r.calls_outside_5min}</td>
              <td className="px-3 py-2">{r.bookings_within_5min}</td>
              <td className="px-3 py-2">{r.bookings_outside_5min}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
