'use client';

import { useMemo } from 'react';
import SrForecastChart, { type SrForecastPoint } from '@/components/ops/charts/SrForecastChart';
import { RichToolCard, StatCell } from './RichToolCard';

/**
 * Inline soiling-forecast chart for `tool-getSoilingForecast` outputs.
 * Prefers the compact columnar `series` (added 2026-07); falls back to the
 * legacy 7-point `preview` for conversations persisted before it existed.
 */

interface SoilingOutput {
  plant?: { slug?: string; name?: string };
  horizon_days?: number;
  avg_predicted_sr?: number | null;
  cleaning_recommended?: boolean;
  next_rain_event?: string | null;
  preview?: any[];
  series?: {
    dates: string[];
    sr: number[];
    lo: number[];
    hi: number[];
    clean_idx: number[];
  } | null;
}

function toPoints(output: SoilingOutput): { points: SrForecastPoint[]; cleanIdx: number | null } {
  const s = output.series;
  if (s && Array.isArray(s.dates) && s.dates.length > 1) {
    return {
      points: s.dates.map((date, i) => ({
        date,
        predicted: s.sr[i],
        lower: s.lo[i] ?? s.sr[i],
        upper: s.hi[i] ?? s.sr[i],
      })),
      cleanIdx: s.clean_idx?.length ? s.clean_idx[0] : null,
    };
  }
  const preview = Array.isArray(output.preview) ? output.preview : [];
  const points: SrForecastPoint[] = [];
  let cleanIdx: number | null = null;
  for (const row of preview) {
    const sr = row.soilingRatio ?? row.soiling_ratio_predicted ?? row.predicted;
    if (typeof sr !== 'number' || typeof row.date !== 'string') continue;
    if (cleanIdx == null && (row.cleaningRecommended === true || row.is_cleaning_needed === true)) {
      cleanIdx = points.length;
    }
    points.push({
      date: row.date.slice(0, 10),
      predicted: sr,
      lower: row.lowerBound ?? row.lower_bound ?? sr,
      upper: row.upperBound ?? row.upper_bound ?? sr,
    });
  }
  return { points, cleanIdx };
}

export function SoilingForecastResult({ output }: { output: SoilingOutput }) {
  const { points, cleanIdx } = useMemo(() => toPoints(output), [output]);

  const yRange = useMemo<[number, number]>(() => {
    // Compute from data — the chart default (0.90-0.99) clips clean plants.
    const lows = points.map((p) => p.lower);
    const highs = points.map((p) => p.upper);
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const pad = Math.max(0.005, (max - min) * 0.15);
    return [Math.max(0, min - pad), Math.min(1.02, max + pad)];
  }, [points]);

  if (points.length < 2) return null;

  const avg = output.avg_predicted_sr;

  return (
    <RichToolCard
      title={`Soiling forecast · ${output.plant?.name ?? output.plant?.slug ?? 'plant'}`}
      badge={output.cleaning_recommended ? 'Cleaning recommended' : 'No cleaning needed'}
      badgeTone={output.cleaning_recommended ? 'warn' : 'ok'}
      raw={output}
    >
      <div className="mb-2 grid grid-cols-3 gap-2">
        <StatCell label="Horizon" value={`${output.horizon_days ?? points.length}d`} />
        <StatCell label="Avg SR" value={avg != null ? `${(avg * 100).toFixed(1)}%` : 'n/a'} />
        <StatCell
          label="Next rain"
          value={output.next_rain_event ? output.next_rain_event.slice(5) : 'none forecast'}
        />
      </div>
      <SrForecastChart
        points={points}
        cleaningWindowIndex={cleanIdx}
        cleaningWindowLabel={cleanIdx != null ? 'clean' : undefined}
        yRange={yRange}
        height={150}
      />
    </RichToolCard>
  );
}
