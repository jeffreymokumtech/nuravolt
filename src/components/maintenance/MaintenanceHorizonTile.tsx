'use client';

import { useEffect, useState } from 'react';
import { Sparkles, AlertTriangle, Droplets, Wrench, ShieldAlert, Eye } from 'lucide-react';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';
import { Abbr } from '@/components/ui/AbbrTooltip';
import type { Classification } from '@/lib/maintenance/types';

interface Props {
  plantId: string;
  inverterId: string;
}

const TIER_BADGE: Record<string, string> = {
  ACUTE: 'bg-red-100 text-red-700 border-red-200',
  DEGRADED: 'bg-orange-100 text-orange-700 border-orange-200',
  CHRONIC: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  NORMAL: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const CAUSE_LABEL: Record<string, string> = {
  SOILING: 'Soiling',
  SHADING: 'Shading',
  THERMAL: 'Thermal stress',
  STRING_DEGRADATION: 'String degradation',
  BYPASS_DIODE: 'Bypass-diode failure',
  INVERTER_DERATE: 'Inverter derate',
  NORMAL: 'No actionable fault',
};

const ACTION_META: Record<
  string,
  { label: string; tint: string; icon: any; ticketTrigger: string; ticketLabel: string }
> = {
  CLEANING: {
    label: 'Cleaning recommended',
    tint: 'from-amber-50 to-amber-100 border-amber-200 text-amber-900',
    icon: Droplets,
    ticketTrigger: 'SOILING_FORECAST',
    ticketLabel: 'Draft cleaning ticket',
  },
  INSPECTION: {
    label: 'Inspection recommended',
    tint: 'from-orange-50 to-orange-100 border-orange-200 text-orange-900',
    icon: Wrench,
    ticketTrigger: 'PERFORMANCE_ANOMALY',
    ticketLabel: 'Draft inspection ticket',
  },
  REPLACEMENT: {
    label: 'Urgent replacement',
    tint: 'from-red-50 to-red-100 border-red-200 text-red-900',
    icon: ShieldAlert,
    ticketTrigger: 'THRESHOLD_ALERT',
    ticketLabel: 'Draft replacement ticket',
  },
  MONITOR: {
    label: 'Monitor',
    tint: 'from-slate-50 to-slate-100 border-slate-200 text-slate-800',
    icon: Eye,
    ticketTrigger: 'MANUAL_CREATION',
    ticketLabel: 'Draft monitoring ticket',
  },
};

function ConfidenceBar({ value, tint }: { value: number; tint: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1.5 w-32 overflow-hidden rounded bg-zinc-200">
      <div
        className={`h-full ${tint}`}
        style={{ width: `${pct}%` }}
        aria-label={`confidence ${pct.toFixed(0)}%`}
      />
    </div>
  );
}

export default function MaintenanceHorizonTile({ plantId, inverterId }: Props) {
  const [data, setData] = useState<Classification | null>(null);
  const [loading, setLoading] = useState(true);
  const copilot = useCopilotOptional();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(
      `/api/inverters/${encodeURIComponent(inverterId)}/classification?plant_id=${encodeURIComponent(plantId)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Classification | null) => {
        if (alive) setData(j);
      })
      .catch(() => {
        if (alive) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [plantId, inverterId]);

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="text-sm text-gray-400">Loading maintenance horizon…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="text-sm italic text-gray-500">
          Maintenance classifier unavailable for this inverter.
        </div>
      </div>
    );
  }

  const action = ACTION_META[data.recommendedAction] ?? ACTION_META.MONITOR;
  const ActionIcon = action.icon;
  const causeLabel = CAUSE_LABEL[data.likelyCause] ?? data.likelyCause;
  const confTint =
    data.confidence >= 0.7
      ? 'bg-emerald-500'
      : data.confidence >= 0.5
      ? 'bg-amber-500'
      : 'bg-rose-500';
  const etaText =
    data.etaDays != null
      ? `${data.etaDays} day${data.etaDays === 1 ? '' : 's'}`
      : 'no fixed ETA, schedule on next visit';

  const draftSeed = () => {
    const evidenceLines = data.evidence.map((e) => `  • ${e}`).join('\n');
    const etaLine = data.etaDays != null ? `\nETA: ${data.etaDays} days` : '';
    const projLine =
      data.projectedEnergyLossKwhPerDay != null
        ? `\nProjected energy loss if untreated: ${data.projectedEnergyLossKwhPerDay.toFixed(0)} kWh / day`
        : '';
    return [
      `Draft a maintenance ticket for ${data.inverterId} on plant ${data.plantId}:`,
      `Likely cause: ${data.likelyCause} (${(data.confidence * 100).toFixed(0)}% confidence, rule ${data.ruleId})`,
      `Recommended action: ${data.recommendedAction}${etaLine}${projLine}`,
      'Evidence:',
      evidenceLines,
      `Call proposeTicket with trigger_type=${action.ticketTrigger} and priority=${data.tier === 'ACUTE' ? 'HIGH' : data.tier === 'DEGRADED' ? 'MEDIUM' : 'LOW'}.`,
    ].join('\n');
  };

  return (
    <div
      className={`rounded-xl border bg-gradient-to-br ${action.tint} p-5 shadow-sm`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <ActionIcon className="h-4 w-4" />
            <h3 className="text-base font-semibold">Maintenance horizon</h3>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${TIER_BADGE[data.tier]}`}
            >
              {data.tier}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-600">
              <Abbr term="PDS">PDS</Abbr> {data.pds >= 0 ? '+' : ''}
              {data.pds.toFixed(1)}
              <Abbr term="σ">σ</Abbr> · peer {data.group}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-700">{action.label}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Likely cause
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-lg font-semibold">{causeLabel}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-700">
            <ConfidenceBar value={data.confidence} tint={confTint} />
            <span>{(data.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">ETA</div>
          <div className="mt-1 text-lg font-semibold">{etaText}</div>
          {data.projectedEnergyLossKwhPerDay != null && (
            <div className="mt-1 text-xs text-zinc-600">
              ~{data.projectedEnergyLossKwhPerDay.toFixed(0)} kWh/day at risk
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">Rule</div>
          <div className="mt-1 font-mono text-sm">{data.ruleId}</div>
          <div className="mt-1 text-[10px] text-zinc-500">
            Deterministic classifier · {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>

      {data.evidence.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Evidence
          </div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {data.evidence.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-zinc-800">
                <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {copilot ? (
          <button
            type="button"
            onClick={() => copilot.seedNextMessage(draftSeed())}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800"
          >
            <ActionIcon className="h-3.5 w-3.5" />
            {action.ticketLabel}
          </button>
        ) : (
          <span className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-500">
            Open Shams to draft a ticket
          </span>
        )}
        <a
          href="#ai-diagnosis"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Run AI Diagnosis
        </a>
      </div>
    </div>
  );
}
