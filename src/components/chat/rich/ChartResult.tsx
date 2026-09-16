'use client';

import { useMemo } from 'react';
import OpsLineChart, { type Series } from '@/components/ops/charts/OpsLineChart';
import { RichToolCard, StatCell } from './RichToolCard';

/**
 * Inline render for `tool-getChart` outputs: any metric timeseries, twin
 * predicted (dashed) vs actual (solid) or a single measured series.
 */

interface ChartOutput {
  plant?: { slug?: string; name?: string };
  metric?: string;
  label?: string;
  unit?: string;
  device_id?: string | null;
  range?: string;
  window?: { from: string; to: string } | null;
  stats?: { mean: number | null; min: number | null; max: number | null; latest: number | null } | null;
  series?: {
    dates: string[];
    actual: Array<number | null>;
    predicted?: Array<number | null>;
  } | null;
}

export function ChartResult({ output }: { output: ChartOutput }) {
  const s = output.series;

  const { series, xLabels, xTooltipLabels } = useMemo(() => {
    if (!s || !Array.isArray(s.dates) || s.dates.length < 2) {
      return { series: [] as Series[], xLabels: [], xTooltipLabels: [] };
    }
    const out: Series[] = [];
    if (s.predicted && s.predicted.some((v) => v != null)) {
      out.push({ key: 'predicted', label: 'Predicted', values: s.predicted, tone: 'info', dashed: true });
    }
    out.push({
      key: 'actual',
      label: s.predicted ? 'Actual' : output.label ?? 'Value',
      values: s.actual,
      tone: 'ok',
    });
    const stride = Math.max(1, Math.floor(s.dates.length / 5));
    return {
      series: out,
      xLabels: s.dates.map((d, i) => (i % stride === 0 ? d.slice(5) : '')),
      xTooltipLabels: s.dates,
    };
  }, [s, output.label]);

  if (series.length === 0) return null;

  const st = output.stats;
  const fmt = (v: number | null | undefined) =>
    v == null ? 'n/a' : `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)} ${output.unit ?? ''}`.trim();

  return (
    <RichToolCard
      title={`${output.label ?? output.metric ?? 'Chart'} · ${output.device_id ?? output.plant?.name ?? output.plant?.slug ?? ''}`}
      badge={output.window ? `${output.window.from} to ${output.window.to}` : output.range}
      raw={output}
    >
      {st && (
        <div className="mb-2 grid grid-cols-3 gap-2">
          <StatCell label="Latest" value={fmt(st.latest)} />
          <StatCell label="Mean" value={fmt(st.mean)} />
          <StatCell label="Range" value={`${fmt(st.min)} to ${fmt(st.max)}`} />
        </div>
      )}
      <OpsLineChart
        series={series}
        xLabels={xLabels}
        xTooltipLabels={xTooltipLabels}
        height={160}
      />
    </RichToolCard>
  );
}
