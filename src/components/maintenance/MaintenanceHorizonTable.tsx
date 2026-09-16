'use client';

import Link from 'next/link';
import { Droplets, Wrench, ShieldAlert, Eye, ArrowRight } from 'lucide-react';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';
import type { Classification } from '@/lib/maintenance/types';

interface Props {
  plantId: string;
  rows: Classification[];
}

const TIER_PILL: Record<string, string> = {
  ACUTE: 'bg-red-100 text-red-700 border-red-200',
  DEGRADED: 'bg-orange-100 text-orange-700 border-orange-200',
  CHRONIC: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  NORMAL: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const CAUSE_PILL: Record<string, string> = {
  SOILING: 'bg-amber-50 text-amber-700 border-amber-200',
  SHADING: 'bg-amber-50 text-amber-700 border-amber-200',
  THERMAL: 'bg-orange-100 text-orange-700 border-orange-200',
  STRING_DEGRADATION: 'bg-orange-50 text-orange-700 border-orange-200',
  BYPASS_DIODE: 'bg-red-100 text-red-700 border-red-200',
  INVERTER_DERATE: 'bg-rose-50 text-rose-700 border-rose-200',
  NORMAL: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const CAUSE_LABEL: Record<string, string> = {
  SOILING: 'Soiling',
  SHADING: 'Shading',
  THERMAL: 'Thermal',
  STRING_DEGRADATION: 'String',
  BYPASS_DIODE: 'Bypass diode',
  INVERTER_DERATE: 'Derate',
  NORMAL: 'Normal',
};

const ACTION_ICON: Record<string, any> = {
  CLEANING: Droplets,
  INSPECTION: Wrench,
  REPLACEMENT: ShieldAlert,
  MONITOR: Eye,
};

const ACTION_TICKET_TRIGGER: Record<string, string> = {
  CLEANING: 'SOILING_FORECAST',
  INSPECTION: 'PERFORMANCE_ANOMALY',
  REPLACEMENT: 'THRESHOLD_ALERT',
  MONITOR: 'MANUAL_CREATION',
};

export default function MaintenanceHorizonTable({ plantId, rows }: Props) {
  const copilot = useCopilotOptional();

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        No inverters match the current filter.
      </div>
    );
  }

  const draftFor = (r: Classification) => () => {
    if (!copilot) return;
    const evidenceLines = r.evidence.map((e) => `  • ${e}`).join('\n');
    const etaLine = r.etaDays != null ? `\nETA: ${r.etaDays} days` : '';
    const trigger = ACTION_TICKET_TRIGGER[r.recommendedAction] ?? 'MANUAL_CREATION';
    const priority = r.tier === 'ACUTE' ? 'HIGH' : r.tier === 'DEGRADED' ? 'MEDIUM' : 'LOW';
    copilot.seedNextMessage(
      [
        `Draft a maintenance ticket for ${r.inverterId} on ${plantId}:`,
        `Likely cause: ${r.likelyCause} (${(r.confidence * 100).toFixed(0)}% confidence, rule ${r.ruleId})`,
        `Recommended action: ${r.recommendedAction}${etaLine}`,
        'Evidence:',
        evidenceLines,
        `Call proposeTicket with trigger_type=${trigger} and priority=${priority}.`,
      ].join('\n'),
    );
  };

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Inverter</th>
              <th className="px-3 py-2 text-left">Group</th>
              <th className="px-3 py-2 text-left">Tier</th>
              <th className="px-3 py-2 text-left">Cause</th>
              <th className="px-3 py-2 text-left">Confidence</th>
              <th className="px-3 py-2 text-right">ETA (d)</th>
              <th className="px-3 py-2 text-right">PDS (σ)</th>
              <th className="px-3 py-2 text-right">Loss kWh/d</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ActionIcon = ACTION_ICON[r.recommendedAction] ?? Eye;
              const confPct = (r.confidence * 100).toFixed(0);
              const confTint =
                r.confidence >= 0.7
                  ? 'bg-emerald-500'
                  : r.confidence >= 0.5
                  ? 'bg-amber-500'
                  : 'bg-rose-500';
              return (
                <tr key={r.inverterId} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/demo/plant/${plantId}/inverter/${encodeURIComponent(r.inverterId)}`}
                      className="font-mono text-[12px] text-blue-700 hover:underline"
                    >
                      {r.inverterId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">{r.group}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${TIER_PILL[r.tier]}`}>
                      {r.tier}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${CAUSE_PILL[r.likelyCause]}`}>
                      {CAUSE_LABEL[r.likelyCause] ?? r.likelyCause}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded bg-zinc-200">
                        <div
                          className={`h-full ${confTint}`}
                          style={{ width: `${confPct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-zinc-600 tabular-nums">{confPct}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.etaDays != null ? r.etaDays : ','}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.pds >= 0 ? '+' : ''}
                    {r.pds.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.projectedEnergyLossKwhPerDay != null
                      ? r.projectedEnergyLossKwhPerDay.toFixed(0)
                      : ','}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={draftFor(r)}
                      disabled={!copilot}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                      title={copilot ? 'Open Shams with a pre-filled ticket draft' : 'Shams not available'}
                    >
                      <ActionIcon className="h-3.5 w-3.5" />
                      Draft
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
