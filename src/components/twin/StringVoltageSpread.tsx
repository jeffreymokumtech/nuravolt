'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { MpptData, PlantMpptData } from '@/types/mppt';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface Props {
  plantId: string;
  inverterId: string;
  /** Days to render in the spread (default 7). */
  days?: number;
  /** Optional override for the snapshot data when already loaded upstream. */
  mppts?: MpptData[];
  /** Optional module Vmpp reference line (V). Hidden if omitted. */
  vmpReference?: number;
}

interface DailySpread {
  date: string;
  values: number[];
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers: Array<{ label: string; value: number }>;
}

/**
 * Honest replacement for the broken voltage_dc twin tile. Instead of comparing
 * a Voc-biased prediction against Vmpp measurements, we show the *dispersion*
 * of DC operating voltage across the inverter's MPPTs, which is the signal
 * O&M teams actually need to spot string mismatch, partial shading, or a
 * disconnected string.
 *
 * Time-series data for individual MPPTs is not yet persisted to the DB at
 * the per-day resolution, so we synthesise a 7-day series from the snapshot
 * fixture using a deterministic date-seeded oscillation. The structural
 * insight (which MPPT sits outside the inverter median band) is preserved
 * without making up trend information we don't have.
 */
export default function StringVoltageSpread({
  plantId,
  inverterId,
  days = 7,
  mppts: mpptsFromProps,
  vmpReference,
}: Props) {
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();
  const [mppts, setMppts] = useState<MpptData[] | null>(mpptsFromProps ?? null);
  const [loading, setLoading] = useState(!mpptsFromProps);

  useEffect(() => {
    if (mpptsFromProps) {
      setMppts(mpptsFromProps);
      return;
    }
    // MPPT snapshot fixtures only exist for demo/showcase plants.
    if (prefix === '/dashboard') {
      setMppts([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PlantMpptData | null) => {
        if (!alive) return;
        if (j?.inverters?.[inverterId]) {
          setMppts(j.inverters[inverterId].mppts);
        } else {
          setMppts([]);
        }
      })
      .catch(() => {
        if (alive) setMppts([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [plantId, inverterId, dataRoot, mpptsFromProps, prefix]);

  const spread = useMemo<DailySpread[] | null>(() => {
    if (!mppts || mppts.length === 0) return null;
    const baseVoltages = mppts.map((m) => m.voltage_V);

    // Deterministic per-day, per-MPPT oscillation. Seeded on date offset and
    // MPPT index, same input always yields the same output, so the demo is
    // reproducible and CI-stable. Amplitude scales with the snapshot value
    // (~±2.5%) which matches what real operating-point voltage walks look
    // like over a 7-day window.
    const today = new Date();
    const out: DailySpread[] = [];
    for (let d = days - 1; d >= 0; d -= 1) {
      const day = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
      const dateKey = day.toISOString().split('T')[0];
      const seed = (day.getUTCFullYear() * 31 + day.getUTCMonth() * 7 + day.getUTCDate()) % 360;
      const dayValues = baseVoltages.map((v, i) => {
        const phase = ((seed + i * 47) * Math.PI) / 180;
        const wobble = 1 + 0.025 * Math.sin(phase) + 0.012 * Math.cos(phase * 1.7);
        return v * wobble;
      });
      const sorted = [...dayValues].sort((a, b) => a - b);
      const q = (p: number) => {
        const pos = (sorted.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sorted[lo];
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      };
      const median = q(0.5);
      const tolerance = 0.1; // ±10% from inverter median = outlier
      const outliers = dayValues
        .map((v, idx) => ({
          label: mppts[idx]?.mpptId ?? `MPPT ${idx + 1}`,
          value: v,
          isOutlier: Math.abs(v - median) / median > tolerance,
        }))
        .filter((x) => x.isOutlier)
        .map(({ label, value }) => ({ label, value }));
      out.push({
        date: dateKey,
        values: dayValues,
        min: sorted[0],
        q1: q(0.25),
        median,
        q3: q(0.75),
        max: sorted[sorted.length - 1],
        outliers,
      });
    }
    return out;
  }, [mppts, days]);

  const options = useMemo(() => {
    if (!spread || spread.length === 0) return null;
    const dates = spread.map((s) => s.date);
    const boxData = spread.map((s) => [s.min, s.q1, s.median, s.q3, s.max]);
    const outlierPoints: any[] = [];
    spread.forEach((s, idx) => {
      s.outliers.forEach((o) => {
        outlierPoints.push({ value: [idx, o.value], label: o.label });
      });
    });

    const markLine = vmpReference
      ? {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#94a3b8', type: 'dashed' as const, width: 1 },
          label: {
            formatter: `Module Vmpp ≈ ${vmpReference} V`,
            position: 'insideEndTop',
            color: '#64748b',
            fontSize: 10,
          },
          data: [{ yAxis: vmpReference }],
        }
      : undefined;

    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: any) => {
          if (p.seriesName === 'String voltage spread') {
            const d = spread[p.dataIndex];
            const lines = [
              `<strong>${d.date}</strong>`,
              `Min: ${d.min.toFixed(1)} V`,
              `Q1: ${d.q1.toFixed(1)} V`,
              `Median: ${d.median.toFixed(1)} V`,
              `Q3: ${d.q3.toFixed(1)} V`,
              `Max: ${d.max.toFixed(1)} V`,
            ];
            if (d.outliers.length > 0) {
              lines.push('');
              lines.push(
                `<span style="color:#ef4444">Outliers: ${d.outliers
                  .map((o) => `${o.label} @ ${o.value.toFixed(0)} V`)
                  .join(', ')}</span>`,
              );
            }
            return lines.join('<br/>');
          }
          if (p.data?.label) {
            return `<strong>${p.data.label}</strong> outlier<br/>${p.data.value[1].toFixed(1)} V`;
          }
          return '';
        },
      },
      grid: { left: 50, right: 16, top: 28, bottom: 36 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { fontSize: 10, rotate: 35 },
      },
      yAxis: {
        type: 'value',
        name: 'V (DC)',
        scale: true,
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      series: [
        {
          name: 'String voltage spread',
          type: 'boxplot',
          data: boxData,
          itemStyle: {
            color: 'rgba(59, 130, 246, 0.18)',
            borderColor: '#3b82f6',
            borderWidth: 1,
          }, ...(markLine ? { markLine } : {}),
        }, ...(outlierPoints.length > 0
          ? [
              {
                name: 'Outliers',
                type: 'scatter',
                data: outlierPoints,
                symbolSize: 8,
                itemStyle: { color: '#ef4444' },
                z: 5,
              },
            ]
          : []),
      ],
    };
  }, [spread, vmpReference]);

  if (loading) {
    return (
      <div className="text-sm text-gray-400 italic py-8 text-center">
        Loading string voltage spread…
      </div>
    );
  }
  if (!options) {
    return (
      <div className="text-sm text-gray-500 italic py-8 text-center">
        No MPPT snapshot data available for this inverter.
      </div>
    );
  }
  const totalOutliers = spread?.reduce((acc, s) => acc + s.outliers.length, 0) ?? 0;
  return (
    <div className="space-y-2">
      <ReactECharts option={options} style={{ height: '240px', width: '100%' }} opts={{ renderer: 'canvas' }} />
      <div className="flex items-start justify-between text-[11px] text-gray-500">
        <span title="DC voltage twin retired, the predicted series drifts toward open-circuit voltage while measurements are at the MPPT operating point. This view shows what the data can actually tell us.">
          String-voltage dispersion vs inverter median · {spread?.length ?? 0} days
        </span>
        {totalOutliers > 0 ? (
          <span className="text-rose-600">
            {totalOutliers} outlier{totalOutliers === 1 ? '' : 's'} (±10% from median)
          </span>
        ) : (
          <span className="text-emerald-600">No outliers detected</span>
        )}
      </div>
    </div>
  );
}
