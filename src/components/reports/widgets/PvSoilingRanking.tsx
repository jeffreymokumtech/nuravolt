'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';

/**
 * Per-inverter soiling ranking, dirtiest first. Backed by the per-inverter
 * SR estimate API (`/api/soiling/plants/[plantId]/inverters/sr-estimate`).
 * Degrades to a friendly empty state when the plant has no per-inverter
 * artifact yet ({available:false}), when the org's plan lacks the
 * per-inverter soiling feature (403), or on error.
 */

interface Row {
  inverterId: string;
  currentSR: number;
  sr7dAvg: number | null;
  confidence: number | null;
}

interface Summary {
  fleetMeanSR: number;
  fleetStdSR: number;
  anomalyCount: number;
  cleaningRecommended: boolean;
}

export default function PvSoilingRanking({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  const plantId = resolved.plantIds[0];

  useEffect(() => {
    if (!plantId) return;
    setState('loading');
    fetch(`/api/soiling/plants/${encodeURIComponent(plantId)}/inverters/sr-estimate?days=7`)
      .then(async (r) => {
        if (r.status === 403) {
          setState('empty');
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (json?.available === false || !json?.inverters) {
          setState('empty');
          return;
        }
        const next: Row[] = Object.entries(json.inverters as Record<string, any>)
          .map(([inverterId, d]) => ({
            inverterId,
            currentSR: Number(d.currentSR),
            sr7dAvg: d.sr7dAvg != null ? Number(d.sr7dAvg) : null,
            confidence: d.confidence != null ? Number(d.confidence) : null,
          }))
          .filter((r2) => Number.isFinite(r2.currentSR))
          .sort((a, b) => a.currentSR - b.currentSR);
        setRows(next);
        setSummary(json.summary ?? null);
        setState(next.length ? 'ready' : 'empty');
      })
      .catch(() => setState('error'));
  }, [plantId]);

  if (!plantId) {
    return <EmptyState message="Pick a plant to rank inverters by soiling." />;
  }
  if (state === 'loading') return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  if (state === 'empty') {
    return <EmptyState message={`Per-inverter soiling data is not available for ${plantId} yet.`} />;
  }
  if (state === 'error') {
    return <EmptyState message="Could not load per-inverter soiling estimates." />;
  }

  const fleetMean = summary?.fleetMeanSR ?? null;
  // Scale bars to the observed SR spread so differences stay readable.
  const minSR = Math.min(...rows.map((r) => r.currentSR));
  const floor = Math.min(0.9, Math.floor((minSR - 0.01) * 100) / 100);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
        <span>
          Dirtiest first · fleet mean{' '}
          <span className="font-semibold text-gray-700">
            {fleetMean != null ? fleetMean.toFixed(3) : '–'}
          </span>
        </span>
        {summary?.cleaningRecommended ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            Cleaning recommended
          </span>
        ) : (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
            Fleet OK
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.map((r, i) => {
          const frac = Math.max(0.03, (r.currentSR - floor) / (1 - floor));
          const deficitPct = (1 - r.currentSR) * 100;
          const tone =
            deficitPct >= 8 ? 'bg-red-400' : deficitPct >= 5 ? 'bg-amber-400' : 'bg-emerald-400';
          return (
            <div key={r.inverterId} className="flex items-center gap-2 text-xs">
              <span className="w-14 shrink-0 truncate text-gray-600">{r.inverterId}</span>
              <div className="h-3.5 min-w-0 flex-1 rounded-sm bg-gray-100">
                <div
                  className={`h-full rounded-sm ${tone}`}
                  style={{ width: `${Math.min(100, frac * 100)}%` }}
                />
              </div>
              <span className={`w-12 shrink-0 text-right tabular-nums ${i < 3 ? 'font-semibold text-gray-800' : 'text-gray-500'}`}>
                {r.currentSR.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 text-[10px] text-gray-400">
        Soiling ratio, 1.000 = clean. {rows.length} inverters, last 7 days.
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
