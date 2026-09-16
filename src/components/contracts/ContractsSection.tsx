'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import ContractDetail from './ContractDetail';
import ContractUploadDialog from './ContractUploadDialog';
import type { ShapedContract } from '@/lib/contracts/shape';

/**
 * Contracts tab body: contracts on file with obligation health, renewal
 * horizon, per-contract detail (terms + provenance) and the upload/review
 * flow. Reads GET /api/plants/[plantId]/contracts; mutations are enforced
 * server-side (MANAGE) — unauthorized visitors see honest errors.
 */

export interface ObligationRow {
  contract_id: string;
  contract_type: string;
  field: string;
  status: 'ok' | 'at_risk' | 'breach' | 'unmonitored' | 'no_data';
  observed_value: number | null;
  threshold: number | null;
  unit?: string | null;
  window?: string | null;
  detail?: string | null;
}

interface ContractsResponse {
  plantId: string;
  contracts: ShapedContract[];
  obligations: { obligations?: ObligationRow[]; evaluated_at?: string; _generatedAt?: string } | null;
  _source: string;
}

const TYPE_LABEL: Record<string, string> = {
  PPA: 'PPA',
  MODULE_WARRANTY: 'Module warranty',
  INVERTER_WARRANTY: 'Inverter warranty',
  OM_SLA: 'O&M SLA',
  BESS_WARRANTY: 'BESS warranty',
  OTHER: 'Other',
};

const STATUS_TONE: Record<string, { color: string; label: string }> = {
  ok: { color: 'var(--ops-good, #16a34a)', label: 'On track' },
  at_risk: { color: 'var(--ops-warn, #d97706)', label: 'At risk' },
  breach: { color: 'var(--ops-bad, #dc2626)', label: 'Breach' },
  no_data: { color: 'var(--ops-muted)', label: 'No data' },
  unmonitored: { color: 'var(--ops-muted)', label: 'Terms on file' },
};

export function worstObligationStatus(rows: ObligationRow[]): string | null {
  if (!rows.length) return null;
  for (const s of ['breach', 'at_risk', 'ok', 'no_data', 'unmonitored']) {
    if (rows.some((r) => r.status === s)) return s;
  }
  return null;
}

function fmtDay(d: string | null): string {
  return d ?? '—'.replace('—', 'n/a');
}

export default function ContractsSection({ plantId }: { plantId: string }) {
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/plants/${plantId}/contracts`, { cache: 'no-store' });
      if (r.ok) setData(await r.json());
      else setData(null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [plantId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const contracts = data?.contracts ?? [];
  const obligations = data?.obligations?.obligations ?? [];
  const byContract = useMemo(() => {
    const m = new Map<string, ObligationRow[]>();
    for (const o of obligations) {
      const list = m.get(o.contract_id) ?? [];
      list.push(o);
      m.set(o.contract_id, list);
    }
    return m;
  }, [obligations]);

  const selected = contracts.find((c) => c.id === selectedId) ?? null;

  // Renewal horizon: expiries in the next 24 months, soonest first.
  const renewals = useMemo(() => {
    const now = Date.now();
    const horizon = now + 24 * 30.44 * 24 * 3600 * 1000;
    return contracts
      .filter((c) => c.effectiveTo && c.status !== 'ARCHIVED')
      .map((c) => ({ c, t: new Date(c.effectiveTo as string).getTime() }))
      .filter(({ t }) => t > now && t < horizon)
      .sort((a, b) => a.t - b.t);
  }, [contracts]);

  if (loading) {
    return (
      <div className="font-mono text-[11px] p-6" style={{ color: 'var(--ops-muted)' }}>
        Loading contracts…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <OpsPanel
        label="Contracts on file"
        subtitle="Contract terms and live obligation status"
        meta={
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10.5px]"
            style={{
              borderColor: 'var(--ops-hair)',
              borderRadius: 'var(--ops-radius)',
              color: 'var(--ops-txt)',
              background: 'var(--ops-panel-2)',
            }}
          >
            <Upload className="h-3 w-3" />
            Upload contract
          </button>
        }
      >
        {contracts.length === 0 ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--ops-muted)' }}>
            No contracts on file for this plant. Upload a contract to start
            monitoring its obligations.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {contracts.map((c) => {
              const rows = byContract.get(c.id) ?? [];
              const worst = c.status === 'DRAFT' ? null : worstObligationStatus(rows);
              const tone = worst ? STATUS_TONE[worst] : null;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                  className="border px-3 py-2.5 text-left"
                  style={{
                    background: c.id === selectedId ? 'var(--ops-panel-2)' : 'var(--ops-panel)',
                    borderColor: c.id === selectedId ? 'var(--ops-muted)' : 'var(--ops-hair)',
                    borderRadius: 'var(--ops-radius)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="ops-eyebrow">{TYPE_LABEL[c.contractType] ?? c.contractType}</span>
                    {c.status === 'DRAFT' ? (
                      <span
                        className="rounded-sm border px-1.5 py-px font-mono text-[10px]"
                        style={{ borderColor: 'var(--ops-warn, #d97706)', color: 'var(--ops-warn, #d97706)' }}
                      >
                        Review needed
                      </span>
                    ) : tone ? (
                      <span
                        className="rounded-sm border px-1.5 py-px font-mono text-[10px]"
                        style={{ borderColor: tone.color, color: tone.color }}
                      >
                        {tone.label}
                      </span>
                    ) : (
                      <span className="font-mono text-[10px]" style={{ color: 'var(--ops-muted)' }}>
                        Terms on file
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-1 flex items-center gap-1.5 text-[12.5px] font-medium"
                    style={{ color: 'var(--ops-txt)' }}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ops-muted)' }} />
                    {c.title}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
                    {c.counterparty ?? 'Counterparty not recorded'}
                    <span className="mx-1.5" style={{ color: 'var(--ops-dim)' }}>·</span>
                    {fmtDay(c.effectiveFrom)} → {fmtDay(c.effectiveTo)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </OpsPanel>

      {renewals.length > 0 && (
        <OpsPanel label="Renewal horizon" subtitle="Expiries in the next 24 months">
          <div className="space-y-1.5">
            {renewals.map(({ c, t }) => {
              const months = Math.max(0, Math.round((t - Date.now()) / (30.44 * 24 * 3600 * 1000)));
              return (
                <div key={c.id} className="flex items-center justify-between font-mono text-[11px]">
                  <span style={{ color: 'var(--ops-txt)' }}>
                    {TYPE_LABEL[c.contractType] ?? c.contractType} · {c.title}
                  </span>
                  <span style={{ color: months <= 6 ? 'var(--ops-warn, #d97706)' : 'var(--ops-muted)' }}>
                    {c.effectiveTo} ({months} mo)
                  </span>
                </div>
              );
            })}
          </div>
        </OpsPanel>
      )}

      {selected && (
        <ContractDetail
          plantId={plantId}
          contract={selected}
          obligations={byContract.get(selected.id) ?? []}
          onChanged={refresh}
        />
      )}

      {uploadOpen && (
        <ContractUploadDialog
          plantId={plantId}
          onClose={() => setUploadOpen(false)}
          onUploaded={(id) => {
            setUploadOpen(false);
            setSelectedId(id);
            refresh();
          }}
        />
      )}
    </div>
  );
}
