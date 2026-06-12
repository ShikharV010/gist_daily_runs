'use client'

import { useEffect, useState, useMemo } from 'react'
import type {
  MetricsData, ShowupAnalysis,
  DateRange, Industry, Tab, IntentLabel,
} from './types'
import { computeMetrics, computeCampaignStats, getActiveIndustries } from './metrics'
import MetricCards from './MetricCards'
import FunnelChart from './FunnelChart'
import CampaignTable from './CampaignTable'
import ShowupTable from './ShowupTable'
import DemosTable from './DemosTable'
import CompareTab from './CompareTab'
import DailyDetailsTables from './DailyDetailsTables'
import MonthlyOverlayChart from './MonthlyOverlayChart'

// ── Tab config ────────────────────────────────────────────────────────────────

// Slugify an industry name into a stable URL-safe tab id.
// 'IT & Consulting'    → 'it-consulting'
// 'Google Ads (Stopped)' → 'google-ads-stopped'
// 'Financial Services 1-5' → 'financial-services-1-5'
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Derive the tab list from the data: Overview first, every active industry in
// ALPHABETICAL order, Industry Comparison last. New industries auto-appear in
// the right spot without code changes.
function buildTabs(data: MetricsData): { id: Tab; label: string; industry: Industry }[] {
  const industries = [...getActiveIndustries(data)].sort((a, b) => a.localeCompare(b))
  return [
    { id: 'overview', label: 'Overview', industry: 'All' },
    ...industries.map(ind => ({ id: slugify(ind), label: ind, industry: ind })),
    { id: 'compare', label: 'Industry Comparison', industry: 'All' },
  ]
}

// ── Sidebar families ──────────────────────────────────────────────────────────
// With 28+ industries the flat sidebar got unwieldy, so industry tabs are
// grouped into a handful of collapsible families. Rule-based so new industries
// auto-bucket — to re-home one, tweak familyOf() below. Display order =
// FAMILY_ORDER. Overview and Industry Comparison stay pinned (no family).
const FAMILY_ORDER = [
  'Manufacturing',
  'IT & Consulting',
  'Mix & Multi-Industry',
  'Business & Financial Services',
  'Industry Verticals',
  'Google Ads',
  'Other',
] as const
const _VERTICALS = new Set([
  'advertising', 'equipment rental', 'medical equipment', 'ewws',
  'commercial', 'bcs', 'truck transportation', 'construction',
  'staffing & recruitment',
])
function familyOf(industry: string): string {
  const s = industry.toLowerCase().trim()
  if (s.startsWith('mfg') || s === 'manufacturing')                 return 'Manufacturing'
  if (s.startsWith('it ') || s.includes('consulting'))             return 'IT & Consulting'
  if (s.startsWith('mix'))                                          return 'Mix & Multi-Industry'
  if (s.includes('business services') || s.includes('financial services') || s.includes('corporate training'))
                                                                    return 'Business & Financial Services'
  if (s.startsWith('google'))                                      return 'Google Ads'  // Google Ads + Google New(s)
  if (_VERTICALS.has(s))                                            return 'Industry Verticals'
  return 'Other'
}

// ── Industry tab content ──────────────────────────────────────────────────────

function IndustryTab({
  industry,
  dateRange,
  data,
  showupData,
  intentFilter,
  setIntentFilter,
}: {
  industry: Industry
  dateRange: DateRange
  data: MetricsData
  showupData: ShowupAnalysis
  intentFilter: IntentLabel[]
  setIntentFilter: (v: IntentLabel[]) => void
}) {
  const [chartCollapsed, setChartCollapsed] = useState(false)
  const metrics = useMemo(
    () => computeMetrics(industry, dateRange, data),
    [industry, dateRange, data],
  )
  const campStats = useMemo(
    () => computeCampaignStats(industry, dateRange, data),
    [industry, dateRange, data],
  )

  return (
    <div className="space-y-8">
      <MetricCards metrics={metrics} />
      {industry === 'All' ? (
        <>
          <MonthlyOverlayChart data={data} />
          <DailyDetailsTables data={data} />
        </>
      ) : (
        <>
          <div>
            <button
              onClick={() => setChartCollapsed(c => !c)}
              className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 hover:text-gray-700 transition-colors"
            >
              <span>Daily Funnel Trend</span>
              <span>{chartCollapsed ? '▼ Show' : '▲ Hide'}</span>
            </button>
            {!chartCollapsed && (
              <FunnelChart
                timeSeries={data.time_series.daily}
                industry={industry}
                dateRange={dateRange}
              />
            )}
          </div>
          <CampaignTable campaigns={campStats} />
        </>
      )}
      {industry !== 'All' && (
        <DemosTable
          demoBookings={data.demo_bookings}
          industry={industry}
          dateRange={dateRange}
        />
      )}
      {industry !== 'All' && (
        <ShowupTable
          showupData={showupData}
          industry={industry}
          dateRange={dateRange}
          intentFilter={intentFilter}
          setIntentFilter={setIntentFilter}
        />
      )}
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data,         setData]         = useState<MetricsData | null>(null)
  const [showupData,   setShowupData]   = useState<ShowupAnalysis>({})
  const [activeTab,    setActiveTab]    = useState<Tab>('overview')
  const [dateRange,    setDateRange]    = useState<DateRange>({ from: '', to: '' })
  const [intentFilter, setIntentFilter] = useState<IntentLabel[]>(['Hot', 'Warm', 'Cold', 'Dead'])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/metrics').then(r => r.json()),
      fetch('/api/showup-analysis').then(r => r.json()),
    ])
      .then(([m, s]) => {
        setData(m)
        setShowupData(s || {})
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const tabs = useMemo(() => (data ? buildTabs(data) : []), [data])
  const currentTab = tabs.find(t => t.id === activeTab) ?? tabs[0]

  // Split tabs into pinned (Overview / Comparison) and the industry tabs, then
  // group the industry tabs into ordered families for the collapsible sidebar.
  const { overviewTab, compareTab, families } = useMemo(() => {
    const overview = tabs.find(t => t.id === 'overview')
    const compare  = tabs.find(t => t.id === 'compare')
    const industryTabs = tabs.filter(t => t.id !== 'overview' && t.id !== 'compare')
    const byFamily = new Map<string, typeof industryTabs>()
    for (const t of industryTabs) {
      const f = familyOf(t.industry)
      if (!byFamily.has(f)) byFamily.set(f, [])
      byFamily.get(f)!.push(t)
    }
    const known = FAMILY_ORDER as readonly string[]
    const ordered = [
      ...known.filter(f => byFamily.has(f)),
      ...[...byFamily.keys()].filter(f => !known.includes(f)),  // safety: unmapped
    ].map(name => ({ name, tabs: byFamily.get(name)! }))
    return { overviewTab: overview, compareTab: compare, families: ordered }
  }, [tabs])

  // Collapsed families. Default: all collapsed so the sidebar opens compact;
  // the family holding the active tab is force-shown regardless (see render).
  const [collapsedFams, setCollapsedFams] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (families.length) setCollapsedFams(new Set(families.map(f => f.name)))
  }, [families.length])
  const toggleFamily = (name: string) =>
    setCollapsedFams(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  const activeFamily = currentTab ? familyOf(currentTab.industry) : ''

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500 text-sm">
        Loading…
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="flex h-screen items-center justify-center text-red-500 text-sm">
        {error || 'No data. Run python etl.py first.'}
      </div>
    )
  }

  return (
    <div className="min-h-screen dashboard-bg">
      {/* Header — logo left | title center | last-updated + date range right */}
      <header className="sticky top-0 z-20 border-b px-6 py-4"
              style={{
                backgroundColor: 'rgba(255,255,255,0.35)',
                backdropFilter: 'blur(24px) saturate(1.8)',
                WebkitBackdropFilter: 'blur(24px) saturate(1.8)',
                borderColor: 'rgba(229,231,235,0.5)',
                borderBottomLeftRadius: '20px',
                borderBottomRightRadius: '20px',
              }}>
        <div className="max-w-[1800px] mx-auto grid grid-cols-3 items-center gap-4">
          {/* Left: logo */}
          <img src="/gushwork-logo.svg" alt="Gushwork" className="h-6 w-auto" />

          {/* Center: title only */}
          <h1 className="text-center text-lg font-bold text-gray-900">In-House Cold Email Insights</h1>

          {/* Right: last updated + date filter */}
          <div className="flex flex-col items-end gap-1.5 text-sm">
            <p className="text-xs text-gray-400">
              Last updated: {new Date(data.generated_at).toLocaleString()}
            </p>
            {activeTab !== 'compare' && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 text-xs">Date range:</span>
                <input
                  type="date"
                  value={dateRange.from}
                  onChange={e => setDateRange(d => ({ ...d, from: e.target.value }))}
                  className="border border-gray-400 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="date"
                  value={dateRange.to}
                  onChange={e => setDateRange(d => ({ ...d, to: e.target.value }))}
                  className="border border-gray-400 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {(dateRange.from || dateRange.to) && (
                  <button
                    onClick={() => setDateRange({ from: '', to: '' })}
                    className="text-xs hover:underline"
                    style={{ color: '#0070FF' }}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body: sidebar + content — wrapped in max-w-[1800px] + px-6 to align
          exactly with the header above (sidebar left edge = logo left edge;
          main right edge = date-filter right edge). */}
      <div className="max-w-[1800px] mx-auto px-6 flex items-start">

        {/* Vertical tab sidebar — sticky below header, internally scrollable so
            18+ industries don't get cut off on shorter viewports. */}
        <aside className="w-52 flex-shrink-0 sticky top-[73px] self-start max-h-[calc(100vh-73px)] overflow-y-auto">
          <nav className="flex flex-col gap-0.5 p-3">
            {/* Overview — pinned at top */}
            {overviewTab && (
              <button
                onClick={() => setActiveTab(overviewTab.id)}
                className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === overviewTab.id ? 'text-white' : 'text-gray-700 hover:bg-gray-100'
                }`}
                style={activeTab === overviewTab.id ? { backgroundColor: '#0070FF' } : {}}
              >
                {overviewTab.label}
              </button>
            )}

            {/* Industry tabs grouped into collapsible families.
                Clean rows: left chevron, title-case, no counts; children
                indented under a thin guide line. */}
            {families.map(fam => {
              // Force-show the family that holds the active tab even if collapsed,
              // so the highlighted tab is never hidden.
              const open = !collapsedFams.has(fam.name) || fam.name === activeFamily
              return (
                <div key={fam.name} className="flex flex-col">
                  <button
                    onClick={() => toggleFamily(fam.name)}
                    aria-expanded={open}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      className={`w-3 h-3 flex-shrink-0 text-gray-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M4.5 2.5 L8 6 L4.5 9.5" />
                    </svg>
                    <span className="truncate">{fam.name}</span>
                  </button>
                  {open && (
                    <div className="ml-4 mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-gray-200 pl-2">
                      {fam.tabs.map(tab => (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          title={tab.label}
                          className={`text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-colors truncate ${
                            activeTab === tab.id ? 'text-white' : 'text-gray-600 hover:bg-gray-100'
                          }`}
                          style={activeTab === tab.id ? { backgroundColor: '#0070FF' } : {}}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Industry Comparison — pinned at bottom */}
            {compareTab && (
              <button
                onClick={() => setActiveTab(compareTab.id)}
                className={`text-left px-4 py-2.5 mt-1 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === compareTab.id ? 'text-white' : 'text-gray-700 hover:bg-gray-100'
                }`}
                style={activeTab === compareTab.id ? { backgroundColor: '#0070FF' } : {}}
              >
                {compareTab.label}
              </button>
            )}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 px-4 py-6 pb-12">
          {activeTab === 'compare' ? (
            <CompareTab data={data} showupData={showupData} />
          ) : (
            <IndustryTab
              industry={currentTab!.industry}
              dateRange={dateRange}
              data={data}
              showupData={showupData}
              intentFilter={intentFilter}
              setIntentFilter={setIntentFilter}
            />
          )}
        </main>
      </div>
    </div>
  )
}
