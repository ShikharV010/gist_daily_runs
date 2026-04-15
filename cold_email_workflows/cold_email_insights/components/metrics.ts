import type {
  MetricsData, ComputedMetrics, ComputedCampaignRow,
  DateRange, Industry, InterestedLead,
} from './types'

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

  const byIndustry = (ind: string) =>
    industry === 'All' || ind === industry

  // Emails & leads contacted: sum daily_email_stats deltas in date range
  const emailRows = data.daily_email_stats.filter(r =>
    byIndustry(r.industry) && ((!from && !to) || inDateRange(r.date)),
  )
  const emails_sent     = emailRows.reduce((s, r) => s + r.emails_delta, 0)
  const leads_contacted = emailRows.reduce((s, r) => s + r.leads_delta, 0)

  // Interested: filter by date_est
  const intLeads = data.interested_leads.filter(l =>
    byIndustry(l.industry) && ((!from && !to) || inDateRange(l.date_est)),
  )
  const interested = intLeads.length

  // Replied: campaign totals only (not date-filterable)
  const replied = data.campaigns
    .filter(c => byIndustry(c.industry))
    .reduce((s, c) => s + c.replied, 0)

  // Demos booked: filter by created_at_date
  const demosBookedList = data.demo_bookings.filter(b =>
    byIndustry(b.industry) && ((!from && !to) || inDateRange(b.created_at_date)),
  )
  const demos_booked = demosBookedList.length

  // Pending: current-state upcoming demos (no date filter)
  const pending_demos = data.demo_bookings.filter(b =>
    byIndustry(b.industry) &&
    b.show_status === 'P' &&
    b.demo_scheduled_date && b.demo_scheduled_date >= today,
  ).length

  // Show-ups: filter by demo_scheduled_date
  const showupList = data.demo_bookings.filter(b =>
    byIndustry(b.industry) && ((!from && !to) || inDateRange(b.demo_scheduled_date)),
  )
  const showups         = showupList.filter(b => b.show_status_adj === 'Y').length
  const completed_demos = showupList.filter(b => b.show_status_adj !== 'P').length
  const noshow          = Math.max(0, completed_demos - showups)

  const pct = (n: number, d: number, digits = 2) =>
    d > 0 ? parseFloat((n / d * 100).toFixed(digits)) : 0

  return {
    campaigns:                data.campaigns.filter(c => byIndustry(c.industry)).length,
    emails_sent,
    leads_contacted,
    replied,
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

  // email → campaign_id map (from all interested leads)
  const emailSetByCamp: Record<number, Set<string>> = {}
  for (const [cid, leads] of Object.entries(leadsByCamp)) {
    emailSetByCamp[Number(cid)] = new Set(leads.map(l => l.email))
  }

  return campaigns.map(c => {
    const cid   = c.id
    const leads = (leadsByCamp[cid] || []).filter(l =>
      (!from && !to) || inDateRange(l.date_est),
    )
    const esrow = emailsByCamp[cid] || { emails: 0, leads: 0 }

    const campEmails   = emailSetByCamp[cid] || new Set<string>()
    const campBookings = data.demo_bookings.filter(b => campEmails.has(b.email))

    const demosBooked = campBookings.filter(b =>
      (!from && !to) || inDateRange(b.created_at_date),
    ).length
    const showupList  = campBookings.filter(b =>
      (!from && !to) || inDateRange(b.demo_scheduled_date),
    )
    const showups     = showupList.filter(b => b.show_status_adj === 'Y').length
    const completed   = showupList.filter(b => b.show_status_adj !== 'P').length
    const pending     = campBookings.filter(
      b => b.show_status === 'P' && b.demo_scheduled_date && b.demo_scheduled_date >= today,
    ).length

    const interested = leads.length
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
