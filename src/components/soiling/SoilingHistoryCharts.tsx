"use client";

import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

/**
 * Soiling History Charts Component
 *
 * Displays separate charts for:
 * - Soiling Ratio History (0-1 scale, higher = cleaner)
 * - Soiling Rate History (%/day, rate of accumulation)
 */

interface SoilingHistoryData {
  timestamp: string;
  soilingRatio: number;
  soilingRate: number;
  cleaningEvent?: boolean;
}

interface SoilingHistoryChartsProps {
  data: SoilingHistoryData[];
  height?: number;
  showCleaningEvents?: boolean;
}

export function SoilingRatioHistoryChart({
  data,
  height = 400,
  showCleaningEvents = true,
}: SoilingHistoryChartsProps) {
  // Prepare chart data
  const chartData = data.map(d => ({
    date: new Date(d.timestamp).toLocaleDateString(),
    soilingRatio: d.soilingRatio,
    cleaningEvent: d.cleaningEvent,
  }));

  // Find cleaning events for reference lines
  const cleaningEvents = showCleaningEvents
    ? data.filter(d => d.cleaningEvent).map((d, i) => ({ date: new Date(d.timestamp).toLocaleDateString(), index: i }))
    : [];

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-4 md:p-6">
      <div>
        <h3 className="text-lg md:text-xl font-bold text-gray-900 mb-2">Soiling Ratio History</h3>
        <p className="text-xs md:text-sm text-gray-600 mb-4">
          Historical soiling ratio (0-1 scale). Values closer to 1.0 indicate cleaner panels.
        </p>

        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              angle={-45}
              textAnchor="end"
              height={80}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0.75, 1.0]}
              label={{ value: 'Soiling Ratio', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              formatter={(value: number) => value.toFixed(4)}
              contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            />
            <Legend />

            {/* Cleaning threshold reference line */}
            <ReferenceLine y={0.97} stroke="orange" strokeDasharray="3 3" label="Cleaning Threshold" />

            {/* Soiling ratio line */}
            <Line
              type="monotone"
              dataKey="soilingRatio"
              stroke="#3B82F6"
              strokeWidth={2}
              name="Soiling Ratio"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mt-4">
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Current</div>
            <div className="stat-value text-base md:text-lg">{data[data.length - 1]?.soilingRatio.toFixed(4) || 'N/A'}</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Average</div>
            <div className="stat-value text-base md:text-lg">
              {(data.reduce((sum, d) => sum + d.soilingRatio, 0) / data.length).toFixed(4)}
            </div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Minimum</div>
            <div className="stat-value text-base md:text-lg">
              {Math.min(...data.map(d => d.soilingRatio)).toFixed(4)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SoilingRateHistoryChart({
  data,
  height = 400,
}: SoilingHistoryChartsProps) {
  // Prepare chart data
  const chartData = data.map(d => ({
    date: new Date(d.timestamp).toLocaleDateString(),
    soilingRate: d.soilingRate * 100, // Convert to percentage
  }));

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-4 md:p-6">
      <div>
        <h3 className="text-lg md:text-xl font-bold text-gray-900 mb-2">Soiling Rate History</h3>
        <p className="text-xs md:text-sm text-gray-600 mb-4">
          Historical soiling accumulation rate (%/day). Higher values indicate faster soiling.
        </p>

        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              angle={-45}
              textAnchor="end"
              height={80}
              interval="preserveStartEnd"
            />
            <YAxis
              label={{ value: 'Soiling Rate (%/day)', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              formatter={(value: number) => `${value.toFixed(3)}%/day`}
              contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            />
            <Legend />

            {/* Soiling rate line */}
            <Line
              type="monotone"
              dataKey="soilingRate"
              stroke="#EF4444"
              strokeWidth={2}
              name="Soiling Rate"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mt-4">
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Current</div>
            <div className="stat-value text-base md:text-lg">
              {(data[data.length - 1]?.soilingRate * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Average</div>
            <div className="stat-value text-base md:text-lg">
              {((data.reduce((sum, d) => sum + d.soilingRate, 0) / data.length) * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Maximum</div>
            <div className="stat-value text-base md:text-lg">
              {(Math.max(...data.map(d => d.soilingRate)) * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SoilingHistoryDualChart({
  data,
  height = 400,
}: SoilingHistoryChartsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SoilingRatioHistoryChart data={data} height={height} />
      <SoilingRateHistoryChart data={data} height={height} />
    </div>
  );
}
