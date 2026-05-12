'use client'

import { useMemo } from 'react'
import type { MetricsData } from './types'
import { EXCLUDED_INDUSTRIES } from './types'

// Per-day rollup for one month. Auto-detects months from time_series + bookings,
// so future months (June, July…) auto-appear without code changes.
type DailyRow = {
  date: string           // YYYY-MM-DD
  emails: number         // emails_delta from time_series.daily
  demosBooked: number    // demo_bookings.created_at_date == date
  showups: number        // demo_bookings.demo_scheduled_date == date AND show_status === 'Y'
}

const MONTH_LABEL = ['January','February','March','April','May','June','July','August','September','October','November','December']

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function buildMonthlyRollups(data: MetricsData): Record<string, DailyRow[]> {
  // key = YYYY-MM, value = sorted rows ascending by date
  const byDate: Record<string, DailyRow> = {}

  for (const d of data.time_series?.daily || []) {
    byDate[d.date] = byDate[d.date] || { date: d.date, emails: 0, demosBooked: 0, showups: 0 }
    byDate[d.date].emails += d.emails_delta || 0
  }

  for (const b of data.demo_bookings || []) {
    if (!b.industry || EXCLUDED_INDUSTRIES.has(b.industry)) continue
    if (b.created_at_date) {
      const d = b.created_at_date
      byDate[d] = byDate[d] || { date: d, emails: 0, demosBooked: 0, showups: 0 }
      byDate[d].demosBooked += 1
    }
    if (b.show_status === 'Y' && b.demo_scheduled_date) {
      const d = b.demo_scheduled_date
      byDate[d] = byDate[d] || { date: d, emails: 0, demosBooked: 0, showups: 0 }
      byDate[d].showups += 1
    }
  }

  const out: Record<string, DailyRow[]> = {}
  for (const r of Object.values(byDate)) {
    const ym = r.date.slice(0, 7)
    if (!out[ym]) out[ym] = []
    out[ym].push(r)
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => a.date.localeCompare(b.date))
  }
  return out
}

function ratioPct(num: number, denom: number): string {
  if (denom <= 0) return '—'
  return ((num / denom) * 100).toFixed(4) + '%'
}

function MonthTable({ ym, rows }: { ym: string; rows: DailyRow[] }) {
  const [y, m] = ym.split('-')
  const label = `${MONTH_LABEL[Number(m) - 1]} ${y}`

  const totals = rows.reduce(
    (acc, r) => ({
      emails: acc.emails + r.emails,
      demosBooked: acc.demosBooked + r.demosBooked,
      showups: acc.showups + r.showups,
    }),
    { emails: 0, demosBooked: 0, showups: 0 },
  )

  return (
    <div className="bg-white rounded-xl border border-gray-300">
      <div className="px-6 py-3 border-b border-gray-200">
        <h3 className="text-sm font-bold text-gray-900">{label}</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          {fmt(totals.emails)} emails · {totals.demosBooked} demos · {totals.showups} show-ups
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
              <th className="px-4 py-2 text-left font-semibold">Date</th>
              <th className="px-4 py-2 text-right font-semibold">Emails Sent</th>
              <th className="px-4 py-2 text-right font-semibold">Demos Booked</th>
              <th className="px-4 py-2 text-right font-semibold">Demos / Emails</th>
              <th className="px-4 py-2 text-right font-semibold">Show-ups</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.date} className="hover:bg-gray-50">
                <td className="px-4 py-1.5 text-gray-700 whitespace-nowrap">{r.date}</td>
                <td className="px-4 py-1.5 text-right text-gray-700 tabular-nums">{r.emails ? fmt(r.emails) : '—'}</td>
                <td className="px-4 py-1.5 text-right text-gray-700 tabular-nums">{r.demosBooked || '—'}</td>
                <td className="px-4 py-1.5 text-right text-gray-700 tabular-nums">{ratioPct(r.demosBooked, r.emails)}</td>
                <td className="px-4 py-1.5 text-right text-gray-700 tabular-nums">{r.showups || '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <td className="px-4 py-2 text-gray-700">Total</td>
              <td className="px-4 py-2 text-right text-gray-900 tabular-nums">{fmt(totals.emails)}</td>
              <td className="px-4 py-2 text-right text-gray-900 tabular-nums">{totals.demosBooked}</td>
              <td className="px-4 py-2 text-right text-gray-900 tabular-nums">{ratioPct(totals.demosBooked, totals.emails)}</td>
              <td className="px-4 py-2 text-right text-gray-900 tabular-nums">{totals.showups}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

export default function DailyDetailsTables({ data }: { data: MetricsData }) {
  const byMonth = useMemo(() => buildMonthlyRollups(data), [data])
  // Show only the 2 most recent months that actually have data. As new months
  // start (June 2026, July 2026, …) the window auto-rolls forward — no code change.
  const months = Object.keys(byMonth).sort().slice(-2).reverse()
  if (months.length === 0) return null

  return (
    <div>
      <h2 className="text-sm font-bold text-gray-900 mb-3 uppercase tracking-wide">Daily Details</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {months.map(ym => <MonthTable key={ym} ym={ym} rows={byMonth[ym]} />)}
      </div>
    </div>
  )
}
