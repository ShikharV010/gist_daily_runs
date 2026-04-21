'use client'

import { useMemo, useState } from 'react'
import type { ShowupAnalysis, ShowupRecord, DateRange, Industry, IntentLabel } from './types'

const INTENT_LABELS: IntentLabel[] = ['Hot', 'Warm', 'Cold', 'Dead']

const INTENT_BADGE: Record<string, string> = {
  Hot:  'bg-green-100 text-green-800',
  Warm: 'bg-blue-100 text-blue-800',
  Cold: 'bg-gray-100 text-gray-600',
  Dead: 'bg-red-100 text-red-600',
}

function Bullets({ items }: { items: string | string[] | undefined | null }) {
  if (!items) return <span className="text-gray-300 text-xs">—</span>
  const arr = Array.isArray(items) ? items : [items]
  if (arr.length === 0) return <span className="text-gray-300 text-xs">—</span>
  return (
    <ul className="space-y-0.5">
      {arr.map((s, i) => (
        <li key={i} className="text-xs text-gray-600 flex gap-1">
          <span className="text-gray-400 mt-0.5">•</span>
          <span>{s}</span>
        </li>
      ))}
    </ul>
  )
}

function YesNo({ val }: { val: boolean | undefined | null }) {
  if (val === undefined || val === null) return <span className="text-gray-300">—</span>
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      val ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
    }`}>
      {val ? 'Y' : 'N'}
    </span>
  )
}

interface Props {
  showupData: ShowupAnalysis
  industry: Industry
  dateRange: DateRange
  intentFilter: IntentLabel[]
  setIntentFilter: (v: IntentLabel[]) => void
}

export default function ShowupTable({
  showupData,
  industry,
  dateRange,
  intentFilter,
  setIntentFilter,
}: Props) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'intent' | 'date'>('intent')

  const rows = useMemo(() => {
    const { from, to } = dateRange
    const q = search.trim().toLowerCase()

    return Object.values(showupData)
      .filter((r: ShowupRecord) => {
        if ('error' in r) return false
        const meta = r._meta
        if (!meta) return false

        // Industry filter
        const ind = meta.industry || r.company_industry || ''
        if (industry !== 'All') {
          const matchMap: Record<Industry, string[]> = {
            'All':                [],
            'Manufacturing':      ['manufacturing', 'mfg'],
            'IT & Consulting':    ['it', 'consulting', 'technology'],
            'Truck Transportation': ['truck', 'transport'],
            'BCS':                ['bcs', 'business consulting', 'business services'],
            'Commercial':         ['commercial', 'retail', 'real estate'],
            'EWWS':               ['ewws', 'environment', 'water', 'waste', 'sustainability'],
          }
          const keywords = matchMap[industry]
          const indLower = ind.toLowerCase()
          if (!keywords.some(k => indLower.includes(k))) {
            if (meta.industry !== industry) return false
          }
        }

        // Date filter
        const d = meta.demo_date
        if (from && d && d < from) return false
        if (to   && d && d > to)   return false

        // Intent filter
        const label = r.deal_closing_intent_label || ''
        if (!intentFilter.includes(label as IntentLabel)) return false

        // Search filter (company, AE, website)
        if (q) {
          const company  = (r.company || meta.prospect_company || '').toLowerCase()
          const ae       = (meta.ae_name || '').toLowerCase()
          const website  = (meta.prospect_website || '').toLowerCase()
          if (!company.includes(q) && !ae.includes(q) && !website.includes(q)) return false
        }

        return true
      })
      .sort((a, b) => {
        if (sortBy === 'date') {
          const da = a._meta?.demo_date || ''
          const db = b._meta?.demo_date || ''
          return db.localeCompare(da)
        }
        const sa = a.deal_closing_intent_score ?? 0
        const sb = b.deal_closing_intent_score ?? 0
        return sb - sa
      }) as ShowupRecord[]
  }, [showupData, industry, dateRange, intentFilter, search, sortBy])

  const toggleIntent = (label: IntentLabel) => {
    setIntentFilter(
      intentFilter.includes(label)
        ? intentFilter.filter(l => l !== label)
        : [...intentFilter, label],
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      {/* Header + filters */}
      <div className="px-6 py-4 border-b border-gray-100 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Show-up Analysis
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">{rows.length} records · scored by deal intent</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">Intent:</span>
            {INTENT_LABELS.map(lbl => (
              <button
                key={lbl}
                onClick={() => toggleIntent(lbl)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  intentFilter.includes(lbl)
                    ? INTENT_BADGE[lbl] + ' border-transparent'
                    : 'bg-white border-gray-300 text-gray-400'
                }`}
              >
                {lbl}
              </button>
            ))}
            <button
              onClick={() => setCollapsed(c => !c)}
              className="ml-2 px-3 py-1 text-xs rounded-full font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              {collapsed ? 'Expand ▼' : 'Collapse ▲'}
            </button>
          </div>
        </div>
        {/* Search + sort row */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search company, AE, or website…"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[260px]"
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">Sort:</span>
            <button
              onClick={() => setSortBy('intent')}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                sortBy === 'intent' ? 'bg-blue-600 text-white border-transparent' : 'bg-white border-gray-300 text-gray-500 hover:border-gray-400'
              }`}
            >
              Intent
            </button>
            <button
              onClick={() => setSortBy('date')}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                sortBy === 'date' ? 'bg-blue-600 text-white border-transparent' : 'bg-white border-gray-300 text-gray-500 hover:border-gray-400'
              }`}
            >
              Date
            </button>
          </div>
          {search && (
            <button
              onClick={() => setSearch('')}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {!collapsed && rows.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-10">
          No show-ups match the selected filters.
        </p>
      ) : !collapsed ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse">
            <thead className="bg-gray-50">
              <tr>
                {[
                  'Company', 'Website', 'Industry', 'Prospect', 'Email',
                  'Designation', 'DM', 'AE', 'Demo Date', 'Intent',
                  'Next Steps', 'Next Steps Details',
                  'Next Call Date', 'Pain Points', 'Buying Signals',
                  'Negative Signals', 'Key Insights', 'Pain Points Addressed',
                  'Sybill',
                ].map(h => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap"
                    style={{ backgroundColor: '#0070FF', color: '#ffffff' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => {
                const meta     = r._meta!
                const company  = r.company || meta.prospect_company
                const isExpanded = expandedRow === company
                return (
                  <tr
                    key={company}
                    className={`hover:bg-gray-50 cursor-pointer transition-colors ${isExpanded ? 'bg-blue-50' : ''}`}
                    onClick={() => setExpandedRow(isExpanded ? null : company)}
                  >
                    {/* Company */}
                    <td className="px-3 py-2 text-sm font-semibold text-gray-900 whitespace-nowrap min-w-[160px] max-w-[220px] truncate">
                      {company}
                    </td>
                    {/* Website */}
                    <td className="px-3 py-2 text-xs whitespace-nowrap max-w-[140px] truncate">
                      {meta.prospect_website ? (
                        <a
                          href={meta.prospect_website.startsWith('http') ? meta.prospect_website : `https://${meta.prospect_website}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline"
                          onClick={e => e.stopPropagation()}
                        >
                          {meta.prospect_website.replace(/^https?:\/\/(www\.)?/, '')}
                        </a>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Industry */}
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {meta.industry || r.company_industry || '—'}
                    </td>
                    {/* Prospect name */}
                    <td className="px-3 py-2 text-sm text-gray-800 whitespace-nowrap">{r.prospect_name || '—'}</td>
                    {/* Email */}
                    <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">
                      {meta.prospect_email}
                    </td>
                    {/* Designation */}
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap min-w-[160px] max-w-[200px] truncate">
                      {r.prospect_designation || '—'}
                    </td>
                    {/* DM */}
                    <td className="px-3 py-2 text-center"><YesNo val={r.is_decision_maker} /></td>
                    {/* AE */}
                    <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{meta.ae_name}</td>
                    {/* Demo date */}
                    <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{meta.demo_date}</td>
                    {/* Intent */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        INTENT_BADGE[r.deal_closing_intent_label || ''] || 'bg-gray-100 text-gray-600'
                      }`}>
                        {r.deal_closing_intent_score}/10 {r.deal_closing_intent_label}
                      </span>
                    </td>
                    {/* Next Steps Y/N */}
                    <td className="px-3 py-2 text-center">
                      <YesNo val={r.next_steps_discussed} />
                    </td>
                    {/* Next Steps Details */}
                    <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
                      <Bullets items={r.next_steps_details} />
                    </td>
                    {/* Next Call Date */}
                    <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">
                      {r.next_call_date || <span className="text-gray-300">—</span>}
                    </td>
                    {/* Pain Points */}
                    <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
                      <Bullets
                        items={r.pain_points?.map(p =>
                          `[${p.severity}] ${p.pain_point}`,
                        )}
                      />
                    </td>
                    {/* Buying Signals */}
                    <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
                      <Bullets items={r.buying_signals} />
                    </td>
                    {/* Negative Signals */}
                    <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
                      <Bullets items={r.negative_signals} />
                    </td>
                    {/* Key Insights */}
                    <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
                      <Bullets items={r.key_insights} />
                    </td>
                    {/* Pain Points Addressed */}
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <YesNo val={r.pain_points_addressed_by_ae} />
                        {r.pain_points_addressed_details && r.pain_points_addressed_details.length > 0 && (
                          <div className="min-w-[180px]">
                            <Bullets items={r.pain_points_addressed_details} />
                          </div>
                        )}
                      </div>
                    </td>
                    {/* Sybill URL */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {meta.sybill_urls?.[0] ? (
                        <a
                          href={meta.sybill_urls[0]}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                          onClick={e => e.stopPropagation()}
                        >
                          Recording ↗
                        </a>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
