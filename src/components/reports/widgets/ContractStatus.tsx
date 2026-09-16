'use client';

import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { WidgetProps } from './registry';
import { resolveWidgetScope } from '@/types/dashboard';

/**
 * Contract status widget: every contract in scope with its worst live
 * obligation status (same precedence + labels as the Contracts tab). One
 * fetch per scoped plant against /api/plants/{slug}/contracts.
 */

const STATUS_TONE: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'On track' },
  at_risk: { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'At risk' },
  breach: { cls: 'bg-red-50 text-red-700 border-red-200', label: 'Breach' },
  no_data: { cls: 'bg-gray-50 text-gray-500 border-gray-200', label: 'No data' },
  unmonitored: { cls: 'bg-gray-50 text-gray-500 border-gray-200', label: 'Terms on file' },
  awaiting_review: { cls: 'bg-blue-50 text-blue-700 border-blue-200', label: 'Awaiting review' },
};

const TYPE_LABEL: Record<string, string> = {
  PPA: 'PPA',
  MODULE_WARRANTY: 'Module warranty',
  INVERTER_WARRANTY: 'Inverter warranty',
  OM_SLA: 'O&M SLA',
  BESS_WARRANTY: 'BESS warranty',
  OTHER: 'Other',
};

const WORST_ORDER = ['breach', 'at_risk', 'ok', 'no_data', 'unmonitored'];

interface Row {
  plantId: string;
  contractId: string;
  type: string;
  title: string;
  counterparty: string | null;
  status: string; // worst obligation status or contract-level state
}

export default function ContractStatus({ scope, widget }: WidgetProps) {
  const resolved = resolveWidgetScope(scope, widget);
  const scopeKey = resolved.plantIds.join(',');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ids = scopeKey ? scopeKey.split(',') : [];
    if (ids.length === 0) return;
    setLoading(true);
    setRows(null);
    (async () => {
      const all: Row[] = [];
      for (const pid of ids) {
        try {
          const r = await fetch(`/api/plants/${encodeURIComponent(pid)}/contracts`);
          if (!r.ok) continue;
          const data = await r.json();
          const obligations: any[] = data?.obligations?.obligations ?? [];
          for (const c of data?.contracts ?? []) {
            let status = 'unmonitored';
            if (c.status === 'DRAFT') {
              status = 'awaiting_review';
            } else {
              const mine = obligations.filter((o) => o.contract_id === c.id);
              status =
                WORST_ORDER.find((s) => mine.some((o) => o.status === s)) ?? 'unmonitored';
            }
            all.push({
              plantId: pid,
              contractId: c.id,
              type: c.contractType,
              title: c.title,
              counterparty: c.counterparty ?? null,
              status,
            });
          }
        } catch {
          // plant without contracts access — skip
        }
      }
      setRows(all);
    })().finally(() => setLoading(false));
  }, [scopeKey]);

  if (!scopeKey) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500 italic p-4 text-center">
        Pick a plant to show contract status.
      </div>
    );
  }
  if (loading || rows === null) {
    return <div className="text-sm text-gray-400 p-4">Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No contracts on file for the selected plants.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5">
        <ScrollText className="w-3.5 h-3.5" />
        {widget.config.title || 'Contract status'}
      </div>
      <ul className="space-y-1.5 overflow-y-auto">
        {rows.map((r) => {
          const tone = STATUS_TONE[r.status] ?? STATUS_TONE.unmonitored;
          return (
            <li
              key={r.contractId}
              className="flex items-center gap-2 border border-gray-100 rounded-lg px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-gray-900 truncate">
                  {TYPE_LABEL[r.type] ?? r.type} · {r.title}
                </div>
                <div className="text-[11px] text-gray-500 truncate">
                  {r.plantId}
                  {r.counterparty ? ` · ${r.counterparty}` : ''}
                </div>
              </div>
              <span
                className={`shrink-0 text-[11px] border rounded-full px-2 py-0.5 ${tone.cls}`}
              >
                {tone.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
