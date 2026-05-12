'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import type { MetricsData } from './types'
import { EXCLUDED_INDUSTRIES } from './types'

// ── Per-day aggregation ─────────────────────────────────────────────────────
// Builds one record per YYYY-MM-DD covering every metric the dashboard surfaces.
// Ratios are computed day-local (sum-num-on-day / sum-denom-on-day, 0 if denom = 0).
type DailyRec = {
  date: string
  emails_sent: number
  leads_contacted: number
  interested: number
  bounced: number
  demos_booked: number
  showups: number
  completed_demos: number
  noshow: number
  closed: number
  arr: number
  mrr: number
}

function buildDailyIndex(data: MetricsData): Record<string, DailyRec> {
  const idx: Record<string, DailyRec> = {}
  const get = (d: string): DailyRec => {
    if (!idx[d]) {
      idx[d] = {
        date: d, emails_sent: 0, leads_contacted: 0, interested: 0, bounced: 0,
        demos_booked: 0, showups: 0, completed_demos: 0, noshow: 0,
        closed: 0, arr: 0, mrr: 0,
      }
    }
    return idx[d]
  }

  for (const r of data.time_series?.daily || []) {
    const rec = get(r.date)
    rec.emails_sent += r.emails_delta || 0
    rec.leads_contacted += r.leads_delta || 0
    rec.interested += r.interested || 0
  }

  for (const r of data.daily_email_stats || []) {
    if (!r.industry || EXCLUDED_INDUSTRIES.has(r.industry)) continue
    const rec = get(r.date)
    rec.bounced += r.bounced_delta || 0
  }

  for (const b of data.demo_bookings || []) {
    if (!b.industry || EXCLUDED_INDUSTRIES.has(b.industry)) continue
    if (b.created_at_date) {
      get(b.created_at_date).demos_booked += 1
    }
    if (b.demo_scheduled_date) {
      const rec = get(b.demo_scheduled_date)
      if (b.show_status === 'Y') {
        rec.showups += 1
        rec.completed_demos += 1
      } else if (b.show_status === 'N' || b.show_status === 'R') {
        rec.completed_demos += 1
        rec.noshow += 1
      }
    }
    if (b.closed) {
      const d = b.onboarding_call_date || b.created_at_date
      if (d) {
        const rec = get(d)
        rec.closed += 1
        rec.arr += b.arr || 0
        rec.mrr += b.monthly_amount || 0
      }
    }
  }

  return idx
}

// ── Metric registry ─────────────────────────────────────────────────────────
// Anything user-selectable in the picker. Ratios returned as percentages (0-100).
// `get` returns null when the value is undefined for that day (e.g. ratio with
// zero denominator). Recharts skips null points (connectNulls is on) so the
// y-axis auto-fits to the real data range instead of being anchored at 0.
type MetricDef = {
  key: string
  label: string
  group: 'Email' | 'Demos' | 'Show-ups' | 'Closes'
  unit: 'count' | 'pct' | 'money'
  get: (r: DailyRec) => number | null
}

const safePct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null)

const METRICS: MetricDef[] = [
  { key: 'emails_sent',           label: 'Emails Sent',             group: 'Email',    unit: 'count', get: r => r.emails_sent },
  { key: 'leads_contacted',       label: 'Leads Contacted',         group: 'Email',    unit: 'count', get: r => r.leads_contacted },
  { key: 'interested',            label: 'Interested Replies',      group: 'Email',    unit: 'count', get: r => r.interested },
  { key: 'bounced',               label: 'Bounced',                 group: 'Email',    unit: 'count', get: r => r.bounced },
  { key: 'bounce_rate',           label: 'Bounce %',                group: 'Email',    unit: 'pct',   get: r => safePct(r.bounced, r.leads_contacted) },
  { key: 'demos_booked',          label: 'Demos Booked',            group: 'Demos',    unit: 'count', get: r => r.demos_booked },
  { key: 'demos_per_sent',        label: 'Demos / Emails Sent',     group: 'Demos',    unit: 'pct',   get: r => safePct(r.demos_booked, r.emails_sent) },
  { key: 'demos_per_contacted',   label: 'Demos / Leads Contacted', group: 'Demos',    unit: 'pct',   get: r => safePct(r.demos_booked, r.leads_contacted) },
  { key: 'demos_per_interested',  label: 'Demos / Interested',      group: 'Demos',    unit: 'pct',   get: r => safePct(r.demos_booked, r.interested) },
  { key: 'showups',               label: 'Total Show-ups',          group: 'Show-ups', unit: 'count', get: r => r.showups },
  { key: 'noshow',                label: 'No-shows',                group: 'Show-ups', unit: 'count', get: r => r.noshow },
  { key: 'showups_per_sent',      label: 'Show-ups / Emails Sent',  group: 'Show-ups', unit: 'pct',   get: r => safePct(r.showups, r.emails_sent) },
  { key: 'showups_per_contacted', label: 'Show-ups / Leads Contacted', group: 'Show-ups', unit: 'pct', get: r => safePct(r.showups, r.leads_contacted) },
  { key: 'show_rate',             label: 'Show-ups / Demos',        group: 'Show-ups', unit: 'pct',   get: r => safePct(r.showups, r.completed_demos) },
  { key: 'closed',                label: 'Closed Deals',            group: 'Closes',   unit: 'count', get: r => r.closed },
  { key: 'arr',                   label: 'ARR',                     group: 'Closes',   unit: 'money', get: r => r.arr },
  { key: 'mrr',                   label: 'MRR',                     group: 'Closes',   unit: 'money', get: r => r.mrr },
  { key: 'close_per_demo',        label: 'Close / Demo',            group: 'Closes',   unit: 'pct',   get: r => safePct(r.closed, r.demos_booked) },
  { key: 'close_per_showup',      label: 'Close / Show-up',         group: 'Closes',   unit: 'pct',   get: r => safePct(r.closed, r.showups) },
  { key: 'close_per_interested',  label: 'Close / Interested',      group: 'Closes',   unit: 'pct',   get: r => safePct(r.closed, r.interested) },
  { key: 'close_per_lead',        label: 'Close / Lead',            group: 'Closes',   unit: 'pct',   get: r => safePct(r.closed, r.leads_contacted) },
]

// ── Helpers ─────────────────────────────────────────────────────────────────
const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function monthLabel(ym: string) {
  const [y, m] = ym.split('-')
  return `${MONTH_LABEL[Number(m) - 1]} ${y.slice(2)}`  // "Apr 26"
}

// Returns the ordered list of working-day dates (Mon-Fri) for a given YYYY-MM.
// Working-day index = position in this list (1-based). So "1st working day of
// May 2026" lines up with "1st working day of April 2026" even if calendar
// dates differ — fixes spurious spikes from weekend mismatch across months.
function workingDatesForMonth(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  const out: string[] = []
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(y, m - 1, d).getDay()  // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    }
  }
  return out
}

// Distinct colour per series. Cycles if >6 months selected.
const COLORS = ['#0070FF', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6']

function fmtValue(v: number | null | undefined, unit: 'count' | 'pct' | 'money'): string {
  if (v === null || v === undefined) return '—'
  if (unit === 'pct')   return v.toFixed(2) + '%'
  if (unit === 'money') return v >= 1000 ? '$' + (v / 1000).toFixed(1) + 'K' : '$' + Math.round(v).toLocaleString()
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K'
  return v.toLocaleString()
}

// ── Component ───────────────────────────────────────────────────────────────
export default function MonthlyOverlayChart({ data }: { data: MetricsData }) {
  const dailyIdx = useMemo(() => buildDailyIndex(data), [data])

  // Available months — only keep months that look like real activity.
  // Filters out: (a) 1970-epoch artifacts from null dates ("Jan 70"),
  // (b) tiny pilot months with negligible email volume.
  const monthsAvailable = useMemo(() => {
    const emailsByMonth = new Map<string, number>()
    for (const [d, rec] of Object.entries(dailyIdx)) {
      const ym = d.slice(0, 7)
      emailsByMonth.set(ym, (emailsByMonth.get(ym) || 0) + rec.emails_sent)
    }
    const MIN_EMAILS_FOR_REAL_MONTH = 5000
    const MIN_YEAR = 2024
    return [...emailsByMonth.entries()]
      .filter(([ym, total]) => {
        const year = Number(ym.slice(0, 4))
        return year >= MIN_YEAR && total >= MIN_EMAILS_FOR_REAL_MONTH
      })
      .map(([ym]) => ym)
      .sort()
  }, [dailyIdx])

  // Default: last 2 months selected
  const [selectedMonths, setSelectedMonths] = useState<string[]>(() =>
    monthsAvailable.slice(-2),
  )
  const [metricKey, setMetricKey] = useState<string>('emails_sent')

  const metric = METRICS.find(m => m.key === metricKey)!

  // Build the recharts data array: one row per working-day index (1..23).
  // Each row has the metric value for every month at THAT working-day index.
  // April-day-9 (e.g. Apr 13 Tue) lines up with May-day-9 (e.g. May 13 Wed).
  const chartData = useMemo(() => {
    // Compute working-date list for each selected month
    const datesPerMonth: Record<string, string[]> = {}
    let maxLen = 0
    for (const ym of selectedMonths) {
      const dates = workingDatesForMonth(ym)
      datesPerMonth[ym] = dates
      if (dates.length > maxLen) maxLen = dates.length
    }

    const rows: Array<Record<string, number | string | null>> = []
    for (let i = 0; i < maxLen; i++) {
      const row: Record<string, number | string | null> = { day: i + 1 }
      for (const ym of selectedMonths) {
        const date = datesPerMonth[ym][i]
        if (!date) continue
        const rec = dailyIdx[date]
        row[ym] = rec ? metric.get(rec) : null
      }
      rows.push(row)
    }
    return rows
  }, [dailyIdx, selectedMonths, metric])

  const toggleMonth = (ym: string) => {
    setSelectedMonths(prev =>
      prev.includes(ym) ? prev.filter(m => m !== ym) : [...prev, ym].sort(),
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Monthly Trend Overlay
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Compare a single metric across months · x-axis is day-of-month
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Metric picker */}
          <select
            value={metricKey}
            onChange={e => setMetricKey(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {['Email', 'Demos', 'Show-ups', 'Closes'].map(group => (
              <optgroup key={group} label={group}>
                {METRICS.filter(m => m.group === group).map(m => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* Month chips */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-gray-500 mr-1">Months:</span>
            {monthsAvailable.map(ym => {
              const on = selectedMonths.includes(ym)
              return (
                <button
                  key={ym}
                  onClick={() => toggleMonth(ym)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    on
                      ? 'text-white border-transparent'
                      : 'bg-white border-gray-300 text-gray-500 hover:border-gray-400'
                  }`}
                  style={on ? { backgroundColor: '#0070FF' } : {}}
                >
                  {monthLabel(ym)}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {selectedMonths.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-10">Select one or more months above.</p>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: '#6b7280' }}
              label={{ value: 'Working day (Mon–Fri only)', position: 'insideBottom', offset: -5, fontSize: 11, fill: '#9ca3af' }}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 11, fill: '#6b7280' }}
              tickFormatter={(v: number) => fmtValue(v, metric.unit)}
            />
            <Tooltip
              formatter={(v) => fmtValue(typeof v === 'number' ? v : Number(v), metric.unit)}
              labelFormatter={(d) => `Working day ${d}`}
              contentStyle={{ fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {selectedMonths.map((ym, i) => (
              <Line
                key={ym}
                type="monotone"
                dataKey={ym}
                name={monthLabel(ym)}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
