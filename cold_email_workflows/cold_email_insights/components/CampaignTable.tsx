'use client'

import type { ComputedCampaignRow } from './types'

function pct(n: number, digits = 2) {
  return n.toFixed(digits) + '%'
}
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

const TH = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <th className={`px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap ${className}`}>
    {children}
  </th>
)

const TD = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <td className={`px-3 py-2 text-sm text-gray-700 whitespace-nowrap ${className}`}>
    {children}
  </td>
)

export default function CampaignTable({ campaigns }: { campaigns: ComputedCampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
          Campaign Breakdown
        </h2>
        <p className="text-gray-400 text-sm">No campaigns to show.</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          Campaign Breakdown
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Email / lead stats from daily snapshots · Demos attributed via interested lead emails
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse">
          <thead className="bg-gray-50">
            <tr>
              <TH className="sticky left-0 bg-gray-50 z-10">Campaign</TH>
              <TH>Status</TH>
              <TH>Emails Sent</TH>
              <TH>Leads Contacted</TH>
              <TH>Replied</TH>
              <TH>Reply Rate (lead)</TH>
              <TH>Interested</TH>
              <TH>Int. Rate (lead)</TH>
              <TH>Demos</TH>
              <TH>Demos / Interested</TH>
              <TH>Demos / Lead</TH>
              <TH>Show-ups</TH>
              <TH>Show-ups / Interested</TH>
              <TH>Pending</TH>
              <TH>No-shows</TH>
              <TH>Show Rate</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {campaigns.map(c => (
              <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                <TD className="sticky left-0 bg-white z-10 font-medium text-gray-900 max-w-[220px] truncate">
                  {c.name}
                </TD>
                <TD>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {c.status}
                  </span>
                </TD>
                <TD>{fmt(c.emails_sent)}</TD>
                <TD>{fmt(c.leads_contacted)}</TD>
                <TD>{fmt(c.replied)}</TD>
                <TD>{pct(c.reply_rate_per_contacted)}</TD>
                <TD className="font-medium">{fmt(c.interested)}</TD>
                <TD>{pct(c.int_rate_per_contacted, 4)}</TD>
                <TD className="font-medium">{c.demos_booked}</TD>
                <TD>{pct(c.demos_per_interested)}</TD>
                <TD>{pct(c.demos_per_contacted, 4)}</TD>
                <TD className={`font-medium ${c.showups > 0 ? 'text-green-700' : ''}`}>
                  {c.showups}
                </TD>
                <TD>{pct(c.showups_per_interested)}</TD>
                <TD className={c.pending_demos > 0 ? 'text-amber-600' : ''}>{c.pending_demos}</TD>
                <TD className={c.noshow > 0 ? 'text-red-500' : ''}>{c.noshow}</TD>
                <TD className="font-semibold">{pct(c.show_rate)}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
