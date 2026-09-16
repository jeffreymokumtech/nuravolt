'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { fetchBessAssetResource, resolveBessPlant } from './bessApi';

interface WarrantyStatus {
  warranty_health: {
    score: number;
    risk_level: string;
    current_soh: number;
    warranty_threshold: number;
    soh_margin: number;
    cycles_used: number;
    cycles_remaining: number;
    years_remaining: number;
    recommendation: string;
  };
  warranty_terms: {
    capacity_guarantee_pct: number;
    warranty_years: number;
    max_cycles: number;
  };
}

/**
 * BESS warranty status card, reads a single JSON, shows the health score,
 * margin to threshold, cycles used/remaining, and the operator recommendation.
 * Purposefully compact; meant to fit 3-4 units tall in the grid.
 */
export default function BessWarrantyStatus({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [data, setData] = useState<WarrantyStatus | null>(null);
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
    setData(null);
    (async () => {
      // API-first: map the unified warranty response into the card's shape.
      const target = await resolveBessPlant(ids);
      const plantId = target?.plantId ?? ids[0];
      const asset = target?.asset ?? null;
      setPlantId(plantId);
      if (asset) {
        const w = await fetchBessAssetResource<any>(plantId, asset.id, 'warranty');
        const hs = w?.healthScore;
        if (hs?.metrics) {
          setData({
            warranty_health: {
              score: hs.score ?? 0,
              risk_level: hs.riskLevel ?? 'LOW',
              current_soh: hs.metrics.currentSoh ?? 0,
              warranty_threshold: hs.metrics.warrantyThreshold ?? 0,
              soh_margin: hs.metrics.sohMargin ?? 0,
              cycles_used: hs.metrics.cyclesUsed ?? 0,
              cycles_remaining: hs.metrics.cyclesRemaining ?? 0,
              years_remaining: hs.metrics.yearsRemaining ?? 0,
              recommendation: hs.recommendation ?? '',
            },
            warranty_terms: {
              capacity_guarantee_pct: w?.terms?.capacityGuaranteePct ?? 0,
              warranty_years: w?.terms?.warrantyYears ?? 0,
              max_cycles: w?.terms?.maxCycles ?? 0,
            },
          });
          return;
        }
      }
      // Fallback: static fixture.
      const r = await fetch(`${dataRoot}/bess/${plantId}/warranty_status.json`).catch((): null => null);
      setData(r && r.ok ? await r.json() : null);
    })().finally(() => setLoading(false));
  }, [scopeKey, dataRoot]);

  if (!plantId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 italic p-4 text-center">
        Pick a BESS plant to show warranty status.
      </div>
    );
  }
  if (loading) return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  if (!data) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No warranty data for {plantId}.
      </div>
    );
  }

  const wh = data.warranty_health;
  const riskColor =
    wh.risk_level === 'LOW'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : wh.risk_level === 'MEDIUM'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200';
  const Icon = wh.risk_level === 'LOW' ? ShieldCheck : AlertTriangle;

  return (
    <div className="h-full flex flex-col">
      <div className="text-xs text-gray-500 mb-2">
        {widget.config.title || `Warranty status · ${plantId}`}
      </div>
      <div className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${riskColor}`}>
        <Icon className="w-4 h-4" />
        <span className="text-sm font-semibold">
          Health score {wh.score}/100 · {wh.risk_level}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3 text-xs">
        <dt className="text-gray-500">SoH</dt>
        <dd className="font-semibold text-gray-900">
          {(wh.current_soh * 100).toFixed(1)}%
        </dd>
        <dt className="text-gray-500">Margin to threshold</dt>
        <dd className="font-semibold text-gray-900">
          +{(wh.soh_margin * 100).toFixed(1)}%
        </dd>
        <dt className="text-gray-500">Cycles used</dt>
        <dd className="font-semibold text-gray-900">
          {Math.round(wh.cycles_used).toLocaleString()} / {data.warranty_terms.max_cycles.toLocaleString()}
        </dd>
        <dt className="text-gray-500">Years remaining</dt>
        <dd className="font-semibold text-gray-900">{wh.years_remaining.toFixed(1)}y</dd>
      </dl>
      <div className="mt-auto text-xs text-gray-600 italic pt-2 border-t border-gray-100">
        {wh.recommendation}
      </div>
    </div>
  );
}
