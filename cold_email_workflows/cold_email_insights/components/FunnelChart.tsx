'use client'

import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
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
            date:       row.date,
            Interested: row.interested,
            Demos:      row.demos,
            'Show-ups': row.showups,
          }
        }
        const ind = row.by_industry?.[industry] || {}
        return {
          date:       row.date,
          Interested: (ind as { interested?: number }).interested ?? 0,
          Demos:      (ind as { demos?: number }).demos ?? 0,
          'Show-ups': (ind as { showups?: number }).showups ?? 0,
        }
      })
      .filter(r => r.Interested > 0 || r.Demos > 0 || r['Show-ups'] > 0)
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
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickFormatter={d => d.slice(5)}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#9ca3af' }}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              labelFormatter={l => `Date: ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="Interested"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="Demos"
              stroke="#a78bfa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="Show-ups"
              stroke="#34d399"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
