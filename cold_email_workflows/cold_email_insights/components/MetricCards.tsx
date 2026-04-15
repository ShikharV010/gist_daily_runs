'use client'

import type { ComputedMetrics } from './types'

function fmt(n: number, digits = 0) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function pctStr(n: number, digits = 2) {
  return n.toFixed(digits) + '%'
}

interface CardProps {
  title: string
  main: string
  sub?: string
  sub2?: string
  color?: string
}

function Card({ title, main, sub, sub2, color = 'blue' }: CardProps) {
  const accent =
    color === 'green'  ? 'bg-green-50 border-green-200'
    : color === 'amber' ? 'bg-amber-50 border-amber-200'
    : color === 'red'   ? 'bg-red-50 border-red-200'
    : color === 'purple' ? 'bg-purple-50 border-purple-200'
    : 'bg-blue-50 border-blue-200'

  const textColor =
    color === 'green'  ? 'text-green-700'
    : color === 'amber' ? 'text-amber-700'
    : color === 'red'   ? 'text-red-700'
    : color === 'purple' ? 'text-purple-700'
    : 'text-blue-700'

  return (
    <div className={`rounded-xl border p-4 ${accent}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{title}</p>
      <p className={`text-2xl font-bold ${textColor}`}>{main}</p>
      {sub  && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      {sub2 && <p className="text-xs text-gray-500">{sub2}</p>}
    </div>
  )
}

export default function MetricCards({ metrics: m }: { metrics: ComputedMetrics }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3 uppercase tracking-wide">Summary</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {/* 1 */}
        <Card
          title="Campaigns"
          main={String(m.campaigns)}
          color="blue"
        />
        {/* 2 */}
        <Card
          title="Emails Sent"
          main={fmt(m.emails_sent)}
          color="blue"
        />
        {/* 3 */}
        <Card
          title="Leads Contacted"
          main={fmt(m.leads_contacted)}
          color="blue"
        />
        {/* 4 */}
        <Card
          title="Demos Booked"
          main={fmt(m.demos_booked)}
          color="purple"
        />
        {/* 5 */}
        <Card
          title="Show-ups"
          main={fmt(m.showups)}
          color="green"
        />
        {/* 6 */}
        <Card
          title="Pending Demos"
          main={fmt(m.pending_demos)}
          color="amber"
        />
        {/* 7 — Demos Rate */}
        <Card
          title="Demos Rate"
          main={pctStr(m.demos_per_contacted)}
          sub={`per lead: ${pctStr(m.demos_per_contacted)}  per email: ${pctStr(m.demos_per_sent)}`}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3 mt-3">
        {/* 8 — Show-up Rate (per email & per lead) */}
        <Card
          title="Show-up Rate"
          main={pctStr(m.showups_per_contacted)}
          sub={`per lead: ${pctStr(m.showups_per_contacted)}  per email: ${pctStr(m.showups_per_sent)}`}
          color="green"
        />
        {/* 9 — Actual Show Rate */}
        <Card
          title="Actual Show Rate"
          main={pctStr(m.show_rate)}
          sub={`${m.showups} showed / ${m.completed_demos} completed`}
          color="green"
        />
        {/* 10 — Reply Rate */}
        <Card
          title="Reply Rate"
          main={pctStr(m.reply_rate_per_contacted)}
          sub={`per lead: ${pctStr(m.reply_rate_per_contacted)}  per email: ${pctStr(m.reply_rate_per_sent)}`}
          sub2="(total replies, not date-filtered)"
          color="blue"
        />
        {/* 11 — Interested Replies */}
        <Card
          title="Interested Replies"
          main={fmt(m.interested)}
          color="blue"
        />
        {/* 12 — Interested Rate */}
        <Card
          title="Interested Rate"
          main={pctStr(m.int_rate_per_contacted, 4)}
          sub={`per lead: ${pctStr(m.int_rate_per_contacted, 4)}  per email: ${pctStr(m.int_rate_per_sent, 4)}`}
          color="blue"
        />
        {/* 13 — Demos / Interested */}
        <Card
          title="Demos / Interested"
          main={pctStr(m.demos_per_interested)}
          sub={`${m.demos_booked} demos from ${m.interested} interested`}
          color="purple"
        />
        {/* 14 — Show-ups / Interested */}
        <Card
          title="Show-ups / Interested"
          main={pctStr(m.showups_per_interested)}
          sub={`${m.showups} show-ups from ${m.interested} interested`}
          color="green"
        />
      </div>
    </div>
  )
}
