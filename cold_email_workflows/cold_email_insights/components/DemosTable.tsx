'use client'

import { useMemo, useState } from 'react'
import type { DemoBooking, Industry, DateRange } from './types'

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  Y: { label: 'Showed',   cls: 'bg-green-100 text-green-700' },
  N: { label: 'No-show',  cls: 'bg-red-100 text-red-700'   },
  P: { label: 'Pending',  cls: 'bg-amber-100 text-amber-700' },
}

const TH = ({ children, onClick, sorted }: {
  children: React.ReactNode
  onClick?: () => void
  sorted?: 'asc' | 'desc' | null
}) => (
  <th
    onClick={onClick}
    className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 whitespace-nowrap ${onClick ? 'cursor-pointer select-none hover:bg-gray-100' : ''}`}
  >
    {children}
    {sorted === 'asc' && ' ↑'}
    {sorted === 'desc' && ' ↓'}
  </th>
)

type SortKey = 'company' | 'ae_name' | 'demo_scheduled_date' | 'created_at_date' | 'industry'

export default function DemosTable({
  demoBookings,
  industry,
  dateRange,
}: {
  demoBookings: DemoBooking[]
  industry: Industry
  dateRange: DateRange
}) {
  const [sortKey, setSortKey] = useState<SortKey>('demo_scheduled_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return demoBookings.filter(d => {
      if (industry !== 'All' && d.industry !== industry) return false
      if (statusFilter !== 'all' && d.show_status !== statusFilter) return false
      const date = d.demo_scheduled_date || d.created_at_date || ''
      if (dateRange.from && date < dateRange.from) return false
      if (dateRange.to   && date > dateRange.to)   return false
      if (q) {
        const co = (d.company || '').toLowerCase()
        const em = (d.email || '').toLowerCase()
        if (!co.includes(q) && !em.includes(q)) return false
      }
      return true
    })
  }, [demoBookings, industry, statusFilter, dateRange, search])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = (a[sortKey] ?? '') as string
      const bv = (b[sortKey] ?? '') as string
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
  }, [filtered, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const counts = useMemo(() => {
    const c = { Y: 0, N: 0, P: 0 }
    filtered.forEach(d => { if (d.show_status in c) c[d.show_status as keyof typeof c]++ })
    return c
  }, [filtered])

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Demos Booked{industry !== 'All' ? ` — ${industry}` : ''}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {filtered.length} total ·{' '}
            <span className="text-green-600 font-medium">{counts.Y} showed</span> ·{' '}
            <span className="text-amber-600 font-medium">{counts.P} pending</span> ·{' '}
            <span className="text-red-600 font-medium">{counts.N} no-shows</span>
          </p>
        </div>
        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search company or email…"
            className="border border-gray-300 rounded-lg px-3 py-1 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[200px]"
          />
          {/* Status filter */}
          <div className="flex gap-1">
            {(['all', 'Y', 'N', 'P'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {s === 'all' ? 'All' : STATUS_BADGE[s]?.label ?? s}
              </button>
            ))}
          </div>
          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="ml-2 px-3 py-1 text-xs rounded-full font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
          >
            {collapsed ? 'Expand ▼' : 'Collapse ▲'}
          </button>
        </div>
      </div>

      {!collapsed && <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <TH onClick={() => toggleSort('company')} sorted={sortKey === 'company' ? sortDir : null}>
                Company
              </TH>
              <TH>Email</TH>
              <TH>Website</TH>
              {industry === 'All' && (
                <TH onClick={() => toggleSort('industry')} sorted={sortKey === 'industry' ? sortDir : null}>
                  Industry
                </TH>
              )}
              <TH onClick={() => toggleSort('ae_name')} sorted={sortKey === 'ae_name' ? sortDir : null}>
                AE
              </TH>
              <TH onClick={() => toggleSort('demo_scheduled_date')} sorted={sortKey === 'demo_scheduled_date' ? sortDir : null}>
                Demo Date
              </TH>
              <TH onClick={() => toggleSort('created_at_date')} sorted={sortKey === 'created_at_date' ? sortDir : null}>
                Booked On
              </TH>
              <TH>Status</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={industry === 'All' ? 8 : 7} className="px-4 py-8 text-center text-sm text-gray-400">
                  No demos match the current filters.
                </td>
              </tr>
            ) : (
              sorted.map((d, i) => {
                const badge = STATUS_BADGE[d.show_status] ?? { label: d.show_status, cls: 'bg-gray-100 text-gray-600' }
                return (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-sm font-medium text-gray-900 whitespace-nowrap">
                      {d.company}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-600 whitespace-nowrap">
                      {d.email}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-500 whitespace-nowrap">
                      {d.website || '—'}
                    </td>
                    {industry === 'All' && (
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {d.industry}
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-sm text-gray-700 whitespace-nowrap">
                      {d.ae_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-700 whitespace-nowrap">
                      {d.demo_scheduled_date || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-500 whitespace-nowrap">
                      {d.created_at_date || '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>}
    </div>
  )
}
