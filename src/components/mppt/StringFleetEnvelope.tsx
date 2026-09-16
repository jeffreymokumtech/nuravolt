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
  days?: number;
  /** Optional pre-loaded MPPT snapshot data to avoid a second fetch. */
  mppts?: MpptData[];
}

interface StringSeries {
  stringId: string;
  mpptId: string;
  color: string;
  daily: number[]; // power_kW per day
}

const MPPT_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f43f5e',
];

/**
 * String-power lines for every string in this inverter, drawn against the
 * same-inverter P10/P50/P90 envelope. Color-coded by MPPT so the user can
 * see at a glance whether an outlier is an isolated string or a whole MPPT
 * sliding away from the inverter peers.
 *
 * String time-series isn't persisted yet, so we synthesize 30 days from the
 * snapshot using a deterministic per-string oscillation. Real underperformers
 * (degraded / open_circuit strings in the fixture) keep their lower mean so
 * the visual story still matches the snapshot truth.
 */
export default function StringFleetEnvelope({
  plantId,
  inverterId,
  days = 30,
  mppts: mpptsFromProps,
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
    // MPPT/string fixtures only exist for demo/showcase plants.
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

  const { dates, strings, envelope } = useMemo(() => {
    if (!mppts || mppts.length === 0) {
      return { dates: [] as string[], strings: [] as StringSeries[], envelope: [] as Array<{ p10: number; p50: number; p90: number }> };
    }

    const today = new Date();
    const allDates: string[] = [];
    for (let d = days - 1; d >= 0; d -= 1) {
      const day = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
      allDates.push(day.toISOString().split('T')[0]);
    }

    // Flatten every string in the inverter, tagged with MPPT colour.
    const flat: Array<{ stringId: string; mpptId: string; baselinePower: number; status: string; mpptIndex: number }> = [];
    mppts.forEach((m, mIdx) => {
      m.strings.forEach((s) => {
        flat.push({
          stringId: s.stringId,
          mpptId: m.mpptId,
          baselinePower: s.power_kW,
          status: s.status,
          mpptIndex: mIdx,
        });
      });
    });

    const strSeries: StringSeries[] = flat.map((s, sIdx) => {
      const color = MPPT_PALETTE[s.mpptIndex % MPPT_PALETTE.length];
      // Degraded / open / shorted strings already have a lower baselinePower
      // in the snapshot fixture, so we preserve that and add a small
      // deterministic walk on top. Healthy strings wobble ±5%.
      const amp = s.status === 'normal' ? 0.05 : 0.09;
      const daily = allDates.map((d) => {
        const dayObj = new Date(d);
        const seed = (dayObj.getUTCFullYear() + dayObj.getUTCMonth() * 31 + dayObj.getUTCDate() + sIdx * 13) % 360;
        const phase = (seed * Math.PI) / 180;
        const wobble = 1 + amp * Math.sin(phase) + (amp / 2) * Math.cos(phase * 2.1);
        return Math.max(0, s.baselinePower * wobble);
      });
      return { stringId: s.stringId, mpptId: s.mpptId, color, daily };
    });

    // Per-day P10/P50/P90 across every string in the inverter.
    const env = allDates.map((_, dIdx) => {
      const vals = strSeries.map((s) => s.daily[dIdx]).sort((a, b) => a - b);
      const q = (p: number) => {
        const pos = (vals.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return vals[lo];
        return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
      };
      return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
    });

    return { dates: allDates, strings: strSeries, envelope: env };
  }, [mppts, days]);

  const options = useMemo(() => {
    if (!dates || dates.length === 0) return null;
    const p10 = envelope.map((e) => Math.round(e.p10 * 100) / 100);
    const p90minusP10 = envelope.map((e, i) =>
      Math.max(0, Math.round((e.p90 - e.p10) * 100) / 100),
    );
    const p50 = envelope.map((e) => Math.round(e.p50 * 100) / 100);
    const r2 = (v: number) => Math.round(v * 100) / 100;

    const stringSeries = strings.map((s) => ({
      name: `${s.mpptId}·${s.stringId}`,
      type: 'line',
      data: s.daily.map(r2),
      symbol: 'none',
      lineStyle: { color: s.color, width: 1, opacity: 0.7 },
      itemStyle: { color: s.color },
      z: 3,
    }));

    return {
      tooltip: { trigger: 'axis', confine: true },
      legend: {
        show: false,
      },
      grid: { left: 50, right: 16, top: 30, bottom: 50 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { fontSize: 9, rotate: 35 },
      },
      yAxis: {
        type: 'value',
        name: 'String power (kW)',
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      dataZoom: [{ type: 'inside', start: 60, end: 100 }],
      series: [
        // Lower band anchor.
        {
          name: 'P10',
          type: 'line',
          stack: 'env',
          data: p10,
          symbol: 'none',
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'transparent' },
          silent: true,
          z: 1,
        },
        // Ribbon.
        {
          name: 'Inverter P10,P90',
          type: 'line',
          stack: 'env',
          data: p90minusP10,
          symbol: 'none',
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'rgba(100, 116, 139, 0.16)' },
          z: 1,
        },
        // Median dashed.
        {
          name: 'Inverter median',
          type: 'line',
          data: p50,
          symbol: 'none',
          lineStyle: { color: '#64748b', width: 1, type: 'dashed' as const },
          z: 2,
        }, ...stringSeries,
      ],
    };
  }, [dates, envelope, strings]);

  const mpptLegend = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of strings) {
      if (!seen.has(s.mpptId)) seen.set(s.mpptId, s.color);
    }
    return Array.from(seen.entries()).map(([mpptId, color]) => ({ mpptId, color }));
  }, [strings]);

  if (loading) {
    return (
      <div className="text-sm text-gray-400 italic py-6 text-center">
        Loading string fleet envelope…
      </div>
    );
  }
  if (!options) {
    return (
      <div className="text-sm text-gray-500 italic py-6 text-center">
        No string-level data available.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ReactECharts option={options} style={{ height: '260px', width: '100%' }} opts={{ renderer: 'canvas' }} />
      <div className="flex items-start justify-between text-[11px]">
        <div className="text-gray-500">
          Each line = one string · grey band = same-inverter P10,P90 across
          every string · dashed = inverter median.
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          {mpptLegend.map((m) => (
            <div key={m.mpptId} className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: m.color }} />
              <span className="text-gray-600 font-mono text-[10px]">{m.mpptId}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

