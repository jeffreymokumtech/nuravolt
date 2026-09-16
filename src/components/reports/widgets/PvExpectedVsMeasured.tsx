'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { WidgetProps } from './registry';
import { expandDateRange, resolveWidgetScope } from '@/types/dashboard';
import type { TwinPoint } from '@/components/twin/TwinTimelineChart';
import ChartFill from './ChartFill';

const TwinTimelineChart = dynamic(() => import('@/components/twin/TwinTimelineChart'), {
  ssr: false,
});

/**
 * Predicted vs actual power from the digital-twin DB aggregate.
 *
 * Scope:
 * - plantIds[0] is used (if multiple picked, we chart the first)
 * - deviceIds[0] override lets the user scope to a single inverter
 *   (e.g. "INV 01.057"); without it we chart the plant aggregate.
 */
export default function PvExpectedVsMeasured({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [series, setSeries] = useState<TwinPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plantId = resolved.plantIds[0];
  const deviceId = resolved.deviceIds[0] ?? 'PLANT';

  useEffect(() => {
    if (!plantId) return;
    setLoading(true);
    setError(null);
    const { from, to } = expandDateRange(resolved.range, resolved.from, resolved.to);
    fetch(
      `/api/digitaltwin/${encodeURIComponent(plantId)}/timeseries?device_id=${encodeURIComponent(
        deviceId,
      )}&metric=power_ac&from=${from}&to=${to}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setSeries(json?.series ?? []))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [plantId, deviceId, resolved.range, resolved.from, resolved.to]);

  if (!plantId) {
    return (
      <EmptyState
        message="Pick a plant from the scope bar, or set a plant in this widget's config, to load expected vs measured power."
      />
    );
  }

  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  if (error) return <div className="text-sm text-red-500 p-4">Error: {error}</div>;
  if (!series.length) {
    return (
      <EmptyState
        message={`No twin data for ${deviceId} on ${plantId} in the selected range.`}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title || `${plantId}${deviceId !== 'PLANT' ? ` · ${deviceId}` : ''}`}
        <span className="ml-2 text-gray-400">({series.length} points)</span>
      </div>
      <div className="flex-1 min-h-0">
        <ChartFill fallback={260}>
          {(height) => <TwinTimelineChart series={series} unit="Power (kW)" height={height} />}
        </ChartFill>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-gray-500 text-center p-6 italic">
      {message}
    </div>
  );
}
