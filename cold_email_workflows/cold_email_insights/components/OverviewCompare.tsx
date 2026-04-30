'use client'

import { useMemo } from 'react'
import type { MetricsData, Industry, DateRange } from './types'
import { computeMetrics } from './metrics'

const INDUSTRIES: Industry[] = ['Manufacturing', 'IT & Consulting', 'Truck Transportation', 'BCS', 'Commercial', 'EWWS', 'Advertising', 'Medical Equipment', 'Equipment Rental']

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function pct(n: number, digits = 2) { return n.toFixed(digits) + '%' }
function money(n: number) {
  if (!n) return '—'
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K'
  return '$' + Math.round(n).toLocaleString()
}

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap"
      style={{ backgroundColor: '#0070FF', color: '#ffffff' }}>
    {children}
  </th>
)
const TD = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <td className={`px-4 py-2.5 text-sm whitespace-nowrap text-gray-700 ${className}`}>
    {children}
  </td>
)
const Section = ({ label }: { label: string }) => (
  <tr>
    <td colSpan={INDUSTRIES.length + 1}
        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-center border-t border-blue-100"
        style={{ backgroundColor: '#dbeafe', color: '#1e40af' }}>
      {label}
    </td>
  </tr>
)

type Row = {
  label: string
  getValue: (m: ReturnType<typeof computeMetrics>) => string
  section?: string
  bold?: boolean
}

const ROWS: Row[] = [
  { label: '', section: 'Email' } as Row,
  { label: 'Emails Sent',            getValue: m => fmt(m.emails_sent) },
  { label: 'Leads Contacted',        getValue: m => fmt(m.leads_contacted) },
  { label: 'Replied',                getValue: m => fmt(m.replied) },
  { label: 'Reply Rate',             getValue: m => pct(m.reply_rate_per_contacted) },
  { label: 'Interested Replies',     getValue: m => fmt(m.interested) },
  { label: 'Interest Rate',          getValue: m => pct(m.int_rate_per_contacted, 4) },
  { label: 'Bounced',                getValue: m => fmt(m.bounced) },
  { label: 'Bounce %',               getValue: m => pct(m.bounce_rate) },

  { label: '', section: 'Demos' } as Row,
  { label: 'Demos Booked',           getValue: m => fmt(m.demos_booked), bold: true },
  { label: 'Pending Demos',          getValue: m => fmt(m.pending_demos) },
  { label: 'Demos / Emails Sent',    getValue: m => pct(m.demos_per_sent, 4) },
  { label: 'Demos / Leads Contacted', getValue: m => pct(m.demos_per_contacted, 4) },
  { label: 'Demos / Interested',     getValue: m => pct(m.demos_per_interested) },

  { label: '', section: 'Show-ups' } as Row,
  { label: 'Total Show-ups',         getValue: m => fmt(m.showups), bold: true },
  { label: 'No-shows',               getValue: m => fmt(m.noshow) },
  { label: 'Show-ups / Emails Sent', getValue: m => pct(m.showups_per_sent, 4) },
  { label: 'Show-ups / Leads Contacted', getValue: m => pct(m.showups_per_contacted, 4) },
  { label: 'Show-ups / Demos',       getValue: m => pct(m.show_rate) },

  { label: '', section: 'Closed (Onboardings)' } as Row,
  { label: 'Closed Deals',           getValue: m => String(m.closed), bold: true },
  { label: 'ARR',                    getValue: m => money(m.arr), bold: true },
  { label: 'MRR',                    getValue: m => money(m.mrr) },
  { label: 'Close / Demo',           getValue: m => pct(m.close_per_demo) },
  { label: 'Close / Show-up',        getValue: m => pct(m.close_per_showup) },
  { label: 'Close / Interested',     getValue: m => pct(m.close_per_interested) },
  { label: 'Close / Lead',           getValue: m => pct(m.close_per_lead, 4) },
]

export default function OverviewCompare({
  data,
  dateRange,
}: {
  data: MetricsData
  dateRange: DateRange
}) {
  const byIndustry = useMemo(() =>
    Object.fromEntries(
      INDUSTRIES.map(ind => [ind, computeMetrics(ind, dateRange, data)]),
    ) as Record<Industry, ReturnType<typeof computeMetrics>>,
  [data, dateRange])

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          Industry Comparison
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">All metrics side-by-side for selected date range</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <TH>Metric</TH>
              {INDUSTRIES.map(ind => <TH key={ind}>{ind}</TH>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {ROWS.map((row, i) => {
              if ('section' in row && row.section) {
                return <Section key={i} label={row.section} />
              }
              if (!row.getValue) return null
              return (
                <tr key={row.label} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-sm text-gray-600 font-medium whitespace-nowrap">
                    {row.label}
                  </td>
                  {INDUSTRIES.map(ind => (
                    <TD key={ind} className={row.bold ? 'font-semibold text-gray-900' : ''}>
                      {row.getValue(byIndustry[ind])}
                    </TD>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
