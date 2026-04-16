import type {
  MetricsData, ComputedMetrics, ComputedCampaignRow,
  DateRange, Industry, InterestedLead,
} from './types'

// 'All' means active industries only — never Meta/Other or Follow-ups
const ACTIVE_INDUSTRIES = ['Manufacturing', 'IT & Consulting', 'Truck Transportation', 'BCS']

function byIndustry(industry: Industry, ind: string): boolean {
  if (industry === 'All') return ACTIVE_INDUSTRIES.includes(ind)
  return ind === industry
}

// ── computeMetrics ────────────────────────────────────────────────────────────

export function computeMetrics(
  industry: Industry,
  dateRange: DateRange,
  data: MetricsData,
): ComputedMetrics {
  const today = new Date().toISOString().split('T')[0]
  const { from, to } = dateRange

  const inDateRange = (d: string | null | undefined) => {
    if (!d) return false
    if (from && d < from) return false
    if (to   && d > to)   return false
    return true
  }

  const matchInd = (ind: string) => byIndustry(industry, ind)

  // Guard: new-format fields may be absent if metrics.json is from old ETL
  const dailyEmailStats = data.daily_email_stats || []
  const interestedLeads = data.interested_leads  || []
  const demoBookings    = data.demo_bookings      || []
  const campaigns       = (data.campaigns || []).filter(c => matchInd(c.industry))

  // Emails, leads contacted, bounced: daily_email_stats deltas; fallback to campaign totals
  const emailRows = dailyEmailStats.filter(r =>
    matchInd(r.industry) && ((!from && !to) || inDateRange(r.date)),
  )
  const emails_sent = emailRows.length > 0
    ? emailRows.reduce((s, r) => s + r.emails_delta, 0)
    : campaigns.reduce((s, c) => s + c.emails_sent, 0)
  const leads_contacted = emailRows.length > 0
    ? emailRows.reduce((s, r) => s + r.leads_delta, 0)
    : campaigns.reduce((s, c) => s + c.total_leads_contacted, 0)
  const bounced = emailRows.length > 0
    ? emailRows.reduce((s, r) => s + (r.bounced_delta ?? 0), 0)
    : campaigns.reduce((s, c) => s + (c.bounced ?? 0), 0)

  // Interested: individual leads with date; fallback to campaign totals
  const intLeads = interestedLeads.filter(l =>
    matchInd(l.industry) && ((!from && !to) || inDateRange(l.date_est)),
  )
  const interested = intLeads.length > 0
    ? intLeads.length
    : campaigns.reduce((s, c) => s + c.interested, 0)

  // Replied: campaign totals (not date-filterable)
  const replied = campaigns.reduce((s, c) => s + c.replied, 0)

  // Demos booked: demo_bookings filtered by created_at_date; fallback to campaign totals
  const demosBookedList = demoBookings.filter(b =>
    matchInd(b.industry) && ((!from && !to) || inDateRange(b.created_at_date)),
  )
  const demos_booked = demosBookedList.length > 0
    ? demosBookedList.length
    : campaigns.reduce((s, c) => s + (c.demos_booked || 0), 0)

  // Pending: current-state upcoming demos
  const pending_demos = demoBookings.length > 0
    ? demoBookings.filter(b =>
        matchInd(b.industry) &&
        b.show_status === 'P' &&
        b.demo_scheduled_date && b.demo_scheduled_date >= today,
      ).length
    : campaigns.reduce((s, c) => s + (c.pending_demos || 0), 0)

  // Show-ups: demo_bookings filtered by demo_scheduled_date; fallback to campaign totals
  const showupList = demoBookings.filter(b =>
    matchInd(b.industry) && ((!from && !to) || inDateRange(b.demo_scheduled_date)),
  )
  const showups = showupList.length > 0
    ? showupList.filter(b => b.show_status_adj === 'Y').length
    : campaigns.reduce((s, c) => s + (c.showups || 0), 0)
  const completed_demos = showupList.filter(b => b.show_status_adj !== 'P').length
  const noshow          = Math.max(0, completed_demos - showups)

  const pct = (n: number, d: number, digits = 2) =>
    d > 0 ? parseFloat((n / d * 100).toFixed(digits)) : 0

  return {
    campaigns:                campaigns.length,
    emails_sent,
    leads_contacted,
    replied,
    bounced,
    bounce_rate:              pct(bounced, Math.max(leads_contacted, 1)),
    interested,
    demos_booked,
    showups,
    pending_demos,
    completed_demos,
    noshow,
    reply_rate_per_sent:      pct(replied,      Math.max(emails_sent, 1)),
    reply_rate_per_contacted: pct(replied,      Math.max(leads_contacted, 1)),
    int_rate_per_sent:        pct(interested,   Math.max(emails_sent, 1), 4),
    int_rate_per_contacted:   pct(interested,   Math.max(leads_contacted, 1), 4),
    demos_per_sent:           pct(demos_booked, Math.max(emails_sent, 1), 4),
    demos_per_contacted:      pct(demos_booked, Math.max(leads_contacted, 1), 4),
    showups_per_sent:         pct(showups,      Math.max(emails_sent, 1), 4),
    showups_per_contacted:    pct(showups,      Math.max(leads_contacted, 1), 4),
    show_rate:                pct(showups,      Math.max(completed_demos, 1)),
    demos_per_interested:     pct(demos_booked, Math.max(interested, 1)),
    showups_per_interested:   pct(showups,      Math.max(interested, 1)),
  }
}

// ── computeCampaignStats ──────────────────────────────────────────────────────

export function computeCampaignStats(
  industry: Industry,
  dateRange: DateRange,
  data: MetricsData,
): ComputedCampaignRow[] {
  const today = new Date().toISOString().split('T')[0]
  const { from, to } = dateRange

  const inDateRange = (d: string | null | undefined) => {
    if (!d) return false
    if (from && d < from) return false
    if (to   && d > to)   return false
    return true
  }

  const campaigns = (data.campaigns || []).filter(c => byIndustry(industry, c.industry))

  // Guard: new-format fields
  const interestedLeads = data.interested_leads || []
  const demoBookings    = data.demo_bookings    || []
  const dailyEmailStats = data.daily_email_stats || []

  // Index raw data by campaign_id
  const leadsByCamp: Record<number, InterestedLead[]> = {}
  for (const l of interestedLeads) {
    if (!byIndustry(industry, l.industry)) continue
    if (!leadsByCamp[l.campaign_id]) leadsByCamp[l.campaign_id] = []
    leadsByCamp[l.campaign_id].push(l)
  }

  // Email stats by campaign
  const emailsByCamp: Record<number, { emails: number; leads: number }> = {}
  for (const r of dailyEmailStats) {
    if (!byIndustry(industry, r.industry)) continue
    if (from && r.date < from) continue
    if (to   && r.date > to)   continue
    if (!emailsByCamp[r.campaign_id]) emailsByCamp[r.campaign_id] = { emails: 0, leads: 0 }
    emailsByCamp[r.campaign_id].emails += r.emails_delta
    emailsByCamp[r.campaign_id].leads  += r.leads_delta
  }

  // email → campaign email set
  const emailSetByCamp: Record<number, Set<string>> = {}
  for (const [cid, leads] of Object.entries(leadsByCamp)) {
    emailSetByCamp[Number(cid)] = new Set(leads.map(l => l.email))
  }

  return campaigns.map(c => {
    const cid   = c.id
    const leads = (leadsByCamp[cid] || []).filter(l =>
      (!from && !to) || inDateRange(l.date_est),
    )
    const esrow      = emailsByCamp[cid] || { emails: 0, leads: 0 }
    const campEmails = emailSetByCamp[cid] || new Set<string>()

    // Demos/show-ups: from demo_bookings if available, else from campaign totals
    let demosBooked = 0, showups = 0, completed = 0, pending = 0
    if (demoBookings.length > 0) {
      const campBookings = demoBookings.filter(b => campEmails.has(b.email))
      demosBooked = campBookings.filter(b => (!from && !to) || inDateRange(b.created_at_date)).length
      const showupList = campBookings.filter(b => (!from && !to) || inDateRange(b.demo_scheduled_date))
      showups   = showupList.filter(b => b.show_status_adj === 'Y').length
      completed = showupList.filter(b => b.show_status_adj !== 'P').length
      pending   = campBookings.filter(
        b => b.show_status === 'P' && b.demo_scheduled_date && b.demo_scheduled_date >= today,
      ).length
    } else {
      demosBooked = c.demos_booked || 0
      showups     = c.showups      || 0
      pending     = c.pending_demos || 0
      completed   = Math.max(0, demosBooked - pending)
    }

    // interested: from individual leads if available, else from campaign stat
    const interested = leads.length > 0 ? leads.length : c.interested

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
      bounced:                  c.bounced ?? 0,
      bounce_rate:              pct(c.bounced ?? 0, Math.max(leads_cont, 1)),
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
