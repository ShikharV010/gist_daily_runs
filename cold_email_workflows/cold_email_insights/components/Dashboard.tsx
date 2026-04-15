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
import CompareTab from './CompareTab'

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; industry: Industry }[] = [
  { id: 'overview',      label: 'Overview',            industry: 'All' },
  { id: 'manufacturing', label: 'Manufacturing',        industry: 'Manufacturing' },
  { id: 'it-consulting', label: 'IT & Consulting',      industry: 'IT & Consulting' },
  { id: 'truck',         label: 'Truck Transportation', industry: 'Truck Transportation' },
  { id: 'compare',       label: 'Compare',              industry: 'All' },
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
      <FunnelChart
        timeSeries={data.time_series.daily}
        industry={industry}
        dateRange={dateRange}
      />
      <CampaignTable campaigns={campStats} />
      <DemosTable
        demoBookings={data.demo_bookings}
        industry={industry}
        dateRange={dateRange}
      />
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-2xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Cold Email Insights</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Last updated: {new Date(data.generated_at).toLocaleString()}
            </p>
          </div>
          {activeTab !== 'compare' && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">Date range:</span>
              <input
                type="date"
                value={dateRange.from}
                onChange={e => setDateRange(d => ({ ...d, from: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="text-gray-400">–</span>
              <input
                type="date"
                value={dateRange.to}
                onChange={e => setDateRange(d => ({ ...d, to: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {(dateRange.from || dateRange.to) && (
                <button
                  onClick={() => setDateRange({ from: '', to: '' })}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Tab bar */}
      <nav className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-screen-2xl mx-auto flex gap-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">
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
  )
}
