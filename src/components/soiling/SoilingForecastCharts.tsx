"use client";

import React from 'react';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

/**
 * Soiling Forecast Charts Component
 *
 * Displays separate forecast charts for:
 * - Soiling Ratio Forecast (0-1 scale, with confidence bands)
 * - Soiling Rate Forecast (%/day accumulation rate, with confidence bands)
 */

interface ForecastPoint {
  timestamp: string;
  predicted: number;
  lower_bound?: number;
  upper_bound?: number;
  actual?: number; // For validation
}

interface SoilingForecastChartsProps {
  ratioForecast: ForecastPoint[];
  rateForecast: ForecastPoint[];
  height?: number;
  showConfidenceBands?: boolean;
  showActual?: boolean;
  cleaningDates?: string[];
}

export function SoilingRatioForecastChart({
  ratioForecast,
  height = 400,
  showConfidenceBands = true,
  showActual = false,
  cleaningDates = [],
}: Omit<SoilingForecastChartsProps, 'rateForecast'>) {
  // Prepare chart data
  const chartData = ratioForecast.map(d => ({
    date: new Date(d.timestamp).toLocaleDateString(),
    predicted: d.predicted,
    lower: d.lower_bound,
    upper: d.upper_bound,
    actual: d.actual,
    isCleaning: cleaningDates.includes(d.timestamp),
  }));

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-6">
      <div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Soiling Ratio Forecast</h3>
        <p className="text-sm text-gray-600 mb-4">
          Predicted soiling ratio (0-1 scale) with {showConfidenceBands ? '95% confidence intervals' : 'predictions'}.
          Values below 0.97 trigger cleaning recommendations.
        </p>

        <ResponsiveContainer width="100%" height={height}>
          {showConfidenceBands ? (
            <AreaChart data={chartData}>
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
                formatter={(value: number) => value?.toFixed(4) || 'N/A'}
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
              />
              <Legend />

              {/* Cleaning threshold */}
              <ReferenceLine y={0.97} stroke="orange" strokeDasharray="3 3" label="Cleaning Threshold" />

              {/* Confidence band */}
              <Area
                type="monotone"
                dataKey="lower"
                stroke="none"
                fill="#3B82F6"
                fillOpacity={0.2}
                name="Confidence Band"
              />
              <Area
                type="monotone"
                dataKey="upper"
                stroke="none"
                fill="#3B82F6"
                fillOpacity={0.2}
                name=""
              />

              {/* Predicted line */}
              <Line
                type="monotone"
                dataKey="predicted"
                stroke="#3B82F6"
                strokeWidth={2}
                name="Predicted SR"
                dot={(props: any) => {
                  if (props.payload.isCleaning) {
                    return (
                      <circle
                        cx={props.cx}
                        cy={props.cy}
                        r={6}
                        fill="orange"
                        stroke="white"
                        strokeWidth={2}
                      />
                    );
                  }
                  return null;
                }}
              />

              {/* Actual line (if available) */}
              {showActual && (
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="black"
                  strokeWidth={2}
                  name="Actual SR"
                  dot={false}
                />
              )}
            </AreaChart>
          ) : (
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
                formatter={(value: number) => value?.toFixed(4) || 'N/A'}
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
              />
              <Legend />

              <ReferenceLine y={0.97} stroke="orange" strokeDasharray="3 3" label="Cleaning Threshold" />

              <Line
                type="monotone"
                dataKey="predicted"
                stroke="#3B82F6"
                strokeWidth={2}
                name="Predicted SR"
                dot={false}
              />

              {showActual && (
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="black"
                  strokeWidth={2}
                  name="Actual SR"
                  dot={false}
                />
              )}
            </LineChart>
          )}
        </ResponsiveContainer>

        {/* Forecast Statistics */}
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Forecast Start</div>
            <div className="stat-value text-sm">{ratioForecast[0]?.predicted.toFixed(4) || 'N/A'}</div>
            <div className="stat-desc text-xs">{new Date(ratioForecast[0]?.timestamp).toLocaleDateString()}</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Forecast End</div>
            <div className="stat-value text-sm">
              {ratioForecast[ratioForecast.length - 1]?.predicted.toFixed(4) || 'N/A'}
            </div>
            <div className="stat-desc text-xs">
              {new Date(ratioForecast[ratioForecast.length - 1]?.timestamp).toLocaleDateString()}
            </div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Avg Predicted SR</div>
            <div className="stat-value text-sm">
              {(ratioForecast.reduce((sum, d) => sum + d.predicted, 0) / ratioForecast.length).toFixed(4)}
            </div>
          </div>
        </div>

        {/* Cleaning Recommendations */}
        {cleaningDates.length > 0 && (
          <div className="alert alert-warning mt-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h4 className="font-bold text-sm">Cleaning Recommended</h4>
              <p className="text-xs">
                {cleaningDates.length} cleaning event(s) recommended (marked with orange dots)
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SoilingRateForecastChart({
  rateForecast,
  height = 400,
  showConfidenceBands = true,
}: Omit<SoilingForecastChartsProps, 'ratioForecast' | 'showActual' | 'cleaningDates'>) {
  // Prepare chart data (convert to percentage)
  const chartData = rateForecast.map(d => ({
    date: new Date(d.timestamp).toLocaleDateString(),
    predicted: d.predicted * 100, // Convert to %
    lower: d.lower_bound ? d.lower_bound * 100 : undefined,
    upper: d.upper_bound ? d.upper_bound * 100 : undefined,
  }));

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-6">
      <div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Soiling Rate Forecast</h3>
        <p className="text-sm text-gray-600 mb-4">
          Predicted soiling accumulation rate (%/day) with {showConfidenceBands ? '95% confidence intervals' : 'predictions'}.
          Higher rates indicate faster soiling.
        </p>

        <ResponsiveContainer width="100%" height={height}>
          {showConfidenceBands ? (
            <AreaChart data={chartData}>
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
                formatter={(value: number) => value ? `${value.toFixed(3)}%/day` : 'N/A'}
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
              />
              <Legend />

              {/* Confidence band */}
              <Area
                type="monotone"
                dataKey="lower"
                stroke="none"
                fill="#EF4444"
                fillOpacity={0.2}
                name="Confidence Band"
              />
              <Area
                type="monotone"
                dataKey="upper"
                stroke="none"
                fill="#EF4444"
                fillOpacity={0.2}
                name=""
              />

              {/* Predicted line */}
              <Line
                type="monotone"
                dataKey="predicted"
                stroke="#EF4444"
                strokeWidth={2}
                name="Predicted Rate"
                dot={false}
              />
            </AreaChart>
          ) : (
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
                formatter={(value: number) => value ? `${value.toFixed(3)}%/day` : 'N/A'}
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
              />
              <Legend />

              <Line
                type="monotone"
                dataKey="predicted"
                stroke="#EF4444"
                strokeWidth={2}
                name="Predicted Rate"
                dot={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>

        {/* Forecast Statistics */}
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Current Rate</div>
            <div className="stat-value text-sm">
              {(rateForecast[0]?.predicted * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Avg Rate</div>
            <div className="stat-value text-sm">
              {((rateForecast.reduce((sum, d) => sum + d.predicted, 0) / rateForecast.length) * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
          <div className="stat bg-gray-50 rounded-lg p-3">
            <div className="stat-title text-xs">Max Rate</div>
            <div className="stat-value text-sm">
              {(Math.max(...rateForecast.map(d => d.predicted)) * 100).toFixed(3)}%
            </div>
            <div className="stat-desc text-xs">per day</div>
          </div>
        </div>

        {/* Rate Interpretation */}
        <div className="alert alert-info mt-4">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <div>
            <h4 className="font-bold text-sm">Rate Forecast Interpretation</h4>
            <p className="text-xs">
              Average predicted soiling rate: {((rateForecast.reduce((sum, d) => sum + d.predicted, 0) / rateForecast.length) * 100).toFixed(3)}%/day.
              At this rate, panels would accumulate ~{(((rateForecast.reduce((sum, d) => sum + d.predicted, 0) / rateForecast.length) * 30) * 100).toFixed(1)}% soiling loss per month without cleaning.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SoilingForecastDualChart({
  ratioForecast,
  rateForecast,
  height = 400,
  showConfidenceBands = true,
  showActual = false,
  cleaningDates = [],
}: SoilingForecastChartsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SoilingRatioForecastChart
        ratioForecast={ratioForecast}
        height={height}
        showConfidenceBands={showConfidenceBands}
        showActual={showActual}
        cleaningDates={cleaningDates}
      />
      <SoilingRateForecastChart
        rateForecast={rateForecast}
        height={height}
        showConfidenceBands={showConfidenceBands}
      />
    </div>
  );
}
