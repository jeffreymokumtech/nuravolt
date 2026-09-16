'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { WidgetProps } from './registry';
import { expandDateRange, resolveWidgetScope } from '@/types/dashboard';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface InverterMetric {
  inverterId: string;
  lossPct: number;
  severity?: string;
}

/**
 * Fleet heatmap-ish ranking: per-inverter loss % sorted worst-first.
 * Uses the `/api/digitaltwin/[plantId]/inverter-metrics` endpoint which
 * already aggregates over the selected window.
 */
export default function PvResidualHeatmap({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [inverters, setInverters] = useState<InverterMetric[]>([]);
  const [loading, setLoading] = useState(false);
  const plantId = resolved.plantIds[0];

  useEffect(() => {
    if (!plantId) return;
    setLoading(true);
    const { from, to } = expandDateRange(resolved.range, resolved.from, resolved.to);
    fetch(
      `/api/digitaltwin/${encodeURIComponent(plantId)}/inverter-metrics?from=${from}&to=${to}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setInverters(json?.inverters ?? []))
      .catch(() => setInverters([]))
      .finally(() => setLoading(false));
  }, [plantId, resolved.range, resolved.from, resolved.to]);

  const option = useMemo(() => {
    if (!inverters.length) return null;
    // Top 40 worst-performing by loss
    const sorted = [...inverters].sort((a, b) => b.lossPct - a.lossPct).slice(0, 40);
    const ids = sorted.map((i) => i.inverterId);
    const values = sorted.map((i) => Math.round(i.lossPct * 100) / 100);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 20, top: 10, bottom: 30 },
      xAxis: { type: 'value', name: 'Loss %', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: ids,
        axisLabel: { fontSize: 10, width: 70, overflow: 'truncate' },
        inverse: true,
      },
      series: [
        {
          type: 'bar',
          data: values,
          itemStyle: {
            color: (params: any) => {
              const v = params.value;
              if (v > 10) return '#dc2626';
              if (v > 5) return '#f59e0b';
              return '#10b981';
            },
          },
          barWidth: 10,
        },
      ],
    };
  }, [inverters]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 italic p-4 text-center">
        Pick a plant to show the fleet loss ranking.
      </div>
    );
  }
  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  if (!option) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No per-inverter metrics for {plantId} in this range.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title || `Fleet loss ranking · ${plantId} · top 40`}
      </div>
      <div className="flex-1 min-h-0">
        <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />
      </div>
    </div>
  );
}
