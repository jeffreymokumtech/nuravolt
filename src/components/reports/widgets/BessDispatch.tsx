'use client';

import { useEffect, useState } from 'react';
import DispatchScheduleChart from '@/components/bess/DispatchScheduleChart';
import type { DispatchSchedule, DispatchSlot } from '@/types/bess';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { fetchBessAssetResource, resolveBessPlant } from './bessApi';
import ChartFill from './ChartFill';

/**
 * BESS dispatch widget. API-first (works for DB-backed plants like
 * region_a-storage AND fixture demo plants); the static parallel-array JSON
 * stays as a last-resort fallback and is transformed into the same
 * DispatchSlot[] shape the chart expects.
 */
export default function BessDispatch({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [raw, setRaw] = useState<any>(null);
  const [api, setApi] = useState<{ schedule: any; slots: DispatchSlot[] } | null>(null);
  const [loading, setLoading] = useState(false);
  // Scan the whole scope for the storage plant (mixed PV+BESS scopes used
  // to dead-end on the PV plant).
  const scopeKey = resolved.plantIds.join(',');
  const [plantId, setPlantId] = useState<string | undefined>(resolved.plantIds[0]);
  const dataRoot = useDataRoot();

  useEffect(() => {
    const ids = scopeKey ? scopeKey.split(',') : [];
    if (ids.length === 0) return;
    setLoading(true);
    setApi(null);
    setRaw(null);
    (async () => {
      const target = await resolveBessPlant(ids);
      const plantId = target?.plantId ?? ids[0];
      const asset = target?.asset ?? null;
      setPlantId(plantId);
      if (asset) {
        const d = await fetchBessAssetResource<any>(plantId, asset.id, 'dispatch');
        if (d?.slots?.length) {
          setApi({ schedule: d.schedule, slots: d.slots });
          return;
        }
      }
      // Fallback: static fixture.
      const r = await fetch(`${dataRoot}/bess/${plantId}/dispatch_schedule.json`).catch((): null => null);
      setRaw(r && r.ok ? await r.json() : null);
    })().finally(() => setLoading(false));
  }, [scopeKey, dataRoot]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 italic p-4 text-center">
        Pick a BESS plant to show dispatch schedule.
      </div>
    );
  }
  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;

  if (api) {
    return (
      <div className="flex flex-col h-full">
        <div className="text-xs text-gray-500 mb-2">
          {widget.config.title || `Dispatch schedule · ${plantId} · ${api.schedule?.scheduleDate ?? ''}`}
        </div>
        <div className="flex-1 min-h-0">
          <ChartFill fallback={260}>
            {(height) => <DispatchScheduleChart schedule={api.schedule} slots={api.slots} height={height} />}
          </ChartFill>
        </div>
      </div>
    );
  }

  if (!raw) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No dispatch schedule for {plantId}.
      </div>
    );
  }

  const slots: DispatchSlot[] = (raw.charge_schedule_kw ?? []).map((c: number, i: number) => {
    const discharge = raw.discharge_schedule_kw?.[i] ?? 0;
    const chargeKw = c < 0 ? Math.abs(c) : 0;
    const dischargeKw = discharge > 0 ? discharge : 0;
    return {
      timestamp: `${raw.schedule_date}T${String(i).padStart(2, '0')}:00`,
      hour: i,
      chargeKw,
      dischargeKw,
      soc: raw.soc_schedule?.[i] ?? 0,
      priceEurMwh: raw.price_forecast?.[i] ?? 0,
      action: chargeKw > 0 ? 'charge' : dischargeKw > 0 ? 'discharge' : 'idle',
    };
  });

  const schedule: DispatchSchedule = {
    scheduleDate: raw.schedule_date,
    horizonHours: raw.horizon_hours ?? 24,
    resolutionMinutes: raw.resolution_minutes ?? 60,
    slots,
  } as DispatchSchedule;

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title || `Dispatch schedule · ${plantId} · ${raw.schedule_date}`}
      </div>
      <div className="flex-1 min-h-0">
        <ChartFill fallback={260}>
          {(height) => <DispatchScheduleChart schedule={schedule} slots={slots} height={height} />}
        </ChartFill>
      </div>
    </div>
  );
}
