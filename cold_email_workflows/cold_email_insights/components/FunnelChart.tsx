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
  const today = new Date().toISOString().slice(0, 10)

  const chartData = useMemo(() => {
    const { from, to } = dateRange
    return (timeSeries || [])
      .filter(row => {
        if (row.date > today) return false          // never show future dates
        if (from && row.date < from) return false
        if (to   && row.date > to)   return false
        return true
      })
      .map(row => {
        if (industry === 'All') {
          return {
            date:          row.date,
            'Emails Sent': row.emails_delta,
            Interested:    row.interested,
            Demos:         row.demos,
          }
        }
        const ind = row.by_industry?.[industry] || {}
        return {
          date:          row.date,
          'Emails Sent': (ind as { emails_delta?: number }).emails_delta ?? 0,
          Interested:    (ind as { interested?: number }).interested ?? 0,
          Demos:         (ind as { demos?: number }).demos ?? 0,
        }
      })
      .filter(r => r['Emails Sent'] > 0 || r.Interested > 0 || r.Demos > 0)
  }, [timeSeries, industry, dateRange, today])

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
              tick={{ fontSize: 11, fill: '#374151' }}
              tickFormatter={d => d.slice(5)}
              interval={Math.max(0, Math.floor(chartData.length / 14) - 1)}
            />
            {/* Left axis: Interested / Demos */}
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: '#374151' }}
            />
            {/* Right axis: Emails Sent (much larger scale) */}
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11, fill: '#374151' }}
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              labelFormatter={l => `Date: ${l}`}
              formatter={(value, name) => {
                const v = typeof value === 'number' ? value : 0
                if (name === 'Emails Sent') return [v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v, name]
                return [v, name]
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: '#111827' }} />
            <Bar
              yAxisId="right"
              dataKey="Emails Sent"
              fill="#93c5fd"
              opacity={0.5}
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="left"
              type="linear"
              dataKey="Interested"
              stroke="#0070FF"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="left"
              type="linear"
              dataKey="Demos"
              stroke="#7c3aed"
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
