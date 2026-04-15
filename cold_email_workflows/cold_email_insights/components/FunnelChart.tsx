'use client'

import { useMemo } from 'react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'
import type { TimeSeriesDay, DateRange, Industry } from './types'

interface Props {
  timeSeries: TimeSeriesDay[]
  industry: Industry
  dateRange: DateRange
}

export default function FunnelChart({ timeSeries, industry, dateRange }: Props) {
  const chartData = useMemo(() => {
    const { from, to } = dateRange
    return (timeSeries || [])
      .filter(row => {
        if (from && row.date < from) return false
        if (to   && row.date > to)   return false
        return true
      })
      .map(row => {
        if (industry === 'All') {
          return {
            date:         row.date,
            'Emails Sent': row.emails_delta,
            Interested:   row.interested,
            Demos:        row.demos,
            'Show-ups':   row.showups,
          }
        }
        const ind = row.by_industry?.[industry] || {}
        return {
          date:         row.date,
          'Emails Sent': (ind as { emails_delta?: number }).emails_delta ?? 0,
          Interested:   (ind as { interested?: number }).interested ?? 0,
          Demos:        (ind as { demos?: number }).demos ?? 0,
          'Show-ups':   (ind as { showups?: number }).showups ?? 0,
        }
      })
      .filter(r => r['Emails Sent'] > 0 || r.Interested > 0 || r.Demos > 0 || r['Show-ups'] > 0)
  }, [timeSeries, industry, dateRange])

  if (chartData.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4 uppercase tracking-wide">
          Daily Funnel Trend
        </h2>
        <p className="text-gray-400 text-sm text-center py-8">No data for selected range.</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-4 uppercase tracking-wide">
        Daily Funnel Trend
      </h2>
      <div style={{ height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 4, right: 60, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickFormatter={d => d.slice(5)}
            />
            {/* Left axis: Interested / Demos / Show-ups */}
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
            />
            {/* Right axis: Emails Sent (much larger scale) */}
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11, fill: '#d1d5db' }}
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              labelFormatter={l => `Date: ${l}`}
              formatter={(value: number, name: string) => {
                if (name === 'Emails Sent') return [value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value, name]
                return [value, name]
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              yAxisId="right"
              dataKey="Emails Sent"
              fill="#e0e7ff"
              opacity={0.7}
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="Interested"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="Demos"
              stroke="#a78bfa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="Show-ups"
              stroke="#34d399"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
