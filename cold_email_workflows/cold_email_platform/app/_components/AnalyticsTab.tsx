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
          label="Total Calls"
          value={data?.totals.total_calls ?? 0}
          tone="neutral"
        />
        <StatCard
          label="Calls < 5 min"
          value={data?.totals.calls_within_5min ?? 0}
          tone="accent"
        />
        <StatCard
          label="Calls ≥ 5 min"
          value={data?.totals.calls_outside_5min ?? 0}
          tone="neutral"
        />
        <StatCard
          label="Bookings from < 5 min"
          value={data?.totals.bookings_within_5min ?? 0}
          tone="success"
        />
        <StatCard
          label="Bookings from ≥ 5 min"
          value={data?.totals.bookings_outside_5min ?? 0}
          tone="muted"
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
          { key: "calls_within_5min", name: "< 5 min", fill: "#2563eb" },
          { key: "calls_outside_5min", name: "≥ 5 min", fill: "#94a3b8" },
        ]}
      />
      <ChartCard
        title="Bookings"
        data={chartData}
        loading={loading}
        series={[
          { key: "bookings_within_5min", name: "From < 5 min calls", fill: "#16a34a" },
          { key: "bookings_outside_5min", name: "From ≥ 5 min calls", fill: "#fbbf24" },
        ]}
      />

      <BucketTable rows={buckets} granularity={granularity} />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "accent" | "success" | "neutral" | "muted";
}) {
  const cls =
    tone === "accent"
      ? "border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-950/30"
      : tone === "success"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/30"
      : tone === "muted"
      ? "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30"
      : "border-[color:var(--border)] bg-[color:var(--card)]";
  return (
    <div className={`border rounded p-4 ${cls}`}>
      <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value.toLocaleString()}</div>
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
  return (
    <div className="border border-[color:var(--border)] rounded p-4 bg-[color:var(--card)]">
      <h4 className="text-sm font-medium mb-3">{title}</h4>
      {data.length === 0 ? (
        <div className="text-sm text-[color:var(--muted)] py-12 text-center">
          {loading ? "Loading…" : "No call data yet."}
        </div>
      ) : (
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="bucket" stroke="#6b7280" fontSize={12} />
              <YAxis allowDecimals={false} stroke="#6b7280" fontSize={12} />
              <Tooltip />
              <Legend />
              {series.map((s) => (
                <Bar
                  key={String(s.key)}
                  dataKey={String(s.key)}
                  name={s.name}
                  fill={s.fill}
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
