'use client'

import { useEffect, useState, useMemo } from 'react'
import type {
  MetricsData, ShowupAnalysis,
  DateRange, Industry, Tab, IntentLabel,
} from './types'
import { computeMetrics, computeCampaignStats } from './metrics'
import MetricCards from './MetricCards'
import FunnelChart from './FunnelChart'
import CampaignTable from './CampaignTable'
import ShowupTable from './ShowupTable'
import DemosTable from './DemosTable'
import OverviewCompare from './OverviewCompare'
import CompareTab from './CompareTab'

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; industry: Industry }[] = [
  { id: 'overview',           label: 'Overview',             industry: 'All' },
  { id: 'manufacturing',      label: 'Manufacturing',        industry: 'Manufacturing' },
  { id: 'it-consulting',      label: 'IT & Consulting',      industry: 'IT & Consulting' },
  { id: 'truck',              label: 'Truck Transportation', industry: 'Truck Transportation' },
  { id: 'bcs',                label: 'BCS',                  industry: 'BCS' },
  { id: 'commercial',         label: 'Commercial',           industry: 'Commercial' },
  { id: 'ewws',               label: 'EWWS',                 industry: 'EWWS' },
  { id: 'advertising',        label: 'Advertising',          industry: 'Advertising' },
  { id: 'medical-equipment',  label: 'Medical Equipment',    industry: 'Medical Equipment' },
  { id: 'equipment-rental',   label: 'Equipment Rental',     industry: 'Equipment Rental' },
  { id: 'compare',            label: 'Compare',              industry: 'All' },
]

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
      {industry === 'All' ? (
        <OverviewCompare data={data} dateRange={dateRange} />
      ) : (
        <CampaignTable campaigns={campStats} />
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

  const currentTab = TABS.find(t => t.id === activeTab)!

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
                  className="border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="date"
                  value={dateRange.to}
                  onChange={e => setDateRange(d => ({ ...d, to: e.target.value }))}
                  className="border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
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

      {/* Body: sidebar + content — document-level scroll so content passes under frosted header */}
      <div className="flex items-start">

        {/* Vertical tab sidebar — sticky below header */}
        <aside className="w-52 flex-shrink-0 sticky top-[73px] self-start">
          <nav className="flex flex-col gap-1 p-3">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
                style={activeTab === tab.id ? { backgroundColor: '#0070FF' } : {}}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 px-6 py-6">
          {activeTab === 'compare' ? (
            <CompareTab data={data} showupData={showupData} />
          ) : (
            <IndustryTab
              industry={currentTab.industry}
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
