'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { expandDateRange, resolveWidgetScope } from '@/types/dashboard';

/**
 * Single-value KPI tile. Pulls the digital-twin summary endpoint and shows
 * one metric. `options.metric` picks a field from the response's summary
 * block:
 *   - "total_actual_mwh"    (energy delivered over the range)
 *   - "total_predicted_mwh" (twin-expected energy)
 *   - "total_loss_mwh"      (expected minus delivered)
 *   - "avg_loss_pct"        (average twin loss)
 * Falls back to `avg_loss_pct` if unspecified.
 */
export default function KpiSingleMetric({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const plantId = resolved.plantIds[0];
  const metric = (widget.config.options?.metric as string) ?? 'avg_loss_pct';

  useEffect(() => {
    if (!plantId) return;
    setLoading(true);
    const { from, to } = expandDateRange(resolved.range, resolved.from, resolved.to);
    fetch(
      `/api/digitaltwin/${encodeURIComponent(plantId)}/summary?from=${from}&to=${to}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setSummary(json))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [plantId, resolved.range, resolved.from, resolved.to]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 italic p-4 text-center">
        Pick a plant.
      </div>
    );
  }
  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;

  const rawValue = summary ? pickDeep(summary, metric) : null;
  const formatted = formatValue(rawValue, metric);

  return (
    <div className="h-full flex flex-col justify-center items-center text-center">
      <div className="text-xs text-gray-500 uppercase tracking-wide">
        {widget.config.title || labelFor(metric)}
      </div>
      <div className="text-4xl font-bold text-gray-900 mt-2">{formatted}</div>
      <div className="text-[11px] text-gray-400 mt-2">{plantId}</div>
    </div>
  );
}

function pickDeep(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = pickDeep(obj[k], key);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function formatValue(v: any, metric: string): string {
  if (v === null || v === undefined) return '–';
  if (metric.endsWith('_pct')) return `${Number(v).toFixed(1)}%`;
  if (metric.endsWith('_kw')) return `${Number(v).toFixed(1)} kW`;
  if (metric.endsWith('_mwh')) return `${Number(v).toFixed(1)} MWh`;
  return typeof v === 'number' ? v.toLocaleString() : String(v);
}

function labelFor(metric: string): string {
  return metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
