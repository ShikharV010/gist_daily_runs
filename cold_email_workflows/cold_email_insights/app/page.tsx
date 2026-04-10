'use client'

import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts'
import clsx from 'clsx'

type Metrics = {
  generated_at: string
  totals: {
    total_emails_sent: number
    total_leads_contacted: number
    total_interested: number
    total_demos: number
    total_reply_rate: number
  }
  campaigns: Campaign[]
  hooks: HookMetric[]
  industries: IndustryMetric[]
  interested_leads: InterestedLead[]
}

type Campaign = {
  id: number
  name: string
  industry: string
  status: string
  emails_sent: number
  total_leads_contacted: number
  replied: number
  interested: number
  bounced: number
  reply_rate: number
  interested_rate: number
  demos_booked: number
  demo_rate: number
  hook_a_interested: number
  hook_b_interested: number
}

type HookMetric = {
  hook: string
  label: string
  interested: number
  demos: number
  demo_rate: number
}

type IndustryMetric = {
  industry: string
  campaigns: number
  emails_sent: number
  total_leads_contacted: number
  replied: number
  interested: number
  demos_booked: number
  reply_rate: number
  interested_rate: number
  demo_rate_from_interested: number
}

type InterestedLead = {
  lead_id: number
  email: string
  campaign_name: string
  industry: string
  hook: string
  booked_demo: boolean
  demo_status: string | null
  date_received: string
}

const TABS = ['Overview', 'Hooks', 'Campaigns', 'Industries', 'Leads'] as const
type Tab = typeof TABS[number]

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <p className="text-gray-400 text-sm font-medium">{label}</p>
      <p className="text-3xl font-bold text-white mt-1">{value}</p>
      {sub && <p className="text-gray-500 text-xs mt-1">{sub}</p>}
    </div>
  )
}

function fmt(n: number | undefined | null) {
  if (n == null) return '—'
  return n.toLocaleString()
}
function pct(n: number | undefined | null) {
  if (n == null) return '—'
  return `${n.toFixed(2)}%`
}

export default function Dashboard() {
  const [data, setData] = useState<Metrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/metrics')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  if (loading) return <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center text-gray-400">Loading metrics...</div>
  if (error || !data || (data as any).error) return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-4">
      <p className="text-red-400 text-lg">{(data as any)?.error || error}</p>
      <code className="text-sm text-gray-500 bg-gray-900 px-4 py-2 rounded">python etl.py</code>
    </div>
  )

  const { totals, campaigns, hooks, industries, interested_leads } = data

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Cold Email Insights</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            Last updated: {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
                tab === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 py-6">
        {/* ── Overview ────────────────────────────────────────────────── */}
        {tab === 'Overview' && (
          <div className="space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <StatCard label="Emails Sent" value={fmt(totals.total_emails_sent)} />
              <StatCard label="Leads Contacted" value={fmt(totals.total_leads_contacted)} />
              <StatCard label="Reply Rate" value={pct(totals.total_reply_rate)} />
              <StatCard label="Interested" value={fmt(totals.total_interested)} sub={`${pct(totals.total_interested / Math.max(totals.total_leads_contacted, 1) * 100)} of contacted`} />
              <StatCard label="Demos Booked" value={fmt(totals.total_demos)} sub={`${pct(totals.total_demos / Math.max(totals.total_interested, 1) * 100)} of interested`} />
            </div>

            {/* Industry comparison */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="font-semibold mb-4">Industry Performance</h2>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={industries.filter(i => i.total_leads_contacted > 0)} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="industry" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} unit="%" />
                  <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', color: '#fff' }} />
                  <Legend />
                  <Bar dataKey="reply_rate" name="Reply %" fill="#6366f1" radius={[4,4,0,0]} />
                  <Bar dataKey="interested_rate" name="Interested %" fill="#10b981" radius={[4,4,0,0]} />
                  <Bar dataKey="demo_rate_from_interested" name="Demo/Interested %" fill="#f59e0b" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Hook A vs B summary */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="font-semibold mb-4">Hook Performance (of interested leads)</h2>
              <div className="grid grid-cols-2 gap-4">
                {hooks.map(h => (
                  <div key={h.hook} className="bg-gray-800 rounded-lg p-4">
                    <p className="text-indigo-400 font-bold text-lg">Hook {h.hook}</p>
                    <p className="text-gray-400 text-sm mb-3">{h.label}</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Interested</span>
                        <span className="text-white font-medium">{fmt(h.interested)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Demos</span>
                        <span className="text-white font-medium">{fmt(h.demos)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-400">Demo rate</span>
                        <span className="text-emerald-400 font-medium">{pct(h.demo_rate)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Hooks ───────────────────────────────────────────────────── */}
        {tab === 'Hooks' && (
          <div className="space-y-6">
            <p className="text-gray-400 text-sm">
              Hook A = &quot;one-page breakdown&quot; (Step 1 Variant A) &nbsp;·&nbsp;
              Hook B = &quot;4-5 pages build&quot; (Step 1 Variant B)
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {hooks.map(h => (
                <div key={h.hook} className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-2xl font-bold text-indigo-400">Hook {h.hook}</span>
                    <span className="text-gray-400">{h.label}</span>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between py-2 border-b border-gray-800">
                      <span className="text-gray-400">Interested leads</span>
                      <span className="font-semibold">{fmt(h.interested)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-800">
                      <span className="text-gray-400">Demos booked</span>
                      <span className="font-semibold">{fmt(h.demos)}</span>
                    </div>
                    <div className="flex justify-between py-2">
                      <span className="text-gray-400">Demo rate (demos/interested)</span>
                      <span className="font-semibold text-emerald-400">{pct(h.demo_rate)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Hook by industry */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="font-semibold mb-4">Hook Split by Industry</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800">
                    <th className="text-left py-2">Industry</th>
                    <th className="text-right py-2">Hook A</th>
                    <th className="text-right py-2">Hook B</th>
                    <th className="text-right py-2">Unknown</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from(new Set(interested_leads.map(l => l.industry))).map(ind => {
                    const leads = interested_leads.filter(l => l.industry === ind)
                    const a = leads.filter(l => l.hook === 'A').length
                    const b = leads.filter(l => l.hook === 'B').length
                    const u = leads.filter(l => l.hook === 'unknown').length
                    return (
                      <tr key={ind} className="border-b border-gray-800/50">
                        <td className="py-2 text-gray-200">{ind}</td>
                        <td className="py-2 text-right">{a}</td>
                        <td className="py-2 text-right">{b}</td>
                        <td className="py-2 text-right text-gray-500">{u}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Campaigns ───────────────────────────────────────────────── */}
        {tab === 'Campaigns' && (
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800 bg-gray-900/80">
                    <th className="text-left px-4 py-3">Campaign</th>
                    <th className="text-left px-4 py-3">Industry</th>
                    <th className="text-right px-4 py-3">Contacted</th>
                    <th className="text-right px-4 py-3">Reply %</th>
                    <th className="text-right px-4 py-3">Interested</th>
                    <th className="text-right px-4 py-3">Int. %</th>
                    <th className="text-right px-4 py-3">Demos</th>
                    <th className="text-right px-4 py-3">Demo/Int %</th>
                    <th className="text-right px-4 py-3">Hook A</th>
                    <th className="text-right px-4 py-3">Hook B</th>
                    <th className="text-right px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns
                    .filter(c => c.total_leads_contacted > 0)
                    .sort((a, b) => (b.interested || 0) - (a.interested || 0))
                    .map(c => (
                      <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 text-gray-200 max-w-xs truncate">{c.name}</td>
                        <td className="px-4 py-3 text-gray-400">{c.industry}</td>
                        <td className="px-4 py-3 text-right">{fmt(c.total_leads_contacted)}</td>
                        <td className="px-4 py-3 text-right">{pct(c.reply_rate)}</td>
                        <td className="px-4 py-3 text-right font-medium">{fmt(c.interested)}</td>
                        <td className="px-4 py-3 text-right text-indigo-400">{pct(c.interested_rate)}</td>
                        <td className="px-4 py-3 text-right font-medium text-emerald-400">{fmt(c.demos_booked)}</td>
                        <td className="px-4 py-3 text-right text-emerald-400">{pct(c.demo_rate)}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{fmt(c.hook_a_interested)}</td>
                        <td className="px-4 py-3 text-right text-gray-400">{fmt(c.hook_b_interested)}</td>
                        <td className="px-4 py-3 text-right">
                          <span className={clsx(
                            'px-2 py-0.5 rounded-full text-xs',
                            c.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-gray-800 text-gray-400'
                          )}>{c.status}</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* Campaign interested bar chart */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="font-semibold mb-4">Interested Leads by Campaign</h2>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={campaigns.filter(c => (c.interested || 0) > 0).sort((a, b) => (b.interested || 0) - (a.interested || 0))}
                  margin={{ top: 5, right: 20, left: 0, bottom: 80 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', color: '#fff' }} />
                  <Bar dataKey="interested" name="Interested" radius={[4,4,0,0]}>
                    {campaigns.filter(c => (c.interested || 0) > 0).map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── Industries ──────────────────────────────────────────────── */}
        {tab === 'Industries' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {industries
                .filter(i => i.total_leads_contacted > 0)
                .sort((a, b) => b.interested - a.interested)
                .map((ind, idx) => (
                  <div key={ind.industry} className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-3 h-3 rounded-full" style={{ background: COLORS[idx % COLORS.length] }} />
                      <h3 className="font-semibold">{ind.industry}</h3>
                      <span className="text-gray-500 text-xs ml-auto">{ind.campaigns} campaigns</span>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Leads contacted</span>
                        <span>{fmt(ind.total_leads_contacted)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Emails sent</span>
                        <span>{fmt(ind.emails_sent)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Reply rate</span>
                        <span className="text-indigo-400">{pct(ind.reply_rate)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Interested</span>
                        <span className="font-medium">{fmt(ind.interested)} <span className="text-gray-500">({pct(ind.interested_rate)})</span></span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Demos booked</span>
                        <span className="font-medium text-emerald-400">{fmt(ind.demos_booked)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Demo / Interested</span>
                        <span className="font-semibold text-emerald-400">{pct(ind.demo_rate_from_interested)}</span>
                      </div>
                    </div>
                  </div>
                ))}
            </div>

            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="font-semibold mb-4">Industry Funnel</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={industries.filter(i => i.total_leads_contacted > 0)}
                  margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="industry" tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', color: '#fff' }} />
                  <Legend />
                  <Bar dataKey="interested" name="Interested" fill="#6366f1" radius={[4,4,0,0]} />
                  <Bar dataKey="demos_booked" name="Demos Booked" fill="#10b981" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ── Leads ───────────────────────────────────────────────────── */}
        {tab === 'Leads' && (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">{fmt(interested_leads.length)} interested leads</p>
            <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800 bg-gray-900/80">
                    <th className="text-left px-4 py-3">Email</th>
                    <th className="text-left px-4 py-3">Campaign</th>
                    <th className="text-left px-4 py-3">Industry</th>
                    <th className="text-center px-4 py-3">Hook</th>
                    <th className="text-center px-4 py-3">Demo</th>
                    <th className="text-center px-4 py-3">Status</th>
                    <th className="text-right px-4 py-3">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {interested_leads
                    .sort((a, b) => new Date(b.date_received).getTime() - new Date(a.date_received).getTime())
                    .slice(0, 200)
                    .map((lead, i) => (
                      <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2 text-gray-200 max-w-xs truncate">{lead.email}</td>
                        <td className="px-4 py-2 text-gray-400 max-w-xs truncate">{lead.campaign_name}</td>
                        <td className="px-4 py-2 text-gray-400">{lead.industry}</td>
                        <td className="px-4 py-2 text-center">
                          <span className={clsx(
                            'px-2 py-0.5 rounded text-xs font-medium',
                            lead.hook === 'A' ? 'bg-indigo-900/50 text-indigo-400' :
                            lead.hook === 'B' ? 'bg-amber-900/50 text-amber-400' :
                            'bg-gray-800 text-gray-500'
                          )}>{lead.hook}</span>
                        </td>
                        <td className="px-4 py-2 text-center">
                          {lead.booked_demo
                            ? <span className="text-emerald-400">✓</span>
                            : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {lead.demo_status && (
                            <span className={clsx(
                              'px-2 py-0.5 rounded text-xs',
                              lead.demo_status === 'Y' ? 'bg-emerald-900/50 text-emerald-400' :
                              lead.demo_status === 'N' ? 'bg-red-900/50 text-red-400' :
                              'bg-gray-800 text-gray-400'
                            )}>{lead.demo_status}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-500 text-xs">
                          {new Date(lead.date_received).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {interested_leads.length > 200 && (
                <p className="text-center text-gray-500 text-xs py-3">Showing 200 of {interested_leads.length}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
