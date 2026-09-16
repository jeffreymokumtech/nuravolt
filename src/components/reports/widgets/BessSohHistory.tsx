'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';
import type { SoHHistoryPoint } from '@/types/bess';
import SoHHistoryChart from '@/components/bess/SoHHistoryChart';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { fetchBessAssetResource, resolveBessPlant } from './bessApi';
import ChartFill from './ChartFill';

/**
 * BESS State-of-Health over time with warranty threshold line.
 * Loads the static demo snapshot at `public/data/bess/[plantId]/soh_history.json`.
 * When wired to live data later, swap this fetch for `/api/bess/plants/.../soh_history`.
 */
export default function BessSohHistory({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [data, setData] = useState<SoHHistoryPoint[]>([]);
  const [assetInfo, setAssetInfo] = useState<{
    installation_date?: string;
    warranty_years?: number;
    capacity_guarantee_pct?: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const dataRoot = useDataRoot();

  // Scan the whole scope for the storage plant (mixed PV+BESS scopes
  // used to dead-end on the PV plant).
  const scopeKey = resolved.plantIds.join(',');
  const [plantId, setPlantId] = useState<string | undefined>(resolved.plantIds[0]);

  useEffect(() => {
    const ids = scopeKey ? scopeKey.split(',') : [];
    if (ids.length === 0) return;
    setLoading(true);
    setData([]);
    setAssetInfo(null);
    (async () => {
      // API-first: DB-backed plants (region_a-storage) and fixture plants alike.
      const target = await resolveBessPlant(ids);
      const plantId = target?.plantId ?? ids[0];
      const asset = target?.asset ?? null;
      setPlantId(plantId);
      if (asset) {
        const [cycling, warranty] = await Promise.all([
          fetchBessAssetResource<any>(plantId, asset.id, 'cycling'),
          fetchBessAssetResource<any>(plantId, asset.id, 'warranty'),
        ]);
        const soh: SoHHistoryPoint[] = Array.isArray(cycling?.sohHistory)
          ? cycling.sohHistory
          : [];
        if (soh.length) {
          setData(soh);
          setAssetInfo({
            installation_date: asset.installationDate ?? undefined,
            warranty_years: warranty?.terms?.warrantyYears ?? undefined,
            capacity_guarantee_pct: warranty?.terms?.capacityGuaranteePct ?? undefined,
          });
          return;
        }
      }
      // Fallback: static fixtures.
      const [sohJson, assetJson] = await Promise.all([
        fetch(`${dataRoot}/bess/${plantId}/soh_history.json`).then((r) => (r.ok ? r.json() : null)).catch((): null => null),
        fetch(`${dataRoot}/bess/${plantId}/asset_info.json`).then((r) => (r.ok ? r.json() : null)).catch((): null => null),
      ]);
      setData(Array.isArray(sohJson) ? sohJson : []);
      setAssetInfo(
        assetJson
          ? {
              installation_date: assetJson.installation_date,
              warranty_years: assetJson.warranty_years,
              capacity_guarantee_pct: assetJson.capacity_guarantee_pct,
            }
          : null,
      );
    })().finally(() => setLoading(false));
  }, [scopeKey, dataRoot]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 text-center p-6 italic">
        Pick a BESS plant to view State-of-Health history.
      </div>
    );
  }

  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 text-center p-6 italic">
        No SoH data for {plantId}.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title || `State of Health · ${plantId}`}
        <span className="ml-2 text-gray-400">({data.length} snapshots)</span>
      </div>
      <div className="flex-1 min-h-0">
        <ChartFill fallback={260}>
          {(height) => (
            <SoHHistoryChart
              data={data}
              installationDate={assetInfo?.installation_date ?? null}
              warrantyYears={assetInfo?.warranty_years ?? null}
              capacityGuaranteePct={assetInfo?.capacity_guarantee_pct ?? null}
              height={height}
            />
          )}
        </ChartFill>
      </div>
    </div>
  );
}
