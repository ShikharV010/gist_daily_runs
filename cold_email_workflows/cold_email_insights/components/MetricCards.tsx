'use client'

import type { ComputedMetrics } from './types'

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function pctStr(n: number, digits = 2) { return n.toFixed(digits) + '%' }
function money(n: number) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K'
  return '$' + Math.round(n).toLocaleString()
}

const ROW_STYLE = {
  1: { bg: '#dbeafe', border: '#93c5fd', text: '#1e40af' },  // blue
  2: { bg: '#ede9fe', border: '#c4b5fd', text: '#5b21b6' },  // violet
  3: { bg: '#d1fae5', border: '#6ee7b7', text: '#065f46' },  // emerald
  4: { bg: '#fef3c7', border: '#fcd34d', text: '#92400e' },  // amber (closes)
} as const

function Card({ title, main, sub, row }: {
  title: string; main: string; sub?: string; row: 1 | 2 | 3 | 4
}) {
  const s = ROW_STYLE[row]
  return (
    <div className="rounded-xl border p-4" style={{ background: s.bg, borderColor: s.border }}>
      <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: '#111827' }}>{title}</p>
      <p className="text-2xl font-bold" style={{ color: s.text }}>{main}</p>
      {sub && <p className="text-xs mt-1" style={{ color: '#6b7280' }}>{sub}</p>}
    </div>
  )
}

const RowLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-semibold text-gray-600 uppercase tracking-widest mt-4 mb-2">{children}</p>
)

export default function MetricCards({ metrics: m }: { metrics: ComputedMetrics }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3 uppercase tracking-wide">Summary</h2>

      <RowLabel>Email</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card title="Emails Sent"         main={fmt(m.emails_sent)}           sub={`from ${m.campaigns} campaigns`}                               row={1} />
        <Card title="Leads Contacted"     main={fmt(m.leads_contacted)}                                                                           row={1} />
        <Card title="Replied"             main={fmt(m.replied)}               sub={`Reply Rate: ${pctStr(m.reply_rate_per_contacted)} / lead`}    row={1} />
        <Card title="Interested Replies"  main={fmt(m.interested)}            sub={`Int. Rate: ${pctStr(m.int_rate_per_contacted, 4)} / lead`}    row={1} />
        <Card title="Bounced"             main={fmt(m.bounced)}               sub={`${fmt(m.bounced)} / ${fmt(m.leads_contacted)} contacted`}     row={1} />
        <Card title="Bounce %"            main={pctStr(m.bounce_rate)}        sub={`${fmt(m.bounced)} bounced / ${fmt(m.leads_contacted)} leads`} row={1} />
      </div>

      <RowLabel>Demos</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card title="Demos Booked"             main={fmt(m.demos_booked)}                                                                                     row={2} />
        <Card title="Pending Demos"            main={fmt(m.pending_demos)}                                                                                    row={2} />
        <Card title="Demos / Emails Sent"      main={pctStr(m.demos_per_sent, 4)}      sub={`${fmt(m.demos_booked)} / ${fmt(m.emails_sent)} sent`}           row={2} />
        <Card title="Demos / Leads Contacted"  main={pctStr(m.demos_per_contacted, 4)} sub={`${fmt(m.demos_booked)} / ${fmt(m.leads_contacted)} leads`}      row={2} />
        <Card title="Demos / Interested"       main={pctStr(m.demos_per_interested)}   sub={`${fmt(m.demos_booked)} / ${fmt(m.interested)} interested`}      row={2} />
      </div>

      <RowLabel>Show-ups</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card title="Total Show-ups"             main={fmt(m.showups)}                                                                                            row={3} />
        <Card title="No-shows"                   main={fmt(m.noshow)}                                                                                             row={3} />
        <Card title="Show-ups / Emails Sent"     main={pctStr(m.showups_per_sent, 4)}      sub={`${fmt(m.showups)} / ${fmt(m.emails_sent)} sent`}               row={3} />
        <Card title="Show-ups / Leads Contacted" main={pctStr(m.showups_per_contacted, 4)} sub={`${fmt(m.showups)} / ${fmt(m.leads_contacted)} leads`}          row={3} />
        <Card title="Show-ups / Demos"           main={pctStr(m.show_rate)}                sub={`${m.showups} showed / ${m.completed_demos} completed demos`}   row={3} />
      </div>

      <RowLabel>Closed (Onboardings)</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card title="Closed Deals"           main={fmt(m.closed)}                                                                                          row={4} />
        <Card title="ARR"                    main={money(m.arr)}              sub={`MRR ${money(m.mrr)}`}                                                  row={4} />
        <Card title="Close / Demo"           main={pctStr(m.close_per_demo)}     sub={`${m.closed} / ${fmt(m.demos_booked)} demos`}                       row={4} />
        <Card title="Close / Show-up"        main={pctStr(m.close_per_showup)}   sub={`${m.closed} / ${fmt(m.showups)} show-ups`}                         row={4} />
        <Card title="Close / Interested"     main={pctStr(m.close_per_interested)} sub={`${m.closed} / ${fmt(m.interested)} interested`}                  row={4} />
        <Card title="Close / Lead"           main={pctStr(m.close_per_lead, 4)}  sub={`${m.closed} / ${fmt(m.leads_contacted)} leads`}                    row={4} />
      </div>
    </div>
  )
}
