'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell, ComposedChart,
  Area, ReferenceLine,
} from 'recharts'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────
type DailyRow = {
  date: string
  interested: number
  demos: number
  showups: number
  by_industry: Record<string, { interested: number; demos: number; showups: number }>
  by_hook: Record<string, { interested: number; demos: number; showups: number }>
  by_campaign: Record<string, { interested: number; demos: number; showups: number }>
}
type Campaign = {
  id: number; name: string; industry: string; status: string
  emails_sent: number; total_leads_contacted: number; replied: number
  interested: number; bounced: number; reply_rate: number; interested_rate: number
  interested_count_enriched: number; demos_booked: number; showups: number
  demo_rate: number; showup_rate: number; hook_a_interested: number; hook_b_interested: number
}
type HookMetric = {
  hook: string; label: string
  interested: number; demos: number; showups: number
  demo_rate: number; showup_rate: number
}
type IndustryMetric = {
  industry: string; campaigns: number; emails_sent: number
  total_leads_contacted: number; replied: number; interested: number
  interested_enriched: number; demos_booked: number; showups: number
  reply_rate: number; interested_rate: number
  demo_rate_from_interested: number; showup_rate_from_demos: number
}
type InterestedLead = {
  lead_id: number; email: string; campaign_id: number; campaign_name: string
  industry: string; hook: string; booked_demo: boolean; is_showup: boolean
  demo_status: string | null; demo_date: string | null; date_received: string
  date_est: string
}
type Metrics = {
  generated_at: string
  totals: {
    total_emails_sent: number; total_leads_contacted: number
    total_interested: number; total_interested_enriched: number
    total_demos: number; total_showups: number; total_reply_rate: number
    reply_rate: number; interested_rate: number
    demo_rate_from_interested: number; showup_rate_from_demos: number
    emails_per_demo: number; interested_per_1000: number; demos_per_1000: number
    date_min: string; date_max: string
  }
  campaigns: Campaign[]
  hooks: HookMetric[]
  industries: IndustryMetric[]
  interested_leads: InterestedLead[]
  time_series: { daily: DailyRow[] }
}
type DateRange = { from: string; to: string }
type Preset = '7d' | '14d' | '30d' | 'all'

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  interested: '#6366f1',
  demos:      '#10b981',
  showups:    '#f59e0b',
  hookA:      '#6366f1',
  hookB:      '#f59e0b',
  replied:    '#8b5cf6',
  grid:       '#1f2937',
  axis:       '#6b7280',
  tooltip:    { bg: '#111827', border: '#374151' },
}
const IND_COLORS: Record<string, string> = {
  'IT & Consulting':    '#6366f1',
  'Manufacturing':      '#10b981',
  'Truck Transportation': '#f59e0b',
  'Other':              '#ef4444',
  'Follow-ups':         '#8b5cf6',
  'Meta/Other':         '#6b7280',
}
const indColor = (ind: string) => IND_COLORS[ind] ?? '#6b7280'

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n?: number | null) => n == null ? '—' : n.toLocaleString()
const pct  = (n?: number | null) => n == null ? '—' : `${Number(n).toFixed(1)}%`
const fmtD = (d: string) => {
  const [, m, day] = d.split('-')
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]} ${+day}`
}
const addDays = (d: string, n: number) => {
  const dt = new Date(d + 'T12:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => {
  const dt = new Date()
  dt.setDate(dt.getDate() - n)
  return dt.toISOString().slice(0, 10)
}

function delta(curr: number, prev: number) {
  if (!prev) return null
  return Math.round((curr - prev) / prev * 100)
}

// ── Sub-components ────────────────────────────────────────────────────────────
const TT = ({ contentStyle, ...p }: any) => (
  <Tooltip
    contentStyle={{ backgroundColor: C.tooltip.bg, border: `1px solid ${C.tooltip.border}`, color: '#fff', borderRadius: 8 }}
    {...p}
  />
)

function StatCard({
  label, value, sub, delta: d, color,
}: { label: string; value: string | number; sub?: string; delta?: number | null; color?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col gap-1">
      <p className="text-gray-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-white" style={color ? { color } : {}}>{value}</p>
      <div className="flex items-center gap-2 min-h-4">
        {sub && <p className="text-gray-500 text-xs">{sub}</p>}
        {d != null && (
          <span className={clsx('text-xs font-medium', d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {d >= 0 ? '▲' : '▼'} {Math.abs(d)}% vs prev
          </span>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">{children}</h2>
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('bg-gray-900 rounded-xl border border-gray-800 p-5', className)}>
      {children}
    </div>
  )
}

// ── Date Filter ───────────────────────────────────────────────────────────────
function DateFilter({
  range, setRange, preset, setPreset, compare, setCompare, dataMin, dataMax,
}: {
  range: DateRange; setRange: (r: DateRange) => void
  preset: Preset; setPreset: (p: Preset) => void
  compare: boolean; setCompare: (b: boolean) => void
  dataMin: string; dataMax: string
}) {
  const presets: { key: Preset; label: string }[] = [
    { key: '7d',  label: '7 days' },
    { key: '14d', label: '14 days' },
    { key: '30d', label: '30 days' },
    { key: 'all', label: 'All time' },
  ]
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
        {presets.map(p => (
          <button
            key={p.key}
            onClick={() => {
              setPreset(p.key)
              if (p.key === 'all') setRange({ from: dataMin, to: dataMax })
              else setRange({ from: daysAgo(+p.key.replace('d', '')), to: today() })
            }}
            className={clsx(
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              preset === p.key ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
            )}
          >{p.label}</button>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <input type="date" value={range.from}
          onChange={e => { setPreset('all'); setRange({ ...range, from: e.target.value }) }}
          className="bg-gray-900 border border-gray-800 text-gray-300 text-xs rounded px-2 py-1"
        />
        <span className="text-gray-600 text-xs">→</span>
        <input type="date" value={range.to}
          onChange={e => { setPreset('all'); setRange({ ...range, to: e.target.value }) }}
          className="bg-gray-900 border border-gray-800 text-gray-300 text-xs rounded px-2 py-1"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
        <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}
          className="accent-indigo-500" />
        Compare prev period
      </label>
    </div>
  )
}

// ── TABS ──────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Hooks', 'Campaigns', 'Industries', 'Leads'] as const
type Tab = typeof TABS[number]

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [raw, setRaw]       = useState<Metrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab]       = useState<Tab>('Overview')
  const [preset, setPreset] = useState<Preset>('all')
  const [range, setRange]   = useState<DateRange>({ from: '', to: '' })
  const [compare, setCompare] = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<number | null>(null)
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/metrics').then(r => r.json()).then(d => {
      setRaw(d)
      if (d.totals?.date_min) setRange({ from: d.totals.date_min, to: d.totals.date_max || today() })
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // ── Filtered data ─────────────────────────────────────────────────────────
  const { filteredLeads, prevLeads, filteredSeries, prevSeries } = useMemo(() => {
    if (!raw) return { filteredLeads: [], prevLeads: [], filteredSeries: [], prevSeries: [] }
    const { from, to } = range
    const inRange = (d: string) => d >= from && d <= to
    const leads = raw.interested_leads.filter(l => l.date_est && inRange(l.date_est))
    const series = raw.time_series.daily.filter(d => inRange(d.date))

    // Previous period (same duration)
    const days = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000))
    const prevFrom = addDays(from, -days)
    const prevTo   = addDays(to,   -days)
    const pLeads   = raw.interested_leads.filter(l => l.date_est && l.date_est >= prevFrom && l.date_est <= prevTo)
    const pSeries  = raw.time_series.daily.filter(d => d.date >= prevFrom && d.date <= prevTo)

    return { filteredLeads: leads, prevLeads: pLeads, filteredSeries: series, prevSeries: pSeries }
  }, [raw, range])

  // ── Derived stats from filtered leads ─────────────────────────────────────
  const stats = useMemo(() => {
    const sum = (arr: InterestedLead[], fn: (l: InterestedLead) => boolean) => arr.filter(fn).length
    const mk = (arr: InterestedLead[]) => ({
      interested: arr.length,
      demos:      sum(arr, l => l.booked_demo),
      showups:    sum(arr, l => l.is_showup),
      hookA:      sum(arr, l => l.hook === 'A'),
      hookB:      sum(arr, l => l.hook === 'B'),
    })
    const curr = mk(filteredLeads)
    const prev = mk(prevLeads)

    // by campaign
    const byCamp: Record<number, ReturnType<typeof mk>> = {}
    if (raw) {
      for (const c of raw.campaigns) {
        byCamp[c.id] = mk(filteredLeads.filter(l => l.campaign_id === c.id))
      }
    }
    // by industry
    const byInd: Record<string, ReturnType<typeof mk>> = {}
    if (raw) {
      const inds = [...new Set(raw.interested_leads.map(l => l.industry))]
      for (const ind of inds) {
        byInd[ind] = mk(filteredLeads.filter(l => l.industry === ind))
      }
    }
    // by hook + industry
    const hookByInd: Record<string, { A: number; B: number; demosA: number; demosB: number }> = {}
    for (const lead of filteredLeads) {
      if (!hookByInd[lead.industry]) hookByInd[lead.industry] = { A:0, B:0, demosA:0, demosB:0 }
      if (lead.hook === 'A') { hookByInd[lead.industry].A++; if (lead.booked_demo) hookByInd[lead.industry].demosA++ }
      if (lead.hook === 'B') { hookByInd[lead.industry].B++; if (lead.booked_demo) hookByInd[lead.industry].demosB++ }
    }

    return { curr, prev, byCamp, byInd, hookByInd }
  }, [filteredLeads, prevLeads, raw])

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
      Loading metrics...
    </div>
  )
  if (!raw || (raw as any).error) return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-3">
      <p className="text-red-400">{(raw as any)?.error ?? 'Failed to load'}</p>
      <code className="text-xs text-gray-500 bg-gray-900 px-3 py-1.5 rounded">python patch_demos.py</code>
    </div>
  )

  const { totals, campaigns, industries } = raw
  const { curr, prev } = stats

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-lg">Cold Email Insights</h1>
            <p className="text-gray-500 text-xs">Updated {new Date(raw.generated_at).toLocaleString()} · EST</p>
          </div>
          <div className="flex gap-1">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                  tab === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                )}>{t}</button>
            ))}
          </div>
        </div>
        <DateFilter
          range={range} setRange={setRange}
          preset={preset} setPreset={setPreset}
          compare={compare} setCompare={setCompare}
          dataMin={totals.date_min} dataMax={totals.date_max}
        />
      </div>

      <div className="px-6 py-6 space-y-8">

        {/* ── OVERVIEW ────────────────────────────────────────────────── */}
        {tab === 'Overview' && (
          <OverviewTab
            totals={totals} curr={curr} prev={compare ? prev : null}
            campaigns={campaigns} industries={industries}
            filteredLeads={filteredLeads} filteredSeries={filteredSeries}
            stats={stats}
          />
        )}

        {/* ── HOOKS ───────────────────────────────────────────────────── */}
        {tab === 'Hooks' && (
          <HooksTab
            hooks={raw.hooks} filteredLeads={filteredLeads}
            stats={stats} curr={curr}
          />
        )}

        {/* ── CAMPAIGNS ───────────────────────────────────────────────── */}
        {tab === 'Campaigns' && (
          <CampaignsTab
            campaigns={campaigns} filteredLeads={filteredLeads}
            filteredSeries={filteredSeries} stats={stats}
            selected={selectedCampaign} setSelected={setSelectedCampaign}
          />
        )}

        {/* ── INDUSTRIES ──────────────────────────────────────────────── */}
        {tab === 'Industries' && (
          <IndustriesTab
            industries={industries} filteredLeads={filteredLeads}
            filteredSeries={filteredSeries} stats={stats}
            selected={selectedIndustry} setSelected={setSelectedIndustry}
          />
        )}

        {/* ── LEADS ───────────────────────────────────────────────────── */}
        {tab === 'Leads' && <LeadsTab leads={filteredLeads} />}
      </div>
    </div>
  )
}

// ── OVERVIEW TAB ──────────────────────────────────────────────────────────────
function OverviewTab({ totals, curr, prev, campaigns, industries, filteredLeads, filteredSeries, stats }: any) {
  const demoRate  = curr.demos      / Math.max(curr.interested, 1) * 100
  const showRate  = curr.showups    / Math.max(curr.demos, 1)      * 100

  const pDemoRate  = prev ? prev.demos   / Math.max(prev.interested, 1) * 100 : null
  const pShowRate  = prev ? prev.showups / Math.max(prev.demos, 1)      * 100 : null

  return (
    <div className="space-y-8">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard label="Emails Sent"    value={fmt(totals.total_emails_sent)} sub="all time" />
        <StatCard label="Contacted"      value={fmt(totals.total_leads_contacted)} sub="all time" />
        <StatCard label="Reply Rate"     value={pct(totals.reply_rate)} />
        <StatCard label="Interested"     value={fmt(curr.interested)}
          delta={prev ? delta(curr.interested, prev.interested) : null}
          sub={`${pct(totals.interested_rate)} of contacted`} color={C.interested} />
        <StatCard label="Demos Booked"   value={fmt(curr.demos)}
          delta={prev ? delta(curr.demos, prev.demos) : null}
          sub={`${pct(demoRate)} of interested`} color={C.demos} />
        <StatCard label="Show-ups"       value={fmt(curr.showups)}
          delta={prev ? delta(curr.showups, prev.showups) : null}
          sub={`${pct(showRate)} of demos`} color={C.showups} />
        <StatCard label="Emails/Demo"    value={fmt(totals.emails_per_demo)} sub="efficiency" />
      </div>

      {/* Funnel line chart */}
      <Card>
        <SectionTitle>Daily Funnel</SectionTitle>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={filteredSeries} margin={{ top:5, right:20, left:0, bottom:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
            <TT labelFormatter={(l: string) => fmtD(l)} />
            <Legend />
            <Line type="monotone" dataKey="interested" name="Interested" stroke={C.interested} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="demos"      name="Demos"      stroke={C.demos}      strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="showups"    name="Show-ups"   stroke={C.showups}    strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Industry breakdown over time */}
      <Card>
        <SectionTitle>Daily Interested by Industry</SectionTitle>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={filteredSeries} margin={{ top:5, right:20, left:0, bottom:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
            <TT labelFormatter={(l: string) => fmtD(l)} />
            <Legend />
            {Object.keys(IND_COLORS).filter(ind => ind !== 'Meta/Other').map(ind => (
              <Bar key={ind} dataKey={`by_industry.${ind}.interested`} name={ind}
                stackId="a" fill={indColor(ind)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Efficiency metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Int / 1k Contacted" value={fmt(totals.interested_per_1000)} />
        <StatCard label="Demos / 1k Contacted" value={fmt(totals.demos_per_1000)} />
        <StatCard label="Reply→Interested" value={pct(totals.interested_rate)} />
        <StatCard label="Demo→Show-up" value={pct(totals.showup_rate_from_demos)} />
      </div>

      {/* Industry performance dual-axis */}
      <Card>
        <SectionTitle>Industry Performance</SectionTitle>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart
            data={Object.entries(stats.byInd)
              .filter(([, v]: any) => v.interested > 0)
              .map(([ind, v]: any) => ({
                industry: ind.length > 14 ? ind.slice(0,14)+'…' : ind,
                fullName: ind,
                interested: v.interested, demos: v.demos, showups: v.showups,
                demoRate: v.interested ? +(v.demos/v.interested*100).toFixed(1) : 0,
              }))
              .sort((a,b) => b.interested - a.interested)}
            margin={{ top:5, right:40, left:0, bottom:5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="industry" tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis yAxisId="left"  tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" unit="%" tick={{ fill: C.axis, fontSize: 11 }} />
            <TT
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs space-y-1">
                    <p className="font-semibold text-white">{d.fullName}</p>
                    <p className="text-gray-300">Interested: <span className="text-indigo-400 font-bold">{d.interested}</span></p>
                    <p className="text-gray-300">Demos: <span className="text-emerald-400 font-bold">{d.demos}</span></p>
                    <p className="text-gray-300">Show-ups: <span className="text-amber-400 font-bold">{d.showups}</span></p>
                    <p className="text-gray-300">Demo rate: <span className="text-emerald-400 font-bold">{d.demoRate}%</span></p>
                  </div>
                )
              }}
            />
            <Legend />
            <Bar yAxisId="left" dataKey="interested" name="Interested" fill={C.interested} radius={[4,4,0,0]} />
            <Bar yAxisId="left" dataKey="demos"      name="Demos"      fill={C.demos}      radius={[4,4,0,0]} />
            <Line yAxisId="right" type="monotone" dataKey="demoRate" name="Demo %" stroke={C.showups} strokeWidth={2} dot={{ r:4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ── HOOKS TAB ─────────────────────────────────────────────────────────────────
function HooksTab({ hooks, filteredLeads, stats, curr }: any) {
  const [metric, setMetric] = useState<'interested'|'demos'>('interested')

  // Hook funnel data
  const hookFunnel = hooks.map((h: HookMetric) => {
    const leads = filteredLeads.filter((l: InterestedLead) => l.hook === h.hook)
    const demos  = leads.filter((l: InterestedLead) => l.booked_demo).length
    const shows  = leads.filter((l: InterestedLead) => l.is_showup).length
    return {
      name: `Hook ${h.hook} — ${h.label}`,
      hook: h.hook,
      interested: leads.length,
      demos,
      showups: shows,
      demoRate:  leads.length ? +(demos/leads.length*100).toFixed(1) : 0,
      showRate:  demos ? +(shows/demos*100).toFixed(1) : 0,
    }
  })

  // By industry stacked bar
  const indData = Object.entries(stats.hookByInd)
    .map(([ind, v]: any) => ({
      industry: ind.length > 16 ? ind.slice(0,16)+'…' : ind,
      fullName: ind,
      hookA: metric === 'interested' ? v.A : v.demosA,
      hookB: metric === 'interested' ? v.B : v.demosB,
    }))
    .filter(d => d.hookA + d.hookB > 0)
    .sort((a,b) => (b.hookA+b.hookB) - (a.hookA+a.hookB))

  return (
    <div className="space-y-8">
      {/* Hook cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {hookFunnel.map((h: any) => (
          <Card key={h.hook}>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl font-bold" style={{ color: h.hook === 'A' ? C.hookA : C.hookB }}>
                Hook {h.hook}
              </span>
              <span className="text-gray-400 text-sm">{hooks.find((x:any)=>x.hook===h.hook)?.label}</span>
            </div>
            <div className="space-y-2 text-sm">
              {[
                { label: 'Interested', val: h.interested, color: C.interested },
                { label: 'Demos',      val: h.demos,      color: C.demos,   sub: `${h.demoRate}% of interested` },
                { label: 'Show-ups',   val: h.showups,    color: C.showups, sub: `${h.showRate}% of demos` },
              ].map(row => (
                <div key={row.label} className="flex justify-between items-center py-1.5 border-b border-gray-800/60">
                  <span className="text-gray-400">{row.label}</span>
                  <div className="text-right">
                    <span className="font-semibold" style={{ color: row.color }}>{row.val}</span>
                    {row.sub && <span className="text-gray-500 text-xs ml-2">{row.sub}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* Hook funnel comparison */}
      <Card>
        <SectionTitle>Hook Funnel Comparison</SectionTitle>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={[
            { stage: 'Interested', A: hookFunnel[0]?.interested, B: hookFunnel[1]?.interested },
            { stage: 'Demos',      A: hookFunnel[0]?.demos,      B: hookFunnel[1]?.demos },
            { stage: 'Show-ups',   A: hookFunnel[0]?.showups,    B: hookFunnel[1]?.showups },
          ]} margin={{ top:5, right:20, left:0, bottom:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="stage" tick={{ fill: C.axis, fontSize: 12 }} />
            <YAxis tick={{ fill: C.axis, fontSize: 12 }} />
            <TT />
            <Legend />
            <Bar dataKey="A" name="Hook A — one-page" fill={C.hookA} radius={[4,4,0,0]} />
            <Bar dataKey="B" name="Hook B — 4-5 pages" fill={C.hookB} radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Stacked by industry */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <SectionTitle>Hook Split by Industry</SectionTitle>
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {(['interested','demos'] as const).map(m => (
              <button key={m} onClick={() => setMetric(m)}
                className={clsx('px-3 py-1 rounded text-xs font-medium capitalize transition-colors',
                  metric === m ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
                )}>{m}</button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={indData} margin={{ top:5, right:20, left:0, bottom:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="industry" tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
            <TT
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs space-y-1">
                    <p className="font-semibold text-white">{d.fullName}</p>
                    <p>Hook A: <span className="text-indigo-400 font-bold">{d.hookA}</span></p>
                    <p>Hook B: <span className="text-amber-400 font-bold">{d.hookB}</span></p>
                  </div>
                )
              }}
            />
            <Legend />
            <Bar dataKey="hookA" name="Hook A" stackId="s" fill={C.hookA} radius={[0,0,0,0]} />
            <Bar dataKey="hookB" name="Hook B" stackId="s" fill={C.hookB} radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ── CAMPAIGNS TAB ─────────────────────────────────────────────────────────────
function CampaignsTab({ campaigns, filteredLeads, filteredSeries, stats, selected, setSelected }: any) {
  const activeCamps = campaigns.filter((c: Campaign) => c.total_leads_contacted > 0)

  if (selected !== null) {
    const camp = campaigns.find((c: Campaign) => c.id === selected)
    if (!camp) return null
    const campLeads  = filteredLeads.filter((l: InterestedLead) => l.campaign_id === selected)
    const campSeries = filteredSeries.map((d: DailyRow) => ({
      date: d.date,
      interested: d.by_campaign[String(selected)]?.interested ?? 0,
      demos:      d.by_campaign[String(selected)]?.demos      ?? 0,
      showups:    d.by_campaign[String(selected)]?.showups    ?? 0,
    })).filter((d: any) => d.interested + d.demos + d.showups > 0)

    const demos   = campLeads.filter((l: InterestedLead) => l.booked_demo).length
    const showups = campLeads.filter((l: InterestedLead) => l.is_showup).length

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setSelected(null)}
            className="text-gray-400 hover:text-white text-sm flex items-center gap-1">
            ← All campaigns
          </button>
          <span className="text-gray-600">/</span>
          <span className="text-white font-medium text-sm">{camp.name}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Contacted"  value={fmt(camp.total_leads_contacted)} />
          <StatCard label="Reply Rate" value={pct(camp.reply_rate)} />
          <StatCard label="Interested" value={fmt(campLeads.length)} color={C.interested} />
          <StatCard label="Demos"      value={fmt(demos)}   sub={`${pct(campLeads.length ? demos/campLeads.length*100 : 0)} of int.`} color={C.demos} />
          <StatCard label="Show-ups"   value={fmt(showups)} sub={`${pct(demos ? showups/demos*100 : 0)} of demos`} color={C.showups} />
        </div>
        <Card>
          <SectionTitle>Daily Activity — {camp.name}</SectionTitle>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={campSeries} margin={{ top:5, right:20, left:0, bottom:5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: C.axis, fontSize: 11 }} />
              <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
              <TT labelFormatter={(l: string) => fmtD(l)} />
              <Legend />
              <Line type="monotone" dataKey="interested" stroke={C.interested} strokeWidth={2} dot={{ r:3 }} name="Interested" />
              <Line type="monotone" dataKey="demos"      stroke={C.demos}      strokeWidth={2} dot={{ r:3 }} name="Demos" />
              <Line type="monotone" dataKey="showups"    stroke={C.showups}    strokeWidth={2} dot={{ r:3 }} name="Show-ups" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <SectionTitle>Hook split</SectionTitle>
          <div className="flex gap-6 text-sm">
            {[{h:'A',color:C.hookA},{h:'B',color:C.hookB}].map(({h, color}) => {
              const n = campLeads.filter((l:InterestedLead)=>l.hook===h).length
              return (
                <div key={h} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{background:color}}/>
                  <span className="text-gray-400">Hook {h}:</span>
                  <span className="font-semibold" style={{color}}>{n}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary bar chart */}
      <Card>
        <SectionTitle>Interested by Campaign</SectionTitle>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={activeCamps
              .filter((c: Campaign) => stats.byCamp[c.id]?.interested > 0)
              .sort((a: Campaign, b: Campaign) => (stats.byCamp[b.id]?.interested??0) - (stats.byCamp[a.id]?.interested??0))
              .map((c: Campaign) => ({
                name: c.name.slice(0,28)+'…',
                fullName: c.name,
                interested: stats.byCamp[c.id]?.interested ?? 0,
                demos:      stats.byCamp[c.id]?.demos      ?? 0,
              }))}
            margin={{ top:5, right:20, left:0, bottom:60 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="name" tick={{ fill: C.axis, fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
            <TT
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs">
                    <p className="font-semibold text-white mb-1">{d.fullName}</p>
                    <p>Interested: <span className="text-indigo-400 font-bold">{d.interested}</span></p>
                    <p>Demos: <span className="text-emerald-400 font-bold">{d.demos}</span></p>
                  </div>
                )
              }}
            />
            <Legend />
            <Bar dataKey="interested" name="Interested" fill={C.interested} radius={[4,4,0,0]} />
            <Bar dataKey="demos"      name="Demos"      fill={C.demos}      radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Table */}
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-800 text-xs uppercase">
              {['Campaign','Industry','Contacted','Reply%','Int.','Demos','Show-ups','Demo%','Hook A','Hook B','Status'].map(h => (
                <th key={h} className={clsx('px-4 py-3', h === 'Campaign' || h === 'Industry' ? 'text-left' : 'text-right')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeCamps
              .sort((a: Campaign, b: Campaign) => (stats.byCamp[b.id]?.interested??0) - (stats.byCamp[a.id]?.interested??0))
              .map((c: Campaign) => {
                const s = stats.byCamp[c.id] ?? {}
                const dr = s.interested ? (s.demos/s.interested*100).toFixed(1) : '—'
                return (
                  <tr key={c.id}
                    onClick={() => setSelected(c.id)}
                    className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 text-gray-200 max-w-[200px] truncate">{c.name}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{c.industry}</td>
                    <td className="px-4 py-2.5 text-right">{fmt(c.total_leads_contacted)}</td>
                    <td className="px-4 py-2.5 text-right">{pct(c.reply_rate)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-indigo-400">{fmt(s.interested)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-emerald-400">{fmt(s.demos)}</td>
                    <td className="px-4 py-2.5 text-right text-amber-400">{fmt(s.showups)}</td>
                    <td className="px-4 py-2.5 text-right text-emerald-400">{dr !== '—' ? `${dr}%` : '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-500">{fmt(c.hook_a_interested)}</td>
                    <td className="px-4 py-2.5 text-right text-gray-500">{fmt(c.hook_b_interested)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={clsx('px-2 py-0.5 rounded-full text-xs',
                        c.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-gray-800 text-gray-500'
                      )}>{c.status}</span>
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
        <p className="text-gray-600 text-xs px-4 py-2">Click a row to drill down</p>
      </Card>
    </div>
  )
}

// ── INDUSTRIES TAB ────────────────────────────────────────────────────────────
function IndustriesTab({ industries, filteredLeads, filteredSeries, stats, selected, setSelected }: any) {
  if (selected) {
    const ind        = selected
    const indLeads   = filteredLeads.filter((l: InterestedLead) => l.industry === ind)
    const demos      = indLeads.filter((l: InterestedLead) => l.booked_demo).length
    const showups    = indLeads.filter((l: InterestedLead) => l.is_showup).length
    const indSeries  = filteredSeries.map((d: DailyRow) => ({
      date: d.date,
      interested: d.by_industry[ind]?.interested ?? 0,
      demos:      d.by_industry[ind]?.demos      ?? 0,
      showups:    d.by_industry[ind]?.showups    ?? 0,
    })).filter((d: any) => d.interested + d.demos + d.showups > 0)

    const hookA = indLeads.filter((l:InterestedLead)=>l.hook==='A')
    const hookB = indLeads.filter((l:InterestedLead)=>l.hook==='B')
    const demoA = hookA.filter((l:InterestedLead)=>l.booked_demo).length
    const demoB = hookB.filter((l:InterestedLead)=>l.booked_demo).length

    const indRow = industries.find((i: IndustryMetric) => i.industry === ind)

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-white text-sm">← All industries</button>
          <span className="text-gray-600">/</span>
          <span className="font-medium text-white" style={{ color: indColor(ind) }}>{ind}</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Contacted"  value={fmt(indRow?.total_leads_contacted)} />
          <StatCard label="Reply Rate" value={pct(indRow?.reply_rate)} />
          <StatCard label="Interested" value={fmt(indLeads.length)} color={C.interested} />
          <StatCard label="Demos"      value={fmt(demos)}   sub={pct(indLeads.length ? demos/indLeads.length*100:0)} color={C.demos} />
          <StatCard label="Show-ups"   value={fmt(showups)} sub={pct(demos ? showups/demos*100:0)} color={C.showups} />
        </div>

        {/* Daily funnel */}
        <Card>
          <SectionTitle>Daily Funnel — {ind}</SectionTitle>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={indSeries} margin={{ top:5, right:20, left:0, bottom:5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: C.axis, fontSize: 11 }} />
              <YAxis tick={{ fill: C.axis, fontSize: 11 }} />
              <TT labelFormatter={(l:string) => fmtD(l)} />
              <Legend />
              <Line type="monotone" dataKey="interested" stroke={C.interested} strokeWidth={2} dot={false} name="Interested" />
              <Line type="monotone" dataKey="demos"      stroke={C.demos}      strokeWidth={2} dot={{ r:4 }} name="Demos" />
              <Line type="monotone" dataKey="showups"    stroke={C.showups}    strokeWidth={2} dot={{ r:4 }} name="Show-ups" />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* Conversion rates */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Reply Rate"         value={pct(indRow?.reply_rate)} />
          <StatCard label="Interested Rate"    value={pct(indRow?.interested_rate)} />
          <StatCard label="Demo / Interested"  value={pct(indLeads.length ? demos/indLeads.length*100:0)} color={C.demos} />
        </div>

        {/* Hook comparison */}
        <Card>
          <SectionTitle>Hook A vs Hook B</SectionTitle>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={[
                { stage: 'Interested', A: hookA.length, B: hookB.length },
                { stage: 'Demos',      A: demoA,        B: demoB },
              ]}
              margin={{ top:5, right:20, left:0, bottom:5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
              <XAxis dataKey="stage" tick={{ fill: C.axis, fontSize: 12 }} />
              <YAxis tick={{ fill: C.axis, fontSize: 12 }} />
              <TT />
              <Legend />
              <Bar dataKey="A" name="Hook A" fill={C.hookA} radius={[4,4,0,0]} />
              <Bar dataKey="B" name="Hook B" fill={C.hookB} radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Efficiency */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Emails / Demo" value={indRow ? fmt(Math.round(indRow.emails_sent / Math.max(demos,1))) : '—'} sub="lower is better" />
          <StatCard label="Interested / Demo" value={fmt(demos ? Math.round(indLeads.length/demos) : null)} sub="lower is better" />
        </div>
      </div>
    )
  }

  // Industry cards grid
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {industries
          .filter((i: IndustryMetric) => i.total_leads_contacted > 0)
          .sort((a: IndustryMetric, b: IndustryMetric) => (stats.byInd[b.industry]?.interested??0) - (stats.byInd[a.industry]?.interested??0))
          .map((ind: IndustryMetric) => {
            const s = stats.byInd[ind.industry] ?? {}
            const demoR = s.interested ? (s.demos/s.interested*100).toFixed(1) : '0'
            return (
              <div key={ind.industry}
                onClick={() => setSelected(ind.industry)}
                className="bg-gray-900 rounded-xl border border-gray-800 p-5 cursor-pointer hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-3 h-3 rounded-full" style={{ background: indColor(ind.industry) }} />
                  <h3 className="font-semibold">{ind.industry}</h3>
                  <span className="text-gray-500 text-xs ml-auto">{ind.campaigns} campaigns</span>
                </div>
                <div className="space-y-2 text-sm">
                  {[
                    { label: 'Contacted',    val: fmt(ind.total_leads_contacted) },
                    { label: 'Reply rate',   val: pct(ind.reply_rate), color: '#9ca3af' },
                    { label: 'Interested',   val: fmt(s.interested),   color: C.interested },
                    { label: 'Demos',        val: fmt(s.demos),        color: C.demos, sub: `${demoR}% of int.` },
                    { label: 'Show-ups',     val: fmt(s.showups),      color: C.showups },
                  ].map(row => (
                    <div key={row.label} className="flex justify-between items-center">
                      <span className="text-gray-400">{row.label}</span>
                      <span className="font-medium" style={row.color ? { color: row.color } : {}}>
                        {row.val}{row.sub ? <span className="text-gray-500 text-xs ml-1">({row.sub})</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-gray-600 text-xs mt-3">Click to drill down →</p>
              </div>
            )
          })}
      </div>

      {/* Dual-axis bar + line */}
      <Card>
        <SectionTitle>Conversion Rates by Industry</SectionTitle>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart
            data={industries
              .filter((i: IndustryMetric) => i.total_leads_contacted > 0)
              .map((i: IndustryMetric) => {
                const s = stats.byInd[i.industry] ?? {}
                return {
                  industry: i.industry.length > 14 ? i.industry.slice(0,14)+'…' : i.industry,
                  fullName: i.industry,
                  contacted: i.total_leads_contacted,
                  interested: s.interested ?? 0,
                  demos:      s.demos      ?? 0,
                  showups:    s.showups    ?? 0,
                  intRate:    i.total_leads_contacted ? +((s.interested??0)/i.total_leads_contacted*100).toFixed(2) : 0,
                  demoRate:   s.interested ? +(s.demos/s.interested*100).toFixed(1) : 0,
                }
              })
              .sort((a: any,b: any) => b.interested - a.interested)}
            margin={{ top:5, right:40, left:0, bottom:5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="industry" tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis yAxisId="left"  tick={{ fill: C.axis, fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" unit="%" tick={{ fill: C.axis, fontSize: 11 }} domain={[0,'auto']} />
            <TT
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs space-y-1">
                    <p className="font-semibold text-white">{d.fullName}</p>
                    <p className="text-gray-400">Contacted: {fmt(d.contacted)}</p>
                    <p>Interested: <span className="text-indigo-400 font-bold">{d.interested}</span> <span className="text-gray-500">({d.intRate}%)</span></p>
                    <p>Demos: <span className="text-emerald-400 font-bold">{d.demos}</span></p>
                    <p>Show-ups: <span className="text-amber-400 font-bold">{d.showups}</span></p>
                    <p>Demo rate: <span className="text-emerald-400 font-bold">{d.demoRate}%</span></p>
                  </div>
                )
              }}
            />
            <Legend />
            <Bar yAxisId="left" dataKey="interested" name="Interested" fill={C.interested} radius={[4,4,0,0]} />
            <Bar yAxisId="left" dataKey="demos"      name="Demos"      fill={C.demos}      radius={[4,4,0,0]} />
            <Line yAxisId="right" type="monotone" dataKey="demoRate" name="Demo %" stroke={C.showups} strokeWidth={2} dot={{ r:4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ── LEADS TAB ─────────────────────────────────────────────────────────────────
function LeadsTab({ leads }: { leads: InterestedLead[] }) {
  const [search, setSearch] = useState('')
  const visible = leads
    .filter(l => !search || l.email?.includes(search) || l.campaign_name?.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b) => new Date(b.date_received).getTime() - new Date(a.date_received).getTime())
    .slice(0, 300)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-gray-400 text-sm">{leads.length} interested leads</p>
        <input
          placeholder="Search email or campaign…"
          value={search} onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-gray-300 text-sm rounded px-3 py-1.5 w-72 focus:outline-none focus:border-indigo-600"
        />
      </div>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-800 text-xs uppercase">
              {['Email','Campaign','Industry','Hook','Demo','Show-up','Date'].map(h => (
                <th key={h} className={clsx('px-4 py-3', h==='Email'||h==='Campaign'||h==='Industry'?'text-left':'text-center')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => (
              <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-2 text-gray-200 max-w-[200px] truncate">{l.email}</td>
                <td className="px-4 py-2 text-gray-400 max-w-[200px] truncate text-xs">{l.campaign_name}</td>
                <td className="px-4 py-2 text-gray-400 text-xs">{l.industry}</td>
                <td className="px-4 py-2 text-center">
                  <span className={clsx('px-2 py-0.5 rounded text-xs font-medium',
                    l.hook==='A' ? 'bg-indigo-900/50 text-indigo-400' :
                    l.hook==='B' ? 'bg-amber-900/50 text-amber-400' : 'bg-gray-800 text-gray-500'
                  )}>{l.hook}</span>
                </td>
                <td className="px-4 py-2 text-center">
                  {l.booked_demo ? <span className="text-emerald-400 text-sm">✓</span> : <span className="text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2 text-center">
                  {l.is_showup ? <span className="text-amber-400 text-sm">✓</span> : <span className="text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2 text-center text-gray-500 text-xs whitespace-nowrap">{l.date_est}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.length > 300 && (
          <p className="text-center text-gray-600 text-xs py-2">Showing 300 of {leads.length}</p>
        )}
      </Card>
    </div>
  )
}
