'use client'

import type { ComputedMetrics } from './types'

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function pctStr(n: number, digits = 2) {
  return n.toFixed(digits) + '%'
}

interface CardProps {
  title: string
  main: string
  sub?: string
  color?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'gray'
}

function Card({ title, main, sub, color = 'blue' }: CardProps) {
  const accent =
    color === 'green'  ? 'bg-green-50 border-green-200'
    : color === 'amber' ? 'bg-amber-50 border-amber-200'
    : color === 'red'   ? 'bg-red-50 border-red-200'
    : color === 'purple' ? 'bg-purple-50 border-purple-200'
    : color === 'gray'  ? 'bg-gray-50 border-gray-200'
    : 'bg-blue-50 border-blue-200'

  const textColor =
    color === 'green'  ? 'text-green-700'
    : color === 'amber' ? 'text-amber-700'
    : color === 'red'   ? 'text-red-700'
    : color === 'purple' ? 'text-purple-700'
    : color === 'gray'  ? 'text-gray-600'
    : 'text-blue-700'

  return (
    <div className={`rounded-xl border p-4 ${accent}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{title}</p>
      <p className={`text-2xl font-bold ${textColor}`}>{main}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

const RowLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mt-4 mb-2">{children}</p>
)

export default function MetricCards({ metrics: m }: { metrics: ComputedMetrics }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3 uppercase tracking-wide">Summary</h2>

      {/* Row 1 — Email funnel counts + rates */}
      <RowLabel>Email Funnel</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card
          title="Emails Sent"
          main={fmt(m.emails_sent)}
          color="blue"
        />
        <Card
          title="Leads Contacted"
          main={fmt(m.leads_contacted)}
          sub={`from ${m.campaigns} campaigns`}
          color="blue"
        />
        <Card
          title="Replied"
          main={fmt(m.replied)}
          sub={`Reply Rate: ${pctStr(m.reply_rate_per_contacted)} / lead`}
          color="blue"
        />
        <Card
          title="Interested"
          main={fmt(m.interested)}
          sub={`Interest Rate: ${pctStr(m.int_rate_per_contacted, 4)} / lead`}
          color="blue"
        />
        <Card
          title="Bounced"
          main={fmt(m.bounced)}
          sub={`Bounce Rate: ${pctStr(m.bounce_rate)} / lead`}
          color="red"
        />
      </div>

      {/* Row 2 — Demos */}
      <RowLabel>Demos</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card
          title="Demos Booked"
          main={fmt(m.demos_booked)}
          color="purple"
        />
        <Card
          title="Pending Demos"
          main={fmt(m.pending_demos)}
          color="amber"
        />
        <Card
          title="Demos / Lead"
          main={pctStr(m.demos_per_contacted)}
          sub={`${fmt(m.demos_booked)} demos / ${fmt(m.leads_contacted)} leads`}
          color="purple"
        />
        <Card
          title="Demos / Interested"
          main={pctStr(m.demos_per_interested)}
          sub={`${fmt(m.demos_booked)} demos / ${fmt(m.interested)} interested`}
          color="purple"
        />
        <Card
          title="Interested Replies"
          main={fmt(m.interested)}
          sub={`out of ${fmt(m.leads_contacted)} contacted`}
          color="blue"
        />
      </div>

      {/* Row 3 — Show-ups */}
      <RowLabel>Show-ups</RowLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card
          title="Show-ups"
          main={fmt(m.showups)}
          color="green"
        />
        <Card
          title="No-shows"
          main={fmt(m.noshow)}
          color="gray"
        />
        <Card
          title="Show-ups / Lead"
          main={pctStr(m.showups_per_contacted)}
          sub={`${fmt(m.showups)} show-ups / ${fmt(m.leads_contacted)} leads`}
          color="green"
        />
        <Card
          title="Show-ups / Interested"
          main={pctStr(m.showups_per_interested)}
          sub={`${fmt(m.showups)} show-ups / ${fmt(m.interested)} interested`}
          color="green"
        />
        <Card
          title="Actual Show Rate"
          main={pctStr(m.show_rate)}
          sub={`${m.showups} showed / ${m.completed_demos} completed`}
          color="green"
        />
      </div>
    </div>
  )
}
