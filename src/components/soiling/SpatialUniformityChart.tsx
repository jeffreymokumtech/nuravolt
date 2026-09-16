'use client';

import React, { useMemo, useState } from 'react';
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  ComposedChart,
  Legend,
  Brush,
} from 'recharts';
import { Map } from 'lucide-react';
import type {
  SpatialUniformityData,
  ZoneStatistics,
} from '@/types/soiling';
import QualityCard from './quality/QualityCard';
import QualityEmptyState from './quality/QualityEmptyState';
import QualitySkeleton from './quality/QualitySkeleton';
import {
  QUALITY_CHART,
  QUALITY_COLORS,
  QUALITY_MONO,
} from './quality/constants';

interface SpatialUniformityChartProps {
  data: SpatialUniformityData | null;
  isLoading?: boolean;
  height?: number;
}

// CV → category (color from the shared chart palette)
function getCVCategoryLocal(cv: number): {
  category: string;
  color: string;
  label: string;
} {
  if (cv < 0.05) return { category: 'uniform', color: QUALITY_CHART.reference, label: 'Highly Uniform' };
  if (cv < 0.1) return { category: 'normal', color: QUALITY_CHART.primary, label: 'Normal' };
  if (cv < 0.2) return { category: 'moderate', color: QUALITY_CHART.threshold, label: 'Non-Uniform' };
  return { category: 'high', color: '#EF4444', label: 'High Non-Uniformity' };
}

// Zone statistics card. The per-zone badge derives from the zone's own PR
// coefficient of variation (stdPR/avgPR) — the payload carries no per-zone
// avgCV field, and the previous `stats.avgCV || 0` silently branded every
// zone "Highly Uniform".
function ZoneStatCard({ zone, stats }: { zone: string; stats: ZoneStatistics }) {
  const zoneCv = stats.avgPR > 0 ? stats.stdPR / stats.avgPR : 0;
  const category = getCVCategoryLocal(zoneCv);

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: QUALITY_COLORS.background.section,
        borderColor: QUALITY_COLORS.border.light,
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: QUALITY_COLORS.text.primary }}>
          {zone}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
          style={{ backgroundColor: category.color }}
        >
          {category.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        {[
          { label: 'Avg PR', value: stats.avgPR },
          { label: 'Min PR', value: stats.minPR },
          { label: 'Max PR', value: stats.maxPR },
        ].map((m) => (
          <div key={m.label}>
            <div style={{ color: QUALITY_COLORS.text.muted }}>{m.label}</div>
            <div
              className="font-medium"
              style={{ fontFamily: QUALITY_MONO, color: QUALITY_COLORS.text.primary }}
            >
              {(m.value * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Summary stat strip
function SummaryStats({ summary }: { summary: SpatialUniformityData['summary'] }) {
  const uniformityColor =
    summary.uniformityRate >= 90
      ? QUALITY_COLORS.status.excellent
      : summary.uniformityRate >= 80
        ? QUALITY_COLORS.status.good
        : summary.uniformityRate >= 70
          ? QUALITY_COLORS.status.fair
          : QUALITY_COLORS.status.poor;

  const stats: Array<{ label: string; value: string; color?: string }> = [
    {
      label: 'Uniformity rate',
      value: `${summary.uniformityRate.toFixed(1)}%`,
      color: uniformityColor,
    },
    { label: 'Avg CV', value: `${(summary.avgCV * 100).toFixed(2)}%` },
    { label: 'Max CV', value: `${(summary.maxCV * 100).toFixed(2)}%` },
    { label: 'Total days', value: String(summary.totalMeasurements) },
    {
      label: 'Alerts',
      value: String(summary.alertCount),
      color:
        summary.alertCount > 0
          ? QUALITY_COLORS.status.fair
          : QUALITY_COLORS.status.excellent,
    },
  ];

  return (
    <div
      className="mb-4 flex flex-wrap items-stretch gap-px overflow-hidden rounded-lg border"
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      {stats.map((s, i) => (
        <div
          key={s.label}
          className="min-w-[110px] flex-1 px-3 py-2.5"
          style={{
            background: QUALITY_COLORS.background.section,
            borderLeft: i > 0 ? `1px solid ${QUALITY_COLORS.border.light}` : undefined,
          }}
        >
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.muted }}
          >
            {s.label}
          </div>
          <div
            className="text-lg font-bold leading-tight"
            style={{
              fontFamily: QUALITY_MONO,
              fontVariantNumeric: 'tabular-nums',
              color: s.color ?? QUALITY_COLORS.text.primary,
            }}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SpatialUniformityChart({
  data,
  isLoading = false,
  height = 400,
}: SpatialUniformityChartProps) {
  const [showZonePRs, setShowZonePRs] = useState(false);

  // Prepare time series data for chart
  const chartData = useMemo(() => {
    if (!data?.timeSeries) return [];

    return data.timeSeries.map((entry) => {
      const cvPct = entry.coefficientOfVariation * 100;
      const category = getCVCategoryLocal(entry.coefficientOfVariation);

      // Base data
      const dataPoint: Record<string, unknown> = {
        date: new Date(entry.timestamp).toLocaleDateString(),
        timestamp: entry.timestamp,
        cv: cvPct,
        cvColor: category.color,
        isUniform: entry.isUniform,
        // Zone PRs (convert to percentage)
      };

      // Add zone PRs if available
      if (entry.zonePRs) {
        Object.entries(entry.zonePRs).forEach(([zone, pr]) => {
          dataPoint[zone] = pr * 100;
        });
      }

      return dataPoint;
    });
  }, [data?.timeSeries]);

  // Get zone names
  const zones = useMemo(() => {
    return data?.metadata?.zones || [];
  }, [data?.metadata?.zones]);

  if (isLoading) {
    return <QualitySkeleton title="Loading spatial uniformity…" />;
  }

  if (!data || !data.summary || data.summary.totalMeasurements === 0) {
    return (
      <QualityEmptyState
        icon={Map}
        reason="Spatial uniformity data not available for this plant"
        suggestion="Zone-level coefficient-of-variation analysis is generated from per-zone PR history during onboarding."
      />
    );
  }

  return (
    <QualityCard
      title={`Spatial uniformity · ${zones.length} inverter zones`}
      icon={Map}
      headerRight={
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-blue-500"
            checked={showZonePRs}
            onChange={(e) => setShowZonePRs(e.target.checked)}
          />
          Show zone PRs
        </label>
      }
      footer={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Period: {data.metadata.period.start} to {data.metadata.period.end}
          </span>
          <span>Zones: {zones.join(', ')}</span>
          <span>CV threshold: {(data.metadata.cvThreshold * 100).toFixed(0)}%</span>
        </div>
      }
    >
      {/* Summary Stats */}
      <SummaryStats summary={data.summary} />

      {/* CV Time Series Chart */}
      <div className="mb-6">
        <h4
          className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Daily coefficient of variation
        </h4>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 30, bottom: 60, left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={QUALITY_CHART.grid} />
            <XAxis
              dataKey="date"
              angle={-45}
              textAnchor="end"
              height={60}
              tick={{ fontSize: 10, fill: QUALITY_CHART.axisTick }}
            />
            <YAxis
              yAxisId="cv"
              domain={[0, 'auto']}
              tick={{ fontSize: 11, fill: QUALITY_CHART.axisTick }}
              label={{
                value: 'CV (%)',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 12, fill: QUALITY_CHART.axisLabel },
              }}
            />
            {showZonePRs && (
              <YAxis
                yAxisId="pr"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: QUALITY_CHART.axisTick }}
                label={{
                  value: 'PR (%)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12, fill: QUALITY_CHART.axisLabel },
                }}
              />
            )}
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: `1px solid ${QUALITY_COLORS.border.DEFAULT}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => {
                if (name === 'CV') return [`${value.toFixed(2)}%`, name];
                return [`${value.toFixed(1)}%`, name];
              }}
            />
            <Legend />

            {/* Non-uniform threshold area */}
            <ReferenceLine
              yAxisId="cv"
              y={10}
              stroke={QUALITY_CHART.threshold}
              strokeDasharray="5 5"
              label={{ value: '10% threshold', position: 'right', fontSize: 10 }}
            />

            {/* CV Line */}
            <Area
              yAxisId="cv"
              type="monotone"
              dataKey="cv"
              name="CV"
              stroke={QUALITY_CHART.primary}
              fill={QUALITY_CHART.primarySoft}
              strokeWidth={2}
            />

            {/* Zone PR Lines (optional) */}
            {showZonePRs &&
              zones.map((zone, idx) => (
                <Line
                  key={zone}
                  yAxisId="pr"
                  type="monotone"
                  dataKey={zone}
                  name={zone}
                  stroke={QUALITY_CHART.series[idx % QUALITY_CHART.series.length]}
                  strokeWidth={1}
                  dot={false}
                  opacity={0.7}
                />
              ))}

            {chartData.length > 100 && (
              <Brush dataKey="date" height={30} stroke={QUALITY_CHART.primary} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        <p
          className="mt-2 text-center text-xs"
          style={{ color: QUALITY_COLORS.text.muted }}
        >
          CV &lt; 10% indicates spatially uniform conditions. Higher values suggest partial
          clouds or localized effects.
        </p>
      </div>

      {/* Zone Statistics Grid */}
      {data.zoneStatistics && Object.keys(data.zoneStatistics).length > 0 && (
        <div className="mb-5">
          <h4
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            Zone statistics
          </h4>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {Object.entries(data.zoneStatistics).map(([zone, stats]) => (
              <ZoneStatCard key={zone} zone={zone} stats={stats} />
            ))}
          </div>
        </div>
      )}

      {/* CV Interpretation Guide */}
      <div>
        <h4
          className="mb-2 text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: QUALITY_COLORS.text.muted }}
        >
          CV interpretation guide
        </h4>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            { label: '<5% Highly Uniform', color: QUALITY_CHART.reference },
            { label: '5-10% Normal', color: QUALITY_CHART.primary },
            { label: '10-20% Non-Uniform', color: QUALITY_CHART.threshold },
            { label: '>20% High Non-Uniformity', color: '#EF4444' },
          ].map((b) => (
            <span
              key={b.label}
              className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: b.color }}
            >
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </QualityCard>
  );
}
