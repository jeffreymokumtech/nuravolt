'use client';

import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import QualityCard from './QualityCard';
import { QUALITY_COLORS, QUALITY_MONO, getQualityClass } from './constants';

/**
 * DeepSignalsCard — long-horizon sensor-quality research signals (reference
 * coverage, outliers, gaps, seasonal coverage, cleaning statistics) from the
 * offline soiling-sensor analysis. Renders nothing when the plant has no
 * analysis — absence of research is not an error state worth a card.
 */

interface DeepSignalsPayload {
  available: boolean;
  generated_at?: string;
  method?: string;
  quality?: {
    coverage_pct: number;
    outlier_pct: number;
    max_gap_days: number;
    seasonal_coverage?: Record<string, number>;
    date_range?: [string, string];
    mean_sr?: number;
    std_sr?: number;
    sensor_agreement?: number | null;
  };
  cleaning?: {
    events_total: number;
    rate_per_year: number;
    rain_cleanings: number;
    manual_cleanings: number;
    avg_sr_recovery: number;
    avg_soiling_period_days: number;
    avg_sr_loss_per_period: number;
  } | null;
  drivers?: {
    days_since_rain_1mm_r?: number;
    precip_30d_r?: number;
    temp_mean_7d_r?: number;
  } | null;
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: QUALITY_COLORS.background.section }}
    >
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: QUALITY_COLORS.text.muted }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 text-lg font-bold leading-tight"
        style={{
          fontFamily: QUALITY_MONO,
          fontVariantNumeric: 'tabular-nums',
          color: color ?? QUALITY_COLORS.text.primary,
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[10px]" style={{ color: QUALITY_COLORS.text.muted }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default function DeepSignalsCard({ plantId }: { plantId: string }) {
  const [data, setData] = useState<DeepSignalsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/soiling/plants/${encodeURIComponent(plantId)}/quality/deep-signals`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as DeepSignalsPayload;
        if (!cancelled && json.available) setData(json);
      } catch {
        // Absence of the research analysis is not an error state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plantId]);

  if (!data?.quality) return null;

  const q = data.quality;
  const c = data.cleaning;
  const seasons = q.seasonal_coverage ?? null;

  return (
    <QualityCard
      title="Reference sensor · deep signals"
      icon={FlaskConical}
      footer={
        <span>
          {data.method ?? 'offline research analysis'}
          {q.date_range ? ` · series ${q.date_range[0]} → ${q.date_range[1]}` : ''}
          {data.generated_at ? ` · generated ${data.generated_at.slice(0, 10)}` : ''}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Coverage"
          value={`${q.coverage_pct.toFixed(1)}%`}
          sub="reference series"
          color={QUALITY_COLORS.status[getQualityClass(q.coverage_pct)]}
        />
        <Stat
          label="Outliers"
          value={`${q.outlier_pct.toFixed(1)}%`}
          sub="outside physical SR range"
          color={
            q.outlier_pct > 5
              ? QUALITY_COLORS.status.poor
              : q.outlier_pct > 1
                ? QUALITY_COLORS.status.fair
                : QUALITY_COLORS.status.excellent
          }
        />
        <Stat
          label="Max gap"
          value={`${q.max_gap_days}d`}
          sub="longest missing stretch"
        />
        {c && (
          <>
            <Stat
              label="Cleanings"
              value={`${c.rate_per_year.toFixed(1)}/yr`}
              sub={`${c.rain_cleanings} rain · ${c.manual_cleanings} manual`}
            />
            <Stat
              label="SR recovery"
              value={`+${(c.avg_sr_recovery * 100).toFixed(1)}%`}
              sub="avg per cleaning"
            />
            <Stat
              label="Soiling period"
              value={`${Math.round(c.avg_soiling_period_days)}d`}
              sub={`≈${(c.avg_sr_loss_per_period * 100).toFixed(1)}% SR loss each`}
            />
          </>
        )}
      </div>

      {seasons && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.muted }}
          >
            Seasonal coverage
          </span>
          {Object.entries(seasons).map(([season, pct]) => (
            <span
              key={season}
              className="rounded border bg-white px-1.5 py-0.5 text-[10px]"
              style={{
                fontFamily: QUALITY_MONO,
                borderColor: QUALITY_COLORS.border.DEFAULT,
                color: QUALITY_COLORS.status[getQualityClass(pct)],
              }}
              title={`${season} coverage of the reference series`}
            >
              {season} {pct.toFixed(0)}%
            </span>
          ))}
        </div>
      )}
    </QualityCard>
  );
}
