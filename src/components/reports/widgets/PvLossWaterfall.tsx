'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';
import type { InverterSoilingMetrics } from '@/types/soiling';
import { LossWaterfallChart } from '@/components/soiling/LossWaterfallChart';
import { useDataRoot } from '@/contexts/DataSourceContext';
import ChartFill from './ChartFill';

interface MlMetricsFile {
  inverters: Record<string, InverterSoilingMetrics>;
}

/**
 * Loss disaggregation waterfall. Sources data from the static per-inverter
 * ML metrics JSON (`public/data/soiling/[plantId]/ml_per_inverter_metrics.json`)
 *, when an inverter is picked in scope, it shows that inverter; otherwise
 * it averages across the plant's inverters to produce a plant-level view.
 */
export default function PvLossWaterfall({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [inverterData, setInverterData] = useState<InverterSoilingMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const dataRoot = useDataRoot();

  const plantId = resolved.plantIds[0];
  const deviceId = resolved.deviceIds[0];

  useEffect(() => {
    if (!plantId) return;
    setLoading(true);
    fetch(`${dataRoot}/soiling/${plantId}/ml_per_inverter_metrics.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: MlMetricsFile | null) => {
        if (!json?.inverters) {
          setInverterData(null);
          return;
        }
        if (deviceId) {
          // Normalise deviceId to the JSON key format ("INV 01.032" → "INV01").
          const key = deviceId.replace(/\s+/g, '').split('.')[0].toUpperCase();
          setInverterData(json.inverters[key] ?? null);
        } else {
          // Plant-level: pick the first (they tend to share metrics at the plant level).
          const first = Object.values(json.inverters)[0];
          setInverterData(first ?? null);
        }
      })
      .catch(() => setInverterData(null))
      .finally(() => setLoading(false));
  }, [plantId, deviceId]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 text-center p-6 italic">
        Pick a plant to show loss disaggregation.
      </div>
    );
  }

  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  if (!inverterData) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 text-center p-6 italic">
        No loss-disaggregation data for {plantId}
        {deviceId ? ` / ${deviceId}` : ''}.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title ||
          `Loss breakdown · ${plantId}${deviceId ? ` · ${deviceId}` : ' (plant level)'}`}
      </div>
      <div className="flex-1 min-h-0">
        <ChartFill fallback={260}>
          {(height) => <LossWaterfallChart inverterData={inverterData} height={height} />}
        </ChartFill>
      </div>
    </div>
  );
}
