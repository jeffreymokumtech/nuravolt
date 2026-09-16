'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { expandDateRange, resolveWidgetScope } from '@/types/dashboard';
import { chartMetricMeta } from '@/lib/reports/chart-metrics';
import OpsLineChart, { type Series } from '@/components/ops/charts/OpsLineChart';
import ChartFill from './ChartFill';

/**
 * Generic timeseries chart widget: any metric from the shared chart-metrics
 * vocabulary, plant- or device-scoped, over the widget/dashboard range.
 * Twin metrics render predicted (dashed) vs actual (solid); measured
 * metrics render a single daily-average series. This is the widget the
 * Shams getChart tool emits ready-to-add configs for.
 */

interface Point {
  date: string;
  actual: number | null;
  predicted: number | null;
}

export default function ChartTimeseries({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metric = String(widget.config.options?.metric ?? 'power_ac');
  const meta = chartMetricMeta(metric);
  const plantId = resolved.plantIds[0];
  const deviceId = resolved.deviceIds[0];

  useEffect(() => {
    if (!plantId || !meta) return;
    setLoading(true);
    setError(null);
    const { from, to } = expandDateRange(resolved.range, resolved.from, resolved.to);

    const load = async () => {
      if (meta.source === 'twin') {
        const url = `/api/digitaltwin/${encodeURIComponent(plantId)}/timeseries?device_id=${encodeURIComponent(
          deviceId ?? 'PLANT'
        )}&metric=${metric}&from=${from}&to=${to}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return (json?.series ?? []).map((r: any) => ({
          date: String(r.date).slice(0, 10),
          actual: r.actual ?? null,
          predicted: r.predicted ?? null,
        }));
      }
      // measurements source: long-format daily rows, average per bucket
      const params = new URLSearchParams({
        metrics: metric,
        resolution: 'daily',
        from,
        to,
      });
      if (deviceId) params.set('devices', deviceId);
      const res = await fetch(`/api/measurements/${encodeURIComponent(plantId)}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const byDate = new Map<string, { sum: number; n: number }>();
      for (const row of json?.data ?? []) {
        const d = String(row.bucket ?? row.timestamp ?? '').slice(0, 10);
        const v = Number(row.avg_value ?? row.value);
        if (!d || !Number.isFinite(v)) continue;
        const cur = byDate.get(d) ?? { sum: 0, n: 0 };
        cur.sum += v;
        cur.n += 1;
        byDate.set(d, cur);
      }
      return Array.from(byDate.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { sum, n }]) => ({
          date,
          actual: sum / n,
          predicted: null as number | null,
        }));
    };

    load()
      .then((pts) => setPoints(pts))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [plantId, deviceId, metric, meta?.source, resolved.range, resolved.from, resolved.to]);

  if (!meta) {
    return <EmptyState message={`Unknown metric "${metric}". Pick one in the widget config.`} />;
  }
  if (!plantId) {
    return <EmptyState message="Pick a plant from the scope bar or in this widget's config." />;
  }
  if (loading) return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;
  if (points.length < 2) {
    return (
      <EmptyState
        message={`No ${meta.label.toLowerCase()} data for ${deviceId ?? plantId} in the selected range.`}
      />
    );
  }

  const series: Series[] = [];
  if (points.some((p) => p.predicted != null)) {
    series.push({
      key: 'predicted',
      label: 'Predicted',
      values: points.map((p) => p.predicted),
      tone: 'info',
      dashed: true,
    });
  }
  series.push({
    key: 'actual',
    label: meta.source === 'twin' ? 'Actual' : meta.label,
    values: points.map((p) => p.actual),
    tone: 'ok',
  });

  const n = points.length;
  const stride = Math.max(1, Math.floor(n / 6));
  const xLabels = points.map((p, i) => (i % stride === 0 ? p.date.slice(5) : ''));

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 text-xs text-gray-500">
        {widget.config.title || `${meta.label} · ${deviceId ?? plantId}`}
        <span className="ml-2 text-gray-400">
          ({meta.unit} · {points.length} points)
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ChartFill>
          {(height) => (
            <OpsLineChart
              series={series}
              xLabels={xLabels}
              xTooltipLabels={points.map((p) => p.date)}
              height={height}
            />
          )}
        </ChartFill>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm italic text-gray-500">
      {message}
    </div>
  );
}
