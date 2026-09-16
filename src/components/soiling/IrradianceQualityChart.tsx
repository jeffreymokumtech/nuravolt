'use client';

import React, { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
  BarChart,
  Bar,
} from 'recharts';
import type { IrradianceComparisonData, IrradianceQualityMetrics } from '@/types/soiling';

interface IrradianceQualityChartProps {
  data: IrradianceComparisonData | null;
  isLoading?: boolean;
  height?: number;
}

// Metric card component
function MetricCard({
  label,
  value,
  unit,
  color = 'text-primary',
}: {
  label: string;
  value: number | string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="stat p-2 bg-base-200 rounded-lg">
      <div className="stat-title text-xs">{label}</div>
      <div className={`stat-value text-lg ${color}`}>
        {typeof value === 'number' ? value.toFixed(2) : value}
        {unit && <span className="text-sm font-normal ml-1">{unit}</span>}
      </div>
    </div>
  );
}

// Get color based on correlation value
function getCorrelationColor(correlation: number): string {
  if (correlation >= 0.95) return 'text-success';
  if (correlation >= 0.90) return 'text-info';
  if (correlation >= 0.80) return 'text-warning';
  return 'text-error';
}

// Get quality assessment
function getQualityAssessment(metrics: IrradianceQualityMetrics): {
  status: string;
  color: string;
  badge: string;
} {
  const { correlation, biasPct } = metrics;

  if (correlation >= 0.95 && Math.abs(biasPct) < 3) {
    return { status: 'Excellent', color: 'bg-success', badge: 'badge-success' };
  }
  if (correlation >= 0.90 && Math.abs(biasPct) < 5) {
    return { status: 'Good', color: 'bg-info', badge: 'badge-info' };
  }
  if (correlation >= 0.80 && Math.abs(biasPct) < 10) {
    return { status: 'Fair', color: 'bg-warning', badge: 'badge-warning' };
  }
  return { status: 'Poor', color: 'bg-error', badge: 'badge-error' };
}

export default function IrradianceQualityChart({
  data,
  isLoading = false,
  height = 400,
}: IrradianceQualityChartProps) {
  // Prepare scatter data
  const scatterData = useMemo(() => {
    if (!data?.scatterData) return [];
    return data.scatterData.map((d) => ({
      x: d.openmeteo,
      y: d.onsite,
    }));
  }, [data?.scatterData]);

  // Prepare monthly metrics for bar chart
  const monthlyData = useMemo(() => {
    if (!data?.monthlyMetrics) return [];
    return data.monthlyMetrics.map((m) => ({
      month: m.month,
      correlation: m.metrics.correlation,
      bias: m.metrics.bias,
    }));
  }, [data?.monthlyMetrics]);

  if (isLoading) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <h3 className="card-title">Irradiance Quality Check</h3>
          <div className="flex items-center justify-center h-48">
            <span className="loading loading-spinner loading-lg"></span>
            <span className="ml-4">Loading irradiance data...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!data || !data.overallMetrics || data.overallMetrics.sampleCount === 0) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <h3 className="card-title">Irradiance Quality Check</h3>
          <div className="alert alert-info">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              className="stroke-current shrink-0 w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>Irradiance comparison data not available.</span>
          </div>
        </div>
      </div>
    );
  }

  const metrics = data.overallMetrics;
  const assessment = getQualityAssessment(metrics);

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="card-title">Irradiance Quality Check</h3>
            <p className="text-sm text-gray-500">
              On-site sensor vs Open-Meteo (ERA5) comparison
            </p>
          </div>
          <div className={`badge ${assessment.badge} badge-lg`}>{assessment.status}</div>
        </div>

        {/* Metrics Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 mb-6">
          <MetricCard
            label="Correlation"
            value={metrics.correlation}
            color={getCorrelationColor(metrics.correlation)}
          />
          <MetricCard
            label="R²"
            value={metrics.r_squared}
            color={getCorrelationColor(metrics.r_squared)}
          />
          <MetricCard label="RMSE" value={metrics.rmse} unit="W/m²" />
          <MetricCard label="MAE" value={metrics.mae} unit="W/m²" />
          <MetricCard
            label="Bias"
            value={`${metrics.bias >= 0 ? '+' : ''}${metrics.bias.toFixed(1)}`}
            unit="W/m²"
            color={Math.abs(metrics.biasPct) > 5 ? 'text-warning' : 'text-success'}
          />
          <MetricCard label="Samples" value={metrics.sampleCount.toLocaleString()} />
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Scatter Plot */}
          <div>
            <h4 className="text-sm font-semibold mb-2 text-gray-600">
              On-site vs Open-Meteo Irradiance
            </h4>
            <ResponsiveContainer width="100%" height={height}>
              <ScatterChart margin={{ top: 10, right: 30, bottom: 60, left: 60 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Open-Meteo"
                  unit=" W/m²"
                  domain={[0, 'auto']}
                  label={{
                    value: 'Open-Meteo (W/m²)',
                    position: 'bottom',
                    offset: 40,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="On-site"
                  unit=" W/m²"
                  domain={[0, 'auto']}
                  label={{
                    value: 'On-site (W/m²)',
                    angle: -90,
                    position: 'insideLeft',
                    offset: -40,
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(value: number, name: string) => [
                    `${value.toFixed(0)} W/m²`,
                    name,
                  ]}
                />
                {/* 1:1 Reference Line */}
                <ReferenceLine
                  segment={[
                    { x: 0, y: 0 },
                    { x: 1200, y: 1200 },
                  ]}
                  stroke="#10b981"
                  strokeDasharray="5 5"
                  label="1:1"
                />
                <Scatter
                  name="Measurements"
                  data={scatterData}
                  fill="#3b82f6"
                  fillOpacity={0.5}
                />
              </ScatterChart>
            </ResponsiveContainer>
            <p className="text-xs text-gray-500 text-center mt-2">
              Points should align with the green 1:1 line for perfect agreement
            </p>
          </div>

          {/* Monthly Correlation Bar Chart */}
          {monthlyData.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2 text-gray-600">
                Monthly Correlation
              </h4>
              <ResponsiveContainer width="100%" height={height}>
                <BarChart
                  data={monthlyData}
                  margin={{ top: 10, right: 30, bottom: 60, left: 40 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="month"
                    angle={-45}
                    textAnchor="end"
                    height={60}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    domain={[0, 1]}
                    label={{
                      value: 'Correlation (r)',
                      angle: -90,
                      position: 'insideLeft',
                    }}
                  />
                  <Tooltip
                    formatter={(value: number) => [value.toFixed(3), 'Correlation']}
                  />
                  <Legend />
                  <ReferenceLine y={0.9} stroke="#10b981" strokeDasharray="3 3" />
                  <Bar
                    dataKey="correlation"
                    fill="#3b82f6"
                    name="Correlation"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-gray-500 text-center mt-2">
                Green line = 0.9 (good threshold). Higher is better.
              </p>
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="mt-4 pt-4 border-t border-base-200">
          <div className="flex flex-wrap gap-4 text-xs text-gray-500">
            <span>
              <strong>Period:</strong> {data.metadata.period.start} to{' '}
              {data.metadata.period.end}
            </span>
            <span>
              <strong>On-site sensor:</strong> {data.metadata.onSiteSensorType}
            </span>
            <span>
              <strong>Reference:</strong> {data.metadata.openMeteoSource}
            </span>
            <span>
              <strong>Location:</strong> {data.metadata.location.latitude.toFixed(4)}°N,{' '}
              {data.metadata.location.longitude.toFixed(4)}°W
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
