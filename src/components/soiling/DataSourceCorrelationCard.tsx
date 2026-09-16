'use client';

import React from 'react';
import { Link2, Lightbulb } from 'lucide-react';
import type {
  DataSourceCorrelationData,
  ZoneCorrelation,
  CorrelationPattern,
} from '@/types/soiling';
import QualityCard from './quality/QualityCard';
import QualityEmptyState from './quality/QualityEmptyState';
import QualitySkeleton from './quality/QualitySkeleton';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
} from './quality/constants';

interface DataSourceCorrelationCardProps {
  data: DataSourceCorrelationData | null;
  isLoading?: boolean;
}

// Correlation strength → light-system text color
function correlationColor(correlation: number): string {
  const absCorr = Math.abs(correlation);
  if (absCorr >= 0.8) return QUALITY_TONES.ok.fg;
  if (absCorr >= 0.6) return QUALITY_TONES.info.fg;
  if (absCorr >= 0.4) return QUALITY_TONES.warn.fg;
  return QUALITY_TONES.alarm.fg;
}

function betterSourceBadge(source: ZoneCorrelation['betterSource']): {
  label: string;
  fg: string;
  bg: string;
  border: string;
} {
  switch (source) {
    case 'on_site':
      return { label: 'On-site', ...QUALITY_TONES.info };
    case 'open_meteo':
      return { label: 'Open-Meteo', ...QUALITY_TONES.ok };
    case 'similar':
      return { label: 'Similar', ...QUALITY_TONES.muted };
    default:
      return { label: 'Unknown', ...QUALITY_TONES.muted };
  }
}

function ZoneTable({
  title,
  zones,
}: {
  title: string;
  zones: ZoneCorrelation[];
}) {
  if (zones.length === 0) return null;
  return (
    <div className="mb-5">
      <h4
        className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: QUALITY_COLORS.text.secondary }}
      >
        {title}
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              {['Zone', 'On-site r', 'Open-Meteo r', 'Better source'].map((h) => (
                <th
                  key={h}
                  className="border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    color: QUALITY_COLORS.text.muted,
                    borderColor: QUALITY_COLORS.border.DEFAULT,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zones.map((zone) => {
              const badge = betterSourceBadge(zone.betterSource);
              return (
                <tr key={zone.zoneId} className="hover:bg-gray-50">
                  <td
                    className="border-b px-2 py-1.5 text-xs font-medium"
                    style={{
                      borderColor: QUALITY_COLORS.border.light,
                      color: QUALITY_COLORS.text.primary,
                    }}
                  >
                    {zone.zoneId}
                  </td>
                  <td
                    className="border-b px-2 py-1.5 text-xs"
                    style={{
                      fontFamily: QUALITY_MONO,
                      borderColor: QUALITY_COLORS.border.light,
                      color: correlationColor(zone.onSiteCorrelation),
                    }}
                  >
                    {zone.onSiteCorrelation.toFixed(3)}
                  </td>
                  <td
                    className="border-b px-2 py-1.5 text-xs"
                    style={{
                      fontFamily: QUALITY_MONO,
                      borderColor: QUALITY_COLORS.border.light,
                      color: correlationColor(zone.openMeteoCorrelation),
                    }}
                  >
                    {zone.openMeteoCorrelation.toFixed(3)}
                  </td>
                  <td
                    className="border-b px-2 py-1.5"
                    style={{ borderColor: QUALITY_COLORS.border.light }}
                  >
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        color: badge.fg,
                        background: badge.bg,
                        borderColor: badge.border,
                      }}
                    >
                      {badge.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PatternCard({ pattern }: { pattern: CorrelationPattern }) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: QUALITY_COLORS.background.section,
        borderColor: QUALITY_COLORS.border.light,
      }}
    >
      <p className="text-sm" style={{ color: QUALITY_COLORS.text.primary }}>
        {pattern.pattern}
      </p>
      <div className="mt-2 flex gap-2">
        {[
          `${(pattern.frequency * 100).toFixed(0)}% frequency`,
          `${(pattern.confidence * 100).toFixed(0)}% confidence`,
        ].map((label) => (
          <span
            key={label}
            className="rounded border bg-white px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              color: QUALITY_COLORS.text.secondary,
              borderColor: QUALITY_COLORS.border.DEFAULT,
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DataSourceCorrelationCard({
  data,
  isLoading = false,
}: DataSourceCorrelationCardProps) {
  if (isLoading) {
    return <QualitySkeleton title="Analyzing data-source correlations…" />;
  }

  if (!data || !data.overallAnalysis) {
    return (
      <QualityEmptyState
        icon={Link2}
        reason="Correlation analysis not available for this plant"
        suggestion="Zone-level correlation between on-site sensors and satellite reference data is generated from zone PR history during onboarding."
      />
    );
  }

  const { uniformPeriods, nonUniformPeriods } = data.overallAnalysis;

  return (
    <QualityCard
      title="Data-source correlation · on-site vs Open-Meteo"
      icon={Link2}
      headerRight={
        <div className="flex gap-1.5">
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
            style={{
              color: QUALITY_TONES.ok.fg,
              background: QUALITY_TONES.ok.bg,
              borderColor: QUALITY_TONES.ok.border,
            }}
          >
            {uniformPeriods.count} uniform
          </span>
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
            style={{
              color: QUALITY_TONES.warn.fg,
              background: QUALITY_TONES.warn.bg,
              borderColor: QUALITY_TONES.warn.border,
            }}
          >
            {nonUniformPeriods.count} non-uniform
          </span>
        </div>
      }
      footer={
        <span>
          Correlation (r):{' '}
          <span style={{ color: QUALITY_TONES.ok.fg }}>≥0.8 strong</span> ·{' '}
          <span style={{ color: QUALITY_TONES.info.fg }}>≥0.6 moderate</span> ·{' '}
          <span style={{ color: QUALITY_TONES.warn.fg }}>≥0.4 weak</span> ·{' '}
          <span style={{ color: QUALITY_TONES.alarm.fg }}>&lt;0.4 poor</span>
        </span>
      }
    >
      <ZoneTable
        title="During uniform conditions (CV < 10%)"
        zones={uniformPeriods.zoneCorrelations}
      />
      <ZoneTable
        title="During non-uniform conditions (CV ≥ 10%)"
        zones={nonUniformPeriods.zoneCorrelations}
      />

      {data.patterns && data.patterns.length > 0 && (
        <div className="mb-5">
          <h4
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            Detected patterns
          </h4>
          <div className="space-y-2">
            {data.patterns.slice(0, 5).map((pattern, idx) => (
              <PatternCard key={idx} pattern={pattern} />
            ))}
          </div>
        </div>
      )}

      {data.recommendations && data.recommendations.length > 0 && (
        <div>
          <h4
            className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            <Lightbulb className="h-3.5 w-3.5" />
            Recommendations
          </h4>
          <div className="space-y-2">
            {data.recommendations.map((rec, idx) => (
              <div
                key={idx}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{
                  background: QUALITY_TONES.info.bg,
                  borderColor: QUALITY_TONES.info.border,
                  color: QUALITY_COLORS.text.primary,
                }}
              >
                {rec}
              </div>
            ))}
          </div>
        </div>
      )}
    </QualityCard>
  );
}
