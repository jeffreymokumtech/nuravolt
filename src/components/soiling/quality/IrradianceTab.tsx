'use client';

import { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
  Legend,
} from 'recharts';
import {
  Sun,
  Radio,
  Satellite,
  Star,
  AlertTriangle,
} from 'lucide-react';
import type {
  IrradianceComparisonData,
  SensorQualityScore,
  RadiationSensor,
} from '@/types/soiling';
import QualityScoreRing from './QualityScoreRing';
import { MetricBadge } from './MetricTile';
import QualityEmptyState from './QualityEmptyState';
import QualitySkeleton from './QualitySkeleton';
import {
  QUALITY_COLORS,
  getQualityClass,
  getRecommendationLabel,
  calculateCorrelationScore,
  calculateBiasScore,
} from './constants';

interface IrradianceTabProps {
  data: IrradianceComparisonData | null;
  isLoading: boolean;
}

export default function IrradianceTab({ data, isLoading }: IrradianceTabProps) {
  // Derive sensors from data (single sensor + Open-Meteo for now)
  const sensors = useMemo((): RadiationSensor[] => {
    if (!data) return [];
    return [
      {
        id: 'onsite_primary',
        name: data.metadata?.onSiteSensorType || 'On-site Sensor',
        type: 'pyranometer',
        isReference: false,
      },
      {
        id: 'openmeteo',
        name: 'Open-Meteo ERA5',
        type: 'satellite',
        isReference: true,
      },
    ];
  }, [data]);

  // Quality score for the on-site sensor, computed ONLY from measured
  // components (correlation 30 + bias 25 + monthly consistency 20 = 75 raw
  // points, renormalized to /100). Completeness and power-correlation used
  // to be hardcoded filler ("assume good") — a score should never contain
  // invented points, so they're out of the formula entirely. The satellite
  // reference gets no score at all: it IS the yardstick.
  const qualityScores = useMemo((): SensorQualityScore[] => {
    if (!data?.overallMetrics) return [];

    const metrics = data.overallMetrics;
    const correlationScore = calculateCorrelationScore(metrics.correlation);
    const biasScore = calculateBiasScore(metrics.biasPct);

    // Consistency from monthly correlation stability; unscored when there is
    // no monthly history (renormalized out rather than assumed).
    let consistencyScore: number | null = null;
    if (data.monthlyMetrics?.length > 0) {
      const correlations = data.monthlyMetrics.map(m => m.metrics.correlation);
      const mean = correlations.reduce((a, b) => a + b, 0) / correlations.length;
      const variance = correlations.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / correlations.length;
      const stdDev = Math.sqrt(variance);
      consistencyScore = stdDev < 0.05 ? 20 : stdDev < 0.10 ? 15 : stdDev < 0.15 ? 8 : 0;
    }

    const rawPoints = correlationScore + biasScore + (consistencyScore ?? 0);
    const rawMax = 30 + 25 + (consistencyScore != null ? 20 : 0);
    const overallScore = rawMax > 0 ? Math.round((rawPoints / rawMax) * 100) : 0;

    const onsiteSensorScore: SensorQualityScore = {
      sensorId: 'onsite_primary',
      overallScore,
      breakdown: {
        correlationScore,
        biasScore,
        consistencyScore: consistencyScore ?? 0,
        completenessScore: 0,
        powerCorrelationScore: 0,
      },
      qualityClass: getQualityClass(overallScore),
      recommendation: overallScore >= 80 ? 'primary' : overallScore >= 60 ? 'backup' : overallScore >= 40 ? 'monitor' : 'investigate',
      issues: [],
    };

    // Add issues based on scores
    if (correlationScore < 18) {
      onsiteSensorScore.issues.push('Low correlation with reference data');
    }
    if (biasScore < 12) {
      onsiteSensorScore.issues.push(`High bias: ${metrics.biasPct.toFixed(1)}%`);
    }
    if (consistencyScore != null && consistencyScore < 15) {
      onsiteSensorScore.issues.push('Inconsistent monthly performance');
    }

    return [onsiteSensorScore];
  }, [data]);

  // Recommended source: the on-site sensor when it holds up against the
  // reference; the satellite reference when the sensor is degraded.
  const recommendedSource = useMemo(() => {
    const onsite = qualityScores.find((s) => s.sensorId === 'onsite_primary');
    if (!onsite) return null;
    if (onsite.overallScore >= 60) {
      const sensor = sensors.find((s) => s.id === 'onsite_primary');
      return {
        sensorId: 'onsite_primary',
        name: sensor?.name || 'On-site sensor',
        score: onsite.overallScore,
        qualityClass: onsite.qualityClass,
        reason: 'Agrees with the satellite reference within tolerance',
      };
    }
    return {
      sensorId: 'openmeteo',
      name: 'Open-Meteo ERA5',
      score: null,
      qualityClass: 'good' as const,
      reason:
        'On-site sensor quality is degraded — use the satellite reference until sensor issues are resolved',
    };
  }, [qualityScores, sensors]);

  // Prepare scatter data
  const scatterData = useMemo(() => {
    if (!data?.scatterData) return [];
    return data.scatterData.slice(0, 500).map((d) => ({
      x: d.openMeteo_Wm2,
      y: d.onSite_Wm2,
    }));
  }, [data?.scatterData]);

  // Prepare monthly data for bar chart
  const monthlyData = useMemo(() => {
    if (!data?.monthlyMetrics) return [];
    return data.monthlyMetrics.map((m) => ({
      month: m.month.slice(5), // "2024-01" -> "01"
      correlation: m.metrics.correlation,
      bias: m.metrics.biasPct,
    }));
  }, [data?.monthlyMetrics]);

  if (isLoading) {
    return <QualitySkeleton title="Loading irradiance comparison…" />;
  }

  if (!data || !data.overallMetrics) {
    return (
      <QualityEmptyState
        icon={Sun}
        reason="Irradiance comparison not available for this plant"
        suggestion="The on-site vs satellite irradiance comparison is generated from measured GHI/POA history during onboarding."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Recommended Source */}
      {recommendedSource && (
        <div
          className="bg-white rounded-xl border p-4"
          style={{
            borderColor: QUALITY_COLORS.status[recommendedSource.qualityClass],
            borderWidth: 2,
          }}
        >
          <div className="flex items-center gap-4">
            <div
              className="p-3 rounded-lg"
              style={{ backgroundColor: `${QUALITY_COLORS.status[recommendedSource.qualityClass]}15` }}
            >
              <Star
                className="w-6 h-6"
                style={{ color: QUALITY_COLORS.status[recommendedSource.qualityClass] }}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3
                  className="font-semibold"
                  style={{ color: QUALITY_COLORS.text.primary }}
                >
                  Recommended Source: {recommendedSource.name}
                </h3>
                <span
                  className="px-2 py-0.5 rounded text-xs font-medium text-white"
                  style={{ backgroundColor: QUALITY_COLORS.status[recommendedSource.qualityClass] }}
                >
                  {recommendedSource.score != null
                    ? `Score: ${recommendedSource.score}/100`
                    : 'Reference standard'}
                </span>
              </div>
              <p
                className="text-sm mt-1"
                style={{ color: QUALITY_COLORS.text.secondary }}
              >
                {recommendedSource.reason}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Sensor Quality Cards */}
      <div>
        <h3
          className="text-sm font-medium mb-4"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Sensor Quality Scores
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sensors.map((sensor) => {
            const SensorIcon = sensor.type === 'satellite' ? Satellite : Radio;

            // The satellite reference is the yardstick, not a scored sensor —
            // it gets a plain reference card, never an invented score.
            if (sensor.isReference) {
              return (
                <div
                  key={sensor.id}
                  className="bg-white rounded-xl border p-4"
                  style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <SensorIcon
                        className="w-5 h-5"
                        style={{ color: QUALITY_COLORS.primary.DEFAULT }}
                      />
                      <div>
                        <h4
                          className="font-medium"
                          style={{ color: QUALITY_COLORS.text.primary }}
                        >
                          {sensor.name}
                        </h4>
                        <p
                          className="text-xs capitalize"
                          style={{ color: QUALITY_COLORS.text.muted }}
                        >
                          {sensor.type.replace('_', ' ')}
                        </p>
                      </div>
                    </div>
                    <span
                      className="px-2 py-1 rounded text-xs font-medium"
                      style={{
                        backgroundColor: QUALITY_COLORS.primary.light,
                        color: QUALITY_COLORS.primary.dark,
                      }}
                    >
                      Reference standard
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: QUALITY_COLORS.text.secondary }}>
                    The on-site sensor is scored against this satellite series.
                    Satellite data can miss short local cloud effects, so
                    agreement is judged on daily-scale correlation and bias.
                  </p>
                </div>
              );
            }

            const score = qualityScores.find(s => s.sensorId === sensor.id);
            if (!score) return null;
            const color = QUALITY_COLORS.status[score.qualityClass];
            const consistencyScored = data.monthlyMetrics?.length > 0;

            return (
              <div
                key={sensor.id}
                className="bg-white rounded-xl border p-4"
                style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <SensorIcon className="w-5 h-5" style={{ color }} />
                    <div>
                      <h4
                        className="font-medium"
                        style={{ color: QUALITY_COLORS.text.primary }}
                      >
                        {sensor.name}
                      </h4>
                      <p
                        className="text-xs capitalize"
                        style={{ color: QUALITY_COLORS.text.muted }}
                      >
                        {sensor.type.replace('_', ' ')}
                      </p>
                    </div>
                  </div>
                  <span
                    className="px-2 py-1 rounded text-xs font-medium text-white"
                    style={{ backgroundColor: color }}
                  >
                    {getRecommendationLabel(score.recommendation)}
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <QualityScoreRing score={score.overallScore} size="sm" showLabel={false} />
                  <div className="flex-1 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span style={{ color: QUALITY_COLORS.text.muted }}>Correlation</span>
                      <span style={{ color: QUALITY_COLORS.text.primary }}>
                        {score.breakdown.correlationScore}/30
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: QUALITY_COLORS.text.muted }}>Bias</span>
                      <span style={{ color: QUALITY_COLORS.text.primary }}>
                        {score.breakdown.biasScore}/25
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: QUALITY_COLORS.text.muted }}>Consistency</span>
                      <span style={{ color: QUALITY_COLORS.text.primary }}>
                        {consistencyScored ? `${score.breakdown.consistencyScore}/20` : 'n/a'}
                      </span>
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[10px]" style={{ color: QUALITY_COLORS.text.muted }}>
                  Scored on measured components only (renormalized to /100).
                </p>

                {/* Issues */}
                {score.issues.length > 0 && (
                  <div className="mt-4 pt-3 border-t" style={{ borderColor: QUALITY_COLORS.border.light }}>
                    {score.issues.map((issue, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-xs"
                        style={{ color: QUALITY_COLORS.status.fair }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {issue}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Overall Metrics */}
      <div
        className="bg-white rounded-xl border p-4"
        style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
      >
        <h3
          className="text-sm font-medium mb-4"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Overall Comparison Metrics
        </h3>
        <div className="flex flex-wrap gap-3">
          <MetricBadge
            label="Correlation"
            value={data.overallMetrics.correlation.toFixed(3)}
            status={getQualityClass(data.overallMetrics.correlation * 100)}
          />
          <MetricBadge
            label="R²"
            value={data.overallMetrics.r_squared.toFixed(3)}
            status={getQualityClass(data.overallMetrics.r_squared * 100)}
          />
          <MetricBadge
            label="RMSE"
            value={`${data.overallMetrics.rmse.toFixed(0)} W/m²`}
            status="neutral"
          />
          <MetricBadge
            label="MAE"
            value={`${data.overallMetrics.mae.toFixed(0)} W/m²`}
            status="neutral"
          />
          <MetricBadge
            label="Bias"
            value={`${data.overallMetrics.bias >= 0 ? '+' : ''}${data.overallMetrics.bias.toFixed(1)} W/m²`}
            status={getQualityClass(100 - Math.abs(data.overallMetrics.biasPct) * 5)}
          />
          <MetricBadge
            label="Samples"
            value={data.overallMetrics.sampleCount.toLocaleString()}
            status="neutral"
          />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Scatter Plot */}
        <div
          className="bg-white rounded-xl border p-4"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <h4
            className="text-sm font-medium mb-4"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            On-site vs Open-Meteo Irradiance
          </h4>
          <ResponsiveContainer width="100%" height={350}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 50, left: 50 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={QUALITY_COLORS.border.DEFAULT} />
              <XAxis
                type="number"
                dataKey="x"
                name="Open-Meteo"
                unit=" W/m²"
                domain={[0, 'auto']}
                tick={{ fontSize: 11, fill: QUALITY_COLORS.text.muted }}
                label={{
                  value: 'Open-Meteo (W/m²)',
                  position: 'bottom',
                  offset: 35,
                  style: { fontSize: 12, fill: QUALITY_COLORS.text.secondary },
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="On-site"
                unit=" W/m²"
                domain={[0, 'auto']}
                tick={{ fontSize: 11, fill: QUALITY_COLORS.text.muted }}
                label={{
                  value: 'On-site (W/m²)',
                  angle: -90,
                  position: 'insideLeft',
                  offset: -35,
                  style: { fontSize: 12, fill: QUALITY_COLORS.text.secondary },
                }}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{
                  backgroundColor: 'white',
                  border: `1px solid ${QUALITY_COLORS.border.DEFAULT}`,
                  borderRadius: 8,
                }}
                formatter={(value: number, name: string) => [
                  `${value.toFixed(0)} W/m²`,
                  name,
                ]}
              />
              <ReferenceLine
                segment={[{ x: 0, y: 0 }, { x: 1200, y: 1200 }]}
                stroke={QUALITY_COLORS.status.excellent}
                strokeDasharray="5 5"
                strokeWidth={2}
              />
              <Scatter
                name="Measurements"
                data={scatterData}
                fill={QUALITY_COLORS.primary.DEFAULT}
                fillOpacity={0.4}
              />
            </ScatterChart>
          </ResponsiveContainer>
          <p
            className="text-xs text-center mt-2"
            style={{ color: QUALITY_COLORS.text.muted }}
          >
            Points should align with the green 1:1 line for perfect agreement
          </p>
        </div>

        {/* Monthly Correlation */}
        {monthlyData.length > 0 && (
          <div
            className="bg-white rounded-xl border p-4"
            style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
          >
            <h4
              className="text-sm font-medium mb-4"
              style={{ color: QUALITY_COLORS.text.secondary }}
            >
              Monthly Correlation
            </h4>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={monthlyData} margin={{ top: 10, right: 20, bottom: 50, left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={QUALITY_COLORS.border.DEFAULT} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: QUALITY_COLORS.text.muted }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: QUALITY_COLORS.text.muted }}
                  label={{
                    value: 'Correlation (r)',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 12, fill: QUALITY_COLORS.text.secondary },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: `1px solid ${QUALITY_COLORS.border.DEFAULT}`,
                    borderRadius: 8,
                  }}
                  formatter={(value: number) => [value.toFixed(3), 'Correlation']}
                />
                <ReferenceLine
                  y={0.9}
                  stroke={QUALITY_COLORS.status.excellent}
                  strokeDasharray="3 3"
                />
                <Bar
                  dataKey="correlation"
                  fill={QUALITY_COLORS.primary.DEFAULT}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <p
              className="text-xs text-center mt-2"
              style={{ color: QUALITY_COLORS.text.muted }}
            >
              Green line = 0.9 threshold. Higher is better.
            </p>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div
        className="bg-white rounded-xl border p-4"
        style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
      >
        <div
          className="flex flex-wrap gap-4 text-xs"
          style={{ color: QUALITY_COLORS.text.muted }}
        >
          <span>
            <strong style={{ color: QUALITY_COLORS.text.secondary }}>Period:</strong>{' '}
            {data.metadata.period.start} to {data.metadata.period.end}
          </span>
          <span>
            <strong style={{ color: QUALITY_COLORS.text.secondary }}>On-site sensor:</strong>{' '}
            {data.metadata.onSiteSensorType}
          </span>
          <span>
            <strong style={{ color: QUALITY_COLORS.text.secondary }}>Reference:</strong>{' '}
            {data.metadata.openMeteoSource}
          </span>
          <span>
            <strong style={{ color: QUALITY_COLORS.text.secondary }}>Location:</strong>{' '}
            {data.metadata.location.latitude.toFixed(4)}°N, {data.metadata.location.longitude.toFixed(4)}°W
          </span>
        </div>
      </div>
    </div>
  );
}
