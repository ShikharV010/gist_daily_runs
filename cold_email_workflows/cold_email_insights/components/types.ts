// ── Raw data from metrics.json ────────────────────────────────────────────────

export interface CampaignStat {
  id: number
  name: string
  industry: string
  status: string
  emails_sent: number
  total_leads: number
  total_leads_contacted: number
  replied: number
  bounced: number
  bounce_rate: number
  interested: number
  demos_booked: number
  showups: number
  pending_demos: number
  noshow: number
  closed?: number
  arr?: number
  mrr?: number
  reply_rate_per_sent: number
  reply_rate_per_contacted: number
  int_rate_per_sent: number
  int_rate_per_contacted: number
  demos_per_sent: number
  demos_per_contacted: number
  showups_per_sent: number
  showups_per_contacted: number
  show_rate: number
  demos_per_interested: number
  showups_per_interested: number
  close_per_lead?: number
  close_per_interested?: number
  close_per_demo?: number
  close_per_showup?: number
}

export interface InterestedLead {
  lead_id: number
  email: string
  campaign_id: number
  campaign_name: string
  industry: string
  date_received: string
  date_est: string | null
  booked_demo: boolean
  is_showup: boolean
  show_status: string | null
  demo_scheduled_date: string | null
  demo_created_at_date: string | null
}

export interface DemoBooking {
  company: string
  email: string
  website: string
  ae_name: string
  demo_scheduled_date: string | null
  created_at_date: string | null
  show_status: string
  show_status_adj: string
  industry: string
  campaign_id?: number | null
  closed?: boolean
  arr?: number
  monthly_amount?: number
  cs_name?: string | null
  onboarding_call_date?: string | null
}

export interface CloseRecord {
  email: string
  company: string
  website: string
  cs_name: string
  onboarding_call_date: string | null
  monthly_amount: number
  arr: number
}

export interface DailyEmailStat {
  date: string
  campaign_id: number
  industry: string
  emails_delta: number
  leads_delta: number
  bounced_delta: number
}

export interface TimeSeriesDay {
  date: string
  emails_delta: number
  leads_delta: number
  interested: number
  demos: number
  showups: number
  by_industry: Record<string, {
    emails_delta: number
    leads_delta: number
    interested: number
    demos: number
    showups: number
  }>
}

export interface MetricsData {
  generated_at: string
  campaigns: CampaignStat[]
  interested_leads: InterestedLead[]
  demo_bookings: DemoBooking[]
  closes?: CloseRecord[]
  daily_email_stats: DailyEmailStat[]
  time_series: { daily: TimeSeriesDay[] }
  totals: Record<string, number>
}

// ── Show-up analysis from showup_analysis.json ────────────────────────────────

export interface PainPoint {
  pain_point: string
  severity: string
  direct_quote: string
  addressed_in_call: boolean
  how_addressed: string
}

export interface Objection {
  objection: string
  how_handled: string
  resolved: boolean
}

export interface ShowupRecord {
  company: string
  prospect_name?: string
  prospect_designation?: string
  is_decision_maker?: boolean
  decision_maker_reasoning?: string
  company_industry?: string
  pain_points?: PainPoint[]
  key_objections?: Objection[]
  buying_signals?: string[]
  negative_signals?: string[]
  next_steps_discussed?: boolean
  next_steps_details?: string[] | string
  next_call_date?: string | null
  follow_up_materials_promised?: string[] | string
  deal_closing_intent_score?: number
  deal_closing_intent_label?: string
  intent_reasoning?: string[] | string
  call_quality_score?: number
  call_quality_notes?: string[] | string
  key_insights?: string[] | string
  recommended_next_action?: string
  pain_points_addressed_by_ae?: boolean
  pain_points_addressed_details?: string[]
  error?: string
  _meta?: {
    prospect_email: string
    prospect_company: string
    prospect_website?: string
    demo_date: string
    ae_name: string
    industry: string
    meeting_ids?: string[]
    sybill_urls?: (string | null)[]
    total_duration_min: number
    analyzed_at: string
  }
}

export type ShowupAnalysis = Record<string, ShowupRecord>

// ── Computed metric block (per industry × date range) ─────────────────────────

export interface ComputedMetrics {
  campaigns: number
  emails_sent: number
  leads_contacted: number
  replied: number
  bounced: number
  bounce_rate: number
  interested: number
  demos_booked: number
  showups: number
  pending_demos: number
  completed_demos: number
  noshow: number
  closed: number
  arr: number
  mrr: number
  reply_rate_per_sent: number
  reply_rate_per_contacted: number
  int_rate_per_sent: number
  int_rate_per_contacted: number
  demos_per_sent: number
  demos_per_contacted: number
  showups_per_sent: number
  showups_per_contacted: number
  show_rate: number
  demos_per_interested: number
  showups_per_interested: number
  close_per_lead: number
  close_per_interested: number
  close_per_demo: number
  close_per_showup: number
}

export interface ComputedCampaignRow extends Omit<ComputedMetrics, 'campaigns'> {
  id: number
  name: string
  industry: string
  status: string
  total_leads: number
}

export interface DateRange {
  from: string
  to: string
}

export type Industry = 'All' | 'Manufacturing' | 'IT & Consulting' | 'Truck Transportation' | 'BCS' | 'Commercial' | 'EWWS' | 'Advertising' | 'Medical Equipment' | 'Equipment Rental' | 'Financial Services' | 'Business Services' | 'Google Ads (Running)' | 'Google Ads (Stopped)'
export type IntentLabel = 'Hot' | 'Warm' | 'Cold' | 'Dead'
export type Tab = 'overview' | 'manufacturing' | 'it-consulting' | 'truck' | 'bcs' | 'commercial' | 'ewws' | 'advertising' | 'medical-equipment' | 'equipment-rental' | 'financial-services' | 'business-services' | 'google-ads-running' | 'google-ads-stopped' | 'compare'
