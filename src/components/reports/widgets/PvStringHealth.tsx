'use client';

import { useEffect, useState } from 'react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';
import { useDataRoot } from '@/contexts/DataSourceContext';

/**
 * String and MPPT health rollup from the plant's string-level snapshot
 * fixtures (`public/data/digitaltwin/[plantId]/mppt_string_data.json` and
 * `string_anomalies.json`), the same files the inverter drill-down page
 * reads. Shows string status counts and the worst current anomalies.
 * Degrades to a friendly empty state when the plant has no string data.
 */

interface AnomalyRow {
  inverterId: string;
  mpptId: string;
  stringId: string;
  type: string;
  severity: string;
  description?: string;
}

interface Rollup {
  totalStrings: number;
  normalCount: number;
  anomalyCount: number;
  byType: Record<string, number>;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export default function PvStringHealth({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const dataRoot = useDataRoot();

  const plantId = resolved.plantIds[0];

  useEffect(() => {
    if (!plantId) return;
    setState('loading');
    (async () => {
      const [anomJson, mpptJson] = await Promise.all([
        fetch(`${dataRoot}/digitaltwin/${plantId}/string_anomalies.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch((): null => null),
        fetch(`${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch((): null => null),
      ]);
      if (!anomJson?.summary && !mpptJson?.inverters) {
        setState('empty');
        return;
      }
      let summary: Rollup | null = anomJson?.summary
        ? {
            totalStrings: anomJson.summary.totalStrings ?? 0,
            normalCount: anomJson.summary.normalCount ?? 0,
            anomalyCount: anomJson.summary.anomalyCount ?? 0,
            byType: anomJson.summary.byType ?? {},
          }
        : null;
      if (!summary && mpptJson?.inverters) {
        // No anomaly file: derive counts from the snapshot statuses.
        let total = 0;
        let normal = 0;
        for (const inv of Object.values(mpptJson.inverters as Record<string, any>)) {
          for (const m of inv.mppts ?? []) {
            for (const s of m.strings ?? []) {
              total += 1;
              if (s.status === 'normal') normal += 1;
            }
          }
        }
        summary = { totalStrings: total, normalCount: normal, anomalyCount: total - normal, byType: {} };
      }
      const rows: AnomalyRow[] = (anomJson?.anomalies ?? [])
        .map((a: any) => ({
          inverterId: String(a.inverterId ?? ''),
          mpptId: String(a.mpptId ?? ''),
          stringId: String(a.stringId ?? ''),
          type: String(a.type ?? ''),
          severity: String(a.severity ?? 'info'),
          description: a.description,
        }))
        .sort(
          (a: AnomalyRow, b: AnomalyRow) =>
            (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
        );
      setRollup(summary);
      setAnomalies(rows);
      setState('ready');
    })();
  }, [plantId, dataRoot]);

  if (!plantId) {
    return <EmptyState message="Pick a plant to show string health." />;
  }
  if (state === 'loading') return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  if (state === 'empty' || !rollup) {
    return <EmptyState message={`No string-level data for ${plantId} yet.`} />;
  }

  const healthyPct = rollup.totalStrings
    ? Math.round((rollup.normalCount / rollup.totalStrings) * 100)
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 grid grid-cols-3 gap-2">
        <Stat label="Strings" value={String(rollup.totalStrings)} />
        <Stat
          label="Healthy"
          value={healthyPct != null ? `${healthyPct}%` : '–'}
          tone={healthyPct != null && healthyPct < 95 ? 'warn' : 'ok'}
        />
        <Stat
          label="Anomalies"
          value={String(rollup.anomalyCount)}
          tone={rollup.anomalyCount > 0 ? 'warn' : 'ok'}
        />
      </div>
      {anomalies.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="pb-1 font-medium">Inverter</th>
                <th className="pb-1 font-medium">String</th>
                <th className="pb-1 font-medium">Issue</th>
                <th className="pb-1 text-right font-medium">Severity</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.slice(0, 40).map((a, i) => (
                <tr key={`${a.inverterId}-${a.mpptId}-${a.stringId}-${i}`} className="border-t border-gray-100">
                  <td className="py-1 pr-2 text-gray-700">{a.inverterId}</td>
                  <td className="py-1 pr-2 text-gray-500">
                    {a.mpptId} / {a.stringId}
                  </td>
                  <td className="py-1 pr-2 text-gray-600">{a.type.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="py-1 text-right">
                    <SeverityPill severity={a.severity} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm italic text-gray-400">
          No active string anomalies.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div
        className={`text-sm font-semibold ${
          tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-emerald-700' : 'text-gray-800'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  const cls =
    severity === 'critical'
      ? 'bg-red-100 text-red-700'
      : severity === 'warning'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {severity}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm italic text-gray-500">
      {message}
    </div>
  );
}
