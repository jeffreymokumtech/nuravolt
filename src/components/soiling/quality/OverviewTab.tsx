'use client';

import { useMemo } from 'react';
import {
  Sun,
  Map,
  Activity,
  Calendar,
  AlertTriangle,
  Lightbulb,
  CheckCircle,
  XCircle,
  Info,
} from 'lucide-react';
import { useQualityToday } from '@/hooks/useQualityToday';
import QualitySkeleton from './QualitySkeleton';
import type {
  SpatialUniformityData,
  IrradianceComparisonData,
  DataSourceCorrelationData,
  DataHealthScore,
  QualityIssueSummary,
} from '@/types/soiling';
import QualityScoreRing from './QualityScoreRing';
import MetricTile from './MetricTile';
import PlantNotesCard from './PlantNotesCard';
import DeepSignalsCard from './DeepSignalsCard';
import { QUALITY_COLORS, getQualityClass } from './constants';

interface OverviewTabProps {
  plantId: string;
  spatialData: SpatialUniformityData | null;
  irradianceData: IrradianceComparisonData | null;
  correlationData: DataSourceCorrelationData | null;
  isLoading: boolean;
}

export default function OverviewTab({
  plantId,
  spatialData,
  irradianceData,
  correlationData,
  isLoading,
}: OverviewTabProps) {
  // Real completeness: the same month-to-date coverage SLA the Today tab and
  // command bar report (/quality/today, shared fetch) — never a hardcoded
  // constant.
  const { data: today } = useQualityToday(plantId);
  const mtdPct = typeof today?.sla?.mtd_pct === 'number' ? today.sla.mtd_pct : null;

  // Calculate health score
  const healthScore = useMemo((): DataHealthScore => {
    let irradianceScore = 0;
    let spatialScore = 0;
    const completenessScore = mtdPct; // null when no coverage data exists
    let consistencyScore = 100;

    // Irradiance score (based on correlation)
    if (irradianceData?.overallMetrics?.correlation) {
      const r = irradianceData.overallMetrics.correlation;
      const biasPct = Math.abs(irradianceData.overallMetrics.biasPct || 0);
      // Score: correlation contributes 70%, bias contributes 30%
      irradianceScore = Math.round(
        (r * 70) + (Math.max(0, 100 - biasPct * 5) * 0.3)
      );
    }

    // Spatial score
    if (spatialData?.summary?.uniformityRate) {
      spatialScore = Math.round(spatialData.summary.uniformityRate);
    }

    // Consistency score (based on CV)
    if (spatialData?.summary?.avgCV) {
      consistencyScore = Math.max(0, Math.round(100 - spatialData.summary.avgCV * 500));
    }

    // Overall weighted score. When no real completeness exists, renormalize
    // the remaining weights instead of pretending completeness is 100.
    const overall =
      completenessScore != null
        ? Math.round(
            irradianceScore * 0.40 +
            spatialScore * 0.25 +
            completenessScore * 0.20 +
            consistencyScore * 0.15
          )
        : Math.round(
            (irradianceScore * 0.40 + spatialScore * 0.25 + consistencyScore * 0.15) / 0.8
          );

    return {
      overall: Math.min(100, Math.max(0, overall)),
      breakdown: {
        irradiance: Math.min(100, irradianceScore),
        spatial: Math.min(100, spatialScore),
        completeness: completenessScore != null ? Math.round(completenessScore) : 0,
        consistency: consistencyScore,
      },
      // No period-over-period computation exists — render no trend rather
      // than a fabricated "stable 0%".
      trend: 'stable',
      trendPct: 0,
      lastChecked: new Date().toISOString(),
    };
  }, [spatialData, irradianceData, mtdPct]);

  // Aggregate issues
  const issues = useMemo((): QualityIssueSummary[] => {
    const result: QualityIssueSummary[] = [];

    // Irradiance issues
    const irradAlerts = irradianceData?.alerts || [];
    if (irradAlerts.length > 0) {
      const highCount = irradAlerts.filter(a => a.severity === 'high').length;
      result.push({
        category: 'irradiance',
        count: irradAlerts.length,
        severity: highCount > 0 ? 'high' : 'medium',
        latestIssue: irradAlerts[0]?.message,
      });
    }

    // Spatial issues
    const spatialAlerts = spatialData?.alerts || [];
    if (spatialAlerts.length > 0) {
      result.push({
        category: 'spatial',
        count: spatialAlerts.length,
        severity: 'medium',
        latestIssue: spatialAlerts[0]?.likelyCause,
      });
    }

    return result;
  }, [spatialData, irradianceData]);

  // Key metrics
  const keyMetrics = useMemo(() => ({
    irradianceCorrelation: irradianceData?.overallMetrics?.correlation || 0,
    spatialUniformityRate: spatialData?.summary?.uniformityRate || 0,
    dataCompleteness: mtdPct, // real MTD coverage SLA; null when unavailable
  }), [spatialData, irradianceData, mtdPct]);

  // Honest snapshot provenance for the "Last snapshot" tile — driven by the
  // today payload's generated_at + source, never a hardcoded "Today".
  const snapshotTile = useMemo(() => {
    const generatedAt = today?.generated_at;
    if (!generatedAt) return { value: '—', subtext: 'no snapshot available' };
    const t = Date.parse(generatedAt);
    if (Number.isNaN(t)) return { value: '—', subtext: 'no snapshot available' };
    const days = Math.floor((Date.now() - t) / 86_400_000);
    const value = days <= 0 ? 'Today' : days === 1 ? '1d ago' : `${days}d ago`;
    const subtext =
      today?._source === 'fixture'
        ? `demo fixture · ${generatedAt.slice(0, 10)}`
        : 'live compute';
    return { value, subtext };
  }, [today]);

  // Recommendations
  const recommendations = useMemo(() => {
    const recs: string[] = [];

    // Check irradiance quality
    if (keyMetrics.irradianceCorrelation < 0.9) {
      recs.push('Consider sensor calibration check - correlation below optimal threshold');
    }
    if (irradianceData?.overallMetrics?.biasPct && Math.abs(irradianceData.overallMetrics.biasPct) > 5) {
      recs.push(`Investigate ${irradianceData.overallMetrics.biasPct > 0 ? 'positive' : 'negative'} sensor bias of ${Math.abs(irradianceData.overallMetrics.biasPct).toFixed(1)}%`);
    }

    // Check spatial uniformity
    if (keyMetrics.spatialUniformityRate < 85) {
      recs.push('Review zone performance variations - uniformity below target');
    }

    // Add from correlation data
    if (correlationData?.recommendations) {
      recs.push(...correlationData.recommendations.slice(0, 2));
    }

    return recs.slice(0, 3);
  }, [keyMetrics, irradianceData, correlationData]);

  // Issue count by severity
  const issueCounts = useMemo(() => {
    const allAlerts = [
      ...(irradianceData?.alerts || []),
    ];

    return {
      high: allAlerts.filter(a => a.severity === 'high').length +
            (spatialData?.alerts?.filter(a => a.severity === 'high')?.length || 0),
      medium: allAlerts.filter(a => a.severity === 'medium').length +
              (spatialData?.alerts?.filter(a => a.severity === 'medium')?.length || 0),
      low: allAlerts.filter(a => a.severity === 'low').length +
           (spatialData?.alerts?.filter(a => a.severity === 'low')?.length || 0),
    };
  }, [irradianceData, spatialData]);


  if (isLoading) {
    return <QualitySkeleton title="Loading data health summary…" />;
  }

  return (
    <div className="space-y-6">
      {/* Health Score Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Score Ring */}
        <div
          className="bg-white rounded-xl border p-6 flex flex-col items-center justify-center"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <h3
            className="text-sm font-medium mb-4"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            Data Health Score
          </h3>
          <QualityScoreRing score={healthScore.overall} size="lg" />
        </div>

        {/* Breakdown */}
        <div
          className="bg-white rounded-xl border p-6 lg:col-span-2"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <h3
            className="text-sm font-medium mb-4"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            Score Breakdown
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Irradiance', value: healthScore.breakdown.irradiance, icon: Sun },
              { label: 'Spatial', value: healthScore.breakdown.spatial, icon: Map },
              { label: 'Completeness', value: healthScore.breakdown.completeness, icon: Activity },
              { label: 'Consistency', value: healthScore.breakdown.consistency, icon: CheckCircle },
            ].map((item) => {
              const quality = getQualityClass(item.value);
              const color = QUALITY_COLORS.status[quality];
              return (
                <div
                  key={item.label}
                  className="rounded-lg p-4"
                  style={{ backgroundColor: `${color}10` }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <item.icon className="w-4 h-4" style={{ color }} />
                    <span
                      className="text-xs font-medium"
                      style={{ color: QUALITY_COLORS.text.secondary }}
                    >
                      {item.label}
                    </span>
                  </div>
                  <p className="text-2xl font-bold" style={{ color }}>
                    {item.value}%
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Active Issues */}
      {(issueCounts.high > 0 || issueCounts.medium > 0 || issueCounts.low > 0) && (
        <div
          className="bg-white rounded-xl border p-6"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <div className="flex items-center justify-between mb-4">
            <h3
              className="text-sm font-medium flex items-center gap-2"
              style={{ color: QUALITY_COLORS.text.secondary }}
            >
              <AlertTriangle className="w-4 h-4" />
              Active Issues
            </h3>
            <div className="flex gap-2">
              {issueCounts.high > 0 && (
                <span
                  className="px-2 py-1 rounded text-xs font-medium text-white"
                  style={{ backgroundColor: QUALITY_COLORS.status.poor }}
                >
                  {issueCounts.high} High
                </span>
              )}
              {issueCounts.medium > 0 && (
                <span
                  className="px-2 py-1 rounded text-xs font-medium text-white"
                  style={{ backgroundColor: QUALITY_COLORS.status.fair }}
                >
                  {issueCounts.medium} Medium
                </span>
              )}
              {issueCounts.low > 0 && (
                <span
                  className="px-2 py-1 rounded text-xs font-medium"
                  style={{
                    backgroundColor: `${QUALITY_COLORS.primary.DEFAULT}15`,
                    color: QUALITY_COLORS.primary.DEFAULT,
                  }}
                >
                  {issueCounts.low} Low
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {issues.slice(0, 3).map((issue, idx) => (
              <div
                key={idx}
                className="flex items-start gap-3 p-3 rounded-lg"
                style={{ backgroundColor: QUALITY_COLORS.background.section }}
              >
                {issue.severity === 'high' ? (
                  <XCircle className="w-5 h-5 flex-shrink-0" style={{ color: QUALITY_COLORS.status.poor }} />
                ) : issue.severity === 'medium' ? (
                  <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: QUALITY_COLORS.status.fair }} />
                ) : (
                  <Info className="w-5 h-5 flex-shrink-0" style={{ color: QUALITY_COLORS.primary.DEFAULT }} />
                )}
                <div>
                  <p
                    className="text-sm font-medium capitalize"
                    style={{ color: QUALITY_COLORS.text.primary }}
                  >
                    {issue.category.replace('_', ' ')} Issue
                  </p>
                  {issue.latestIssue && (
                    <p
                      className="text-xs mt-1"
                      style={{ color: QUALITY_COLORS.text.secondary }}
                    >
                      {issue.latestIssue}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Metrics */}
      <div>
        <h3
          className="text-sm font-medium mb-4"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Key Metrics
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricTile
            icon={Sun}
            label="Irradiance Correlation"
            value={`r = ${keyMetrics.irradianceCorrelation.toFixed(2)}`}
            subtext="vs Open-Meteo"
            status={getQualityClass(keyMetrics.irradianceCorrelation * 100)}
          />
          <MetricTile
            icon={Map}
            label="Spatial Uniformity"
            value={`${keyMetrics.spatialUniformityRate.toFixed(1)}%`}
            subtext="uniform conditions"
            status={getQualityClass(keyMetrics.spatialUniformityRate)}
          />
          <MetricTile
            icon={Activity}
            label="Data Completeness"
            value={
              keyMetrics.dataCompleteness != null
                ? `${keyMetrics.dataCompleteness.toFixed(1)}%`
                : '—'
            }
            subtext={keyMetrics.dataCompleteness != null ? 'month-to-date coverage' : 'no coverage data'}
            status={getQualityClass(keyMetrics.dataCompleteness ?? 0)}
          />
          <MetricTile
            icon={Calendar}
            label="Last snapshot"
            value={snapshotTile.value}
            subtext={snapshotTile.subtext}
            status="neutral"
          />
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div
          className="bg-white rounded-xl border p-6"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <h3
            className="text-sm font-medium flex items-center gap-2 mb-4"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            <Lightbulb className="w-4 h-4" />
            Recommended Actions
          </h3>
          <div className="space-y-2">
            {recommendations.map((rec, idx) => (
              <div
                key={idx}
                className="flex items-start gap-3 p-3 rounded-lg"
                style={{ backgroundColor: `${QUALITY_COLORS.primary.DEFAULT}08` }}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium text-white flex-shrink-0"
                  style={{ backgroundColor: QUALITY_COLORS.primary.DEFAULT }}
                >
                  {idx + 1}
                </div>
                <p
                  className="text-sm"
                  style={{ color: QUALITY_COLORS.text.primary }}
                >
                  {rec}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deep research signals (renders nothing when no analysis exists) */}
      <DeepSignalsCard plantId={plantId} />

      {/* Plant Notes & Events */}
      <PlantNotesCard plantId={plantId} />
    </div>
  );
}
