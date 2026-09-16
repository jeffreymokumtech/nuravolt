"use client";

import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

/**
 * AOD (Aerosol Optical Depth) Variables Chart Component
 *
 * Displays historical AOD measurements which correlate with soiling:
 * - Total AOD at 550nm
 * - Dust AOD at 550nm
 * - Sea Salt AOD at 550nm
 * - Organic Matter AOD at 550nm
 * - Black Carbon AOD at 550nm
 * - Sulfate AOD at 550nm
 */

interface AODData {
  timestamp: string;
  aod_total: number;
  aod_dust: number;
  aod_sea_salt: number;
  aod_organic_matter: number;
  aod_black_carbon: number;
  aod_sulfate: number;
}

interface AODVariablesChartProps {
  data: AODData[];
  height?: number;
  showAllComponents?: boolean;
}

export function AODVariablesChart({
  data,
  height = 450,
  showAllComponents = true,
}: AODVariablesChartProps) {
  // Prepare chart data
  const chartData = data.map(d => ({
    date: new Date(d.timestamp).toLocaleDateString(),
    'Total AOD': d.aod_total,
    'Dust': d.aod_dust,
    'Sea Salt': d.aod_sea_salt,
    'Organic Matter': d.aod_organic_matter,
    'Black Carbon': d.aod_black_carbon,
    'Sulfate': d.aod_sulfate,
  }));

  // Calculate statistics
  const avgTotalAOD = data.reduce((sum, d) => sum + d.aod_total, 0) / data.length;
  const maxTotalAOD = Math.max(...data.map(d => d.aod_total));
  const avgDustAOD = data.reduce((sum, d) => sum + d.aod_dust, 0) / data.length;

  // Contribution percentages
  const dustContribution = (avgDustAOD / avgTotalAOD) * 100;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-4 md:p-6">
      <div>
        <div className="flex justify-between items-start gap-2">
          <div>
            <h3 className="text-lg md:text-xl font-bold text-gray-900 mb-2">Aerosol Optical Depth (AOD) Variables</h3>
            <p className="text-xs md:text-sm text-gray-600 mb-4">
              AOD measurements at 550nm wavelength. Higher values indicate more atmospheric particles that can cause soiling.
            </p>
          </div>
          <div className="tooltip tooltip-left" data-tip="AOD measures atmospheric aerosol concentration">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 md:h-5 md:w-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>

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
              label={{ value: 'AOD at 550nm', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              formatter={(value: number) => value.toFixed(4)}
              contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            />
            <Legend />

            {/* Total AOD */}
            <Line
              type="monotone"
              dataKey="Total AOD"
              stroke="#1E40AF"
              strokeWidth={3}
              name="Total AOD"
              dot={false}
            />

            {showAllComponents && (
              <>
                {/* Dust AOD (primary soiling cause) */}
                <Line
                  type="monotone"
                  dataKey="Dust"
                  stroke="#D97706"
                  strokeWidth={2}
                  name="Dust AOD"
                  dot={false}
                />

                {/* Sea Salt AOD */}
                <Line
                  type="monotone"
                  dataKey="Sea Salt"
                  stroke="#06B6D4"
                  strokeWidth={1.5}
                  name="Sea Salt AOD"
                  dot={false}
                />

                {/* Organic Matter AOD */}
                <Line
                  type="monotone"
                  dataKey="Organic Matter"
                  stroke="#10B981"
                  strokeWidth={1.5}
                  name="Organic Matter AOD"
                  dot={false}
                />

                {/* Black Carbon AOD */}
                <Line
                  type="monotone"
                  dataKey="Black Carbon"
                  stroke="#374151"
                  strokeWidth={1.5}
                  name="Black Carbon AOD"
                  dot={false}
                />

                {/* Sulfate AOD */}
                <Line
                  type="monotone"
                  dataKey="Sulfate"
                  stroke="#8B5CF6"
                  strokeWidth={1.5}
                  name="Sulfate AOD"
                  dot={false}
                />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>

        {/* Statistics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mt-4">
          <div className="stat bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-3">
            <div className="stat-title text-xs">Avg Total AOD</div>
            <div className="stat-value text-base md:text-lg text-blue-600">{avgTotalAOD.toFixed(4)}</div>
          </div>
          <div className="stat bg-gradient-to-br from-orange-50 to-orange-100 rounded-lg p-3">
            <div className="stat-title text-xs">Avg Dust AOD</div>
            <div className="stat-value text-base md:text-lg text-orange-600">{avgDustAOD.toFixed(4)}</div>
            <div className="stat-desc text-xs">{dustContribution.toFixed(1)}% of total</div>
          </div>
          <div className="stat bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-3">
            <div className="stat-title text-xs">Max Total AOD</div>
            <div className="stat-value text-base md:text-lg text-purple-600">{maxTotalAOD.toFixed(4)}</div>
          </div>
          <div className="stat bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-3">
            <div className="stat-title text-xs">Data Points</div>
            <div className="stat-value text-base md:text-lg text-green-600">{data.length}</div>
          </div>
        </div>

        {/* AOD Interpretation */}
        <div className="alert alert-info mt-4">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <div>
            <h4 className="font-bold text-sm">AOD & Soiling Correlation</h4>
            <p className="text-xs">
              Higher AOD values (especially dust) correlate with increased soiling rates.
              Dust AOD contributes <strong>{dustContribution.toFixed(1)}%</strong> to total AOD,
              making it the primary driver of soiling in this location.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
