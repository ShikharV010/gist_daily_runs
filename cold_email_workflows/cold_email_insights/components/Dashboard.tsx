'use client'

import { useEffect, useState, useMemo } from 'react'
import type {
  MetricsData, ShowupAnalysis, ComputedMetrics, ComputedCampaignRow,
  DateRange, Industry, Tab, IntentLabel, DemoBooking, InterestedLead,
} from './types'
import MetricCards from './MetricCards'
import FunnelChart from './FunnelChart'
import CampaignTable from './CampaignTable'
import ShowupTable from './ShowupTable'
import CompareTab from './CompareTab'

// ── computeMetrics ────────────────────────────────────────────────────────────

export function computeMetrics(
  industry: Industry,
  dateRange: DateRange,
  data: MetricsData,
): ComputedMetrics {
  const today = new Date().toISOString().split('T')[0]
  const { from, to } = dateRange

  const inRange = (d: string | null | undefined, col: 'email' | 'demo' | 'scheduled') => {
    if (!d) return col !== 'email' // emails without date are excluded; demos/scheduled include nulls
    if (from && d < from) return false
    if (to   && d > to)   return false
    return true
  }

  // Filter leads & bookings by industry
  const leadFilter = (l: InterestedLead) =>
    industry === 'All' || l.industry === industry

  const bookingFilter = (b: DemoBooking) =>
    industry === 'All' || b.industry === industry

  // Emails & leads contacted: sum daily_email_stats deltas in date range
  const emailRows = data.daily_email_stats.filter(r =>
    (industry === 'All' || r.industry === industry) && inRange(r.date, 'email'),
  )
  const emails_sent     = emailRows.reduce((s, r) => s + r.emails_delta, 0)
  const leads_contacted = emailRows.reduce((s, r) => s + r.leads_delta, 0)

  // Interested: filter by date_est
  const intLeads = data.interested_leads.filter(l =>
    leadFilter(l) && inRange(l.date_est, 'email'),
  )
  const interested = intLeads.length

  // Replied: campaign totals only (not date-filterable from current data)
  const replied = data.campaigns
    .filter(c => industry === 'All' || c.industry === industry)
    .reduce((s, c) => s + c.replied, 0)

  // Demos booked: filter by created_at_date
  const demosBookedList = data.demo_bookings.filter(
    b => bookingFilter(b) && inRange(b.created_at_date, 'demo'),
  )
  const demos_booked = demosBookedList.length

  // Pending: current-state upcoming demos (no date filter on created_at, just future scheduled)
  const pending_demos = data.demo_bookings.filter(
    b => bookingFilter(b) && b.show_status === 'P' &&
      b.demo_scheduled_date && b.demo_scheduled_date >= today,
  ).length

  // Show-ups: filter by demo_scheduled_date
  const showupList = data.demo_bookings.filter(
    b => bookingFilter(b) && inRange(b.demo_scheduled_date, 'scheduled'),
  )
  const showups          = showupList.filter(b => b.show_status_adj === 'Y').length
  const completed_demos  = showupList.filter(b => b.show_status_adj !== 'P').length
  const noshow           = Math.max(0, completed_demos - showups)

  const pct = (n: number, d: number, digits = 2) =>
    d > 0 ? parseFloat((n / d * 100).toFixed(digits)) : 0

  return {
    campaigns:                data.campaigns.filter(c => industry === 'All' || c.industry === industry).length,
    emails_sent,
    leads_contacted,
    replied,
    interested,
    demos_booked,
    showups,
    pending_demos,
    completed_demos,
    noshow,
    reply_rate_per_sent:      pct(replied,     Math.max(emails_sent, 1)),
    reply_rate_per_contacted: pct(replied,     Math.max(leads_contacted, 1)),
    int_rate_per_sent:        pct(interested,  Math.max(emails_sent, 1), 4),
    int_rate_per_contacted:   pct(interested,  Math.max(leads_contacted, 1), 4),
    demos_per_sent:           pct(demos_booked, Math.max(emails_sent, 1), 4),
    demos_per_contacted:      pct(demos_booked, Math.max(leads_contacted, 1), 4),
    showups_per_sent:         pct(showups,      Math.max(emails_sent, 1), 4),
    showups_per_contacted:    pct(showups,      Math.max(leads_contacted, 1), 4),
    show_rate:                pct(showups,      Math.max(completed_demos, 1)),
    demos_per_interested:     pct(demos_booked, Math.max(interested, 1)),
    showups_per_interested:   pct(showups,      Math.max(interested, 1)),
  }
}

export function computeCampaignStats(
  industry: Industry,
  dateRange: DateRange,
  data: MetricsData,
): ComputedCampaignRow[] {
  const today = new Date().toISOString().split('T')[0]
  const { from, to } = dateRange

  const inRangeDate = (d: string | null | undefined) => {
    if (!d) return false
    if (from && d < from) return false
    if (to   && d > to)   return false
    return true
  }

  const campaigns = data.campaigns.filter(
    c => industry === 'All' || c.industry === industry,
  )

  // Index raw data by campaign_id
  const leadsByCamp: Record<number, InterestedLead[]> = {}
  for (const l of data.interested_leads) {
    if (industry !== 'All' && l.industry !== industry) continue
    if (!leadsByCamp[l.campaign_id]) leadsByCamp[l.campaign_id] = []
    leadsByCamp[l.campaign_id].push(l)
  }

  // Email stats by campaign
  const emailsByCamp: Record<number, { emails: number; leads: number }> = {}
  for (const r of data.daily_email_stats) {
    if (industry !== 'All' && r.industry !== industry) continue
    if (from && r.date < from) continue
    if (to   && r.date > to)   continue
    if (!emailsByCamp[r.campaign_id]) emailsByCamp[r.campaign_id] = { emails: 0, leads: 0 }
    emailsByCamp[r.campaign_id].emails += r.emails_delta
    emailsByCamp[r.campaign_id].leads  += r.leads_delta
  }

  // Build email sets per campaign for booking attribution
  const emailSetByCamp: Record<number, Set<string>> = {}
  for (const [cid, leads] of Object.entries(leadsByCamp)) {
    emailSetByCamp[Number(cid)] = new Set(leads.map(l => l.email))
  }
  // Build reverse: email → campaign_id (from all interested leads, not date-filtered)
  const emailToCamp: Record<string, number> = {}
  for (const l of data.interested_leads) {
    if (industry !== 'All' && l.industry !== industry) continue
    emailToCamp[l.email] = l.campaign_id
  }

  return campaigns.map(c => {
    const cid   = c.id
    const leads = (leadsByCamp[cid] || []).filter(l => inRangeDate(l.date_est))
    const esrow = emailsByCamp[cid] || { emails: 0, leads: 0 }

    // Demos attributed to this campaign via email
    const campEmails = emailSetByCamp[cid] || new Set<string>()
    const campBookings = data.demo_bookings.filter(b => campEmails.has(b.email))

    const demosBooked = campBookings.filter(b => inRangeDate(b.created_at_date)).length
    const showupList  = campBookings.filter(b => inRangeDate(b.demo_scheduled_date))
    const showups     = showupList.filter(b => b.show_status_adj === 'Y').length
    const completed   = showupList.filter(b => b.show_status_adj !== 'P').length
    const pending     = campBookings.filter(
      b => b.show_status === 'P' && b.demo_scheduled_date && b.demo_scheduled_date >= today,
    ).length

    const interested  = leads.length
    const emails_sent = esrow.emails || c.emails_sent
    const leads_cont  = esrow.leads  || c.total_leads_contacted

    const pct = (n: number, d: number, digits = 2) =>
      d > 0 ? parseFloat((n / d * 100).toFixed(digits)) : 0

    return {
      id:       cid,
      name:     c.name,
      industry: c.industry,
      status:   c.status,
      emails_sent,
      total_leads:              c.total_leads,
      leads_contacted:          leads_cont,
      replied:                  c.replied,
      interested,
      demos_booked:             demosBooked,
      showups,
      pending_demos:            pending,
      completed_demos:          completed,
      noshow:                   Math.max(0, completed - showups),
      reply_rate_per_sent:      pct(c.replied,   Math.max(emails_sent, 1)),
      reply_rate_per_contacted: pct(c.replied,   Math.max(leads_cont, 1)),
      int_rate_per_sent:        pct(interested,  Math.max(emails_sent, 1), 4),
      int_rate_per_contacted:   pct(interested,  Math.max(leads_cont, 1), 4),
      demos_per_sent:           pct(demosBooked, Math.max(emails_sent, 1), 4),
      demos_per_contacted:      pct(demosBooked, Math.max(leads_cont, 1), 4),
      showups_per_sent:         pct(showups,     Math.max(emails_sent, 1), 4),
      showups_per_contacted:    pct(showups,     Math.max(leads_cont, 1), 4),
      show_rate:                pct(showups,     Math.max(completed, 1)),
      demos_per_interested:     pct(demosBooked, Math.max(interested, 1)),
      showups_per_interested:   pct(showups,     Math.max(interested, 1)),
    }
  })
}

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; industry: Industry }[] = [
  { id: 'overview',      label: 'Overview',          industry: 'All' },
  { id: 'manufacturing', label: 'Manufacturing',      industry: 'Manufacturing' },
  { id: 'it-consulting', label: 'IT & Consulting',    industry: 'IT & Consulting' },
  { id: 'truck',         label: 'Truck Transportation', industry: 'Truck Transportation' },
  { id: 'compare',       label: 'Compare',            industry: 'All' },
]

// ── Industry tab content ───────────────────────────────────────────────────────

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
      <ShowupTable
        showupData={showupData}
        industry={industry}
        dateRange={dateRange}
        intentFilter={intentFilter}
        setIntentFilter={setIntentFilter}
      />
    </div>
  )
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data,       setData]       = useState<MetricsData | null>(null)
  const [showupData, setShowupData] = useState<ShowupAnalysis>({})
  const [activeTab,  setActiveTab]  = useState<Tab>('overview')
  const [dateRange,  setDateRange]  = useState<DateRange>({ from: '', to: '' })
  const [intentFilter, setIntentFilter] = useState<IntentLabel[]>(['Hot', 'Warm', 'Cold', 'Dead'])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/metrics').then(r => r.json()),
      fetch('/api/showup-analysis').then(r => r.json()),
    ])
      .then(([m, s]) => {
        setData(m)
        setShowupData(s)
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
          {/* Date range filter */}
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
