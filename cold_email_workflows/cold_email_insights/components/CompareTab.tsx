'use client'

import { useMemo } from 'react'
import type { MetricsData, ShowupAnalysis, Industry } from './types'
import { computeMetrics } from './Dashboard'

const INDUSTRIES: Industry[] = ['Manufacturing', 'IT & Consulting', 'Truck Transportation']
const EMPTY_RANGE = { from: '', to: '' }

function pct(n: number, digits = 1) {
  return n.toFixed(digits) + '%'
}
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 whitespace-nowrap">
    {children}
  </th>
)
const TD = ({ children, highlight = false }: { children: React.ReactNode; highlight?: boolean }) => (
  <td className={`px-4 py-2.5 text-sm whitespace-nowrap ${highlight ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
    {children}
  </td>
)
const Section = ({ label }: { label: string }) => (
  <tr className="bg-blue-50">
    <td colSpan={4} className="px-4 py-2 text-xs font-bold text-blue-700 uppercase tracking-widest">
      {label}
    </td>
  </tr>
)

export default function CompareTab({
  data,
  showupData,
}: {
  data: MetricsData
  showupData: ShowupAnalysis
}) {
  const byIndustry = useMemo(() => {
    return Object.fromEntries(
      INDUSTRIES.map(ind => [ind, computeMetrics(ind, EMPTY_RANGE, data)]),
    ) as Record<Industry, ReturnType<typeof computeMetrics>>
  }, [data])

  // Intent breakdown from showup_analysis
  const intentByIndustry = useMemo(() => {
    const result: Record<string, Record<string, number>> = {}
    for (const ind of INDUSTRIES) result[ind] = { Hot: 0, Warm: 0, Cold: 0, Dead: 0, total: 0 }

    for (const rec of Object.values(showupData)) {
      if ('error' in rec || !rec._meta) continue
      const ind = rec._meta.industry
      if (ind && result[ind]) {
        const lbl = rec.deal_closing_intent_label || ''
        if (lbl in result[ind]) result[ind][lbl]++
        result[ind].total++
      }
    }
    return result
  }, [showupData])

  const rows: Array<{
    label: string
    getValue: (m: ReturnType<typeof computeMetrics>, ind: Industry) => string
    isSection?: boolean
    section?: string
  }> = [
    { label: '', isSection: true, section: 'Email', getValue: () => '' },
    { label: 'Campaigns',        getValue: m => String(m.campaigns) },
    { label: 'Emails Sent',      getValue: m => fmt(m.emails_sent) },
    { label: 'Leads Contacted',  getValue: m => fmt(m.leads_contacted) },
    { label: 'Replied (total)',  getValue: m => fmt(m.replied) },
    { label: 'Reply Rate (per lead)', getValue: m => pct(m.reply_rate_per_contacted) },
    { label: 'Interested',       getValue: m => fmt(m.interested) },
    { label: 'Interested Rate (per lead)', getValue: m => pct(m.int_rate_per_contacted, 4) },

    { label: '', isSection: true, section: 'Demos & Show-ups', getValue: () => '' },
    { label: 'Demos Booked',     getValue: m => fmt(m.demos_booked) },
    { label: 'Demos / Interested', getValue: m => pct(m.demos_per_interested) },
    { label: 'Show-ups',         getValue: m => fmt(m.showups) },
    { label: 'Pending Demos',    getValue: m => fmt(m.pending_demos) },
    { label: 'No-shows',         getValue: m => fmt(m.noshow) },
    { label: 'Actual Show Rate', getValue: m => pct(m.show_rate) },
    { label: 'Show-ups / Interested', getValue: m => pct(m.showups_per_interested) },
    { label: 'Show-ups / Lead',  getValue: m => pct(m.showups_per_contacted, 4) },

    { label: '', isSection: true, section: 'Deal Intent (analyzed calls)', getValue: () => '' },
  ]

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          Industry Comparison
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">All-time totals · no date filter applied</p>
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
            {rows.map((row, i) => {
              if (row.isSection) {
                return <Section key={i} label={row.section!} />
              }
              return (
                <tr key={row.label} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-sm text-gray-600 font-medium">{row.label}</td>
                  {INDUSTRIES.map(ind => (
                    <TD key={ind} highlight={false}>
                      {row.getValue(byIndustry[ind], ind)}
                    </TD>
                  ))}
                </tr>
              )
            })}

            {/* Intent breakdown rows */}
            {(['Hot', 'Warm', 'Cold', 'Dead'] as const).map(lbl => (
              <tr key={lbl} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-sm text-gray-600 font-medium">{lbl}</td>
                {INDUSTRIES.map(ind => {
                  const counts = intentByIndustry[ind] || {}
                  const count  = counts[lbl] || 0
                  const total  = counts.total || 0
                  const pctStr = total > 0 ? ` (${((count / total) * 100).toFixed(0)}%)` : ''
                  const badge: Record<string, string> = {
                    Hot:  'text-green-700',
                    Warm: 'text-blue-700',
                    Cold: 'text-gray-600',
                    Dead: 'text-red-600',
                  }
                  return (
                    <td key={ind} className={`px-4 py-2.5 text-sm font-semibold ${badge[lbl]}`}>
                      {count}{pctStr}
                    </td>
                  )
                })}
              </tr>
            ))}

            {/* Hot + Warm % summary */}
            <tr className="bg-green-50 font-semibold">
              <td className="px-4 py-2.5 text-sm text-green-800 font-bold">Hot + Warm %</td>
              {INDUSTRIES.map(ind => {
                const counts = intentByIndustry[ind] || {}
                const hw = (counts.Hot || 0) + (counts.Warm || 0)
                const total = counts.total || 0
                return (
                  <td key={ind} className="px-4 py-2.5 text-sm text-green-800 font-bold">
                    {total > 0 ? `${((hw / total) * 100).toFixed(0)}%` : '—'}
                    {' '}({hw}/{total})
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
