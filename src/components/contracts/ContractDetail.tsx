'use client';

import { useMemo, useState } from 'react';
import { Download, Quote, Trash2 } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import type { ShapedContract, ShapedContractTerm } from '@/lib/contracts/shape';
import type { ObligationRow } from './ContractsSection';

const TYPE_LABEL: Record<string, string> = {
  PPA: 'PPA',
  MODULE_WARRANTY: 'Module warranty',
  INVERTER_WARRANTY: 'Inverter warranty',
  OM_SLA: 'O&M SLA',
  BESS_WARRANTY: 'BESS warranty',
  OTHER: 'Other',
};

/**
 * Contract detail: term table with extraction provenance (confidence chip +
 * verbatim source excerpt), live obligation rows, and — for DRAFT contracts —
 * the review flow (confirm/reject/edit each extracted term). Human edits
 * drop the extraction provenance server-side; the UI mirrors that honesty.
 */

const STATUS_TONE: Record<string, { color: string; label: string }> = {
  ok: { color: 'var(--ops-good, #16a34a)', label: 'On track' },
  at_risk: { color: 'var(--ops-warn, #d97706)', label: 'At risk' },
  breach: { color: 'var(--ops-bad, #dc2626)', label: 'Breach' },
  no_data: { color: 'var(--ops-muted)', label: 'No data' },
  unmonitored: { color: 'var(--ops-muted)', label: 'Terms on file' },
};

interface ReviewState {
  status: 'CONFIRMED' | 'REJECTED';
  value: string; // numeric input as string; empty = keep
}

export default function ContractDetail({
  plantId,
  contract,
  obligations,
  onChanged,
}: {
  plantId: string;
  contract: ShapedContract;
  obligations: ObligationRow[];
  onChanged: () => void;
}) {
  const isDraft = contract.status === 'DRAFT';
  const [review, setReview] = useState<Record<string, ReviewState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excerptFor, setExcerptFor] = useState<string | null>(null);

  const obligationByField = useMemo(() => {
    const m = new Map<string, ObligationRow>();
    for (const o of obligations) m.set(o.field, o);
    return m;
  }, [obligations]);

  const reviewFor = (t: ShapedContractTerm): ReviewState =>
    review[t.field] ?? { status: t.status === 'REJECTED' ? 'REJECTED' : 'CONFIRMED', value: '' };

  const submitReview = async () => {
    setBusy(true);
    setError(null);
    try {
      const terms = contract.terms.map((t) => {
        const r = reviewFor(t);
        const edited = r.value.trim() !== '' && Number.isFinite(Number(r.value));
        return {
          field: t.field,
          status: r.status,
          ...(edited ? { value_numeric: Number(r.value) } : {}),
        };
      });
      const res = await fetch(`/api/plants/${plantId}/contracts/${contract.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Confirm failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this contract and its terms?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/plants/${plantId}/contracts/${contract.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpsPanel
      label={`Contract · ${TYPE_LABEL[contract.contractType] ?? contract.contractType}`}
      subtitle={contract.title}
      meta={
        <span className="inline-flex items-center gap-2">
          {contract.hasSourceDocument && (
            <a
              href={`/api/plants/${plantId}/contracts/${contract.id}/document`}
              className="inline-flex items-center gap-1 border px-1.5 py-0.5"
              style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)', color: 'var(--ops-txt)' }}
            >
              <Download className="h-3 w-3" />
              Source PDF
            </a>
          )}
          <button
            onClick={remove}
            disabled={busy}
            title="Delete contract"
            className="inline-flex items-center gap-1 border px-1.5 py-0.5"
            style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)', color: 'var(--ops-muted)' }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      }
      footerMeta={
        <span>
          {contract.counterparty ?? 'Counterparty not recorded'}
          <span className="mx-1.5">·</span>
          {contract.extractionModel
            ? `Terms extracted by ${contract.extractionModel}, human-reviewed`
            : 'Terms entered from records — source document not uploaded'}
        </span>
      }
    >
      {!isDraft && obligations.length > 0 && (
        <div className="mb-3 space-y-1">
          {obligations.map((o) => {
            const tone = STATUS_TONE[o.status] ?? STATUS_TONE.unmonitored;
            return (
              <div
                key={o.field}
                className="flex flex-wrap items-center justify-between gap-x-3 border-b pb-1 font-mono text-[11px]"
                style={{ borderColor: 'var(--ops-row-hair)' }}
              >
                <span style={{ color: 'var(--ops-txt)' }}>
                  <span
                    className="mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ background: tone.color }}
                  />
                  {o.detail ?? o.field}
                </span>
                <span style={{ color: tone.color }}>{tone.label}</span>
              </div>
            );
          })}
        </div>
      )}

      <table className="w-full border-collapse">
        <thead>
          <tr
            className="border-b text-left font-mono text-[10px] uppercase"
            style={{ borderColor: 'var(--ops-hair)', color: 'var(--ops-muted)' }}
          >
            <th className="py-1.5 pr-2 font-normal">Term</th>
            <th className="py-1.5 pr-2 font-normal">Value</th>
            <th className="py-1.5 pr-2 font-normal">Provenance</th>
            {isDraft && <th className="py-1.5 font-normal">Review</th>}
          </tr>
        </thead>
        <tbody>
          {contract.terms.map((t) => {
            const r = reviewFor(t);
            const obligation = obligationByField.get(t.field);
            const rejected = !isDraft && t.status === 'REJECTED';
            return (
              <tr
                key={t.id}
                className="border-b align-top"
                style={{
                  borderColor: 'var(--ops-row-hair)',
                  opacity: rejected || (isDraft && r.status === 'REJECTED') ? 0.45 : 1,
                }}
              >
                <td className="py-1.5 pr-2 text-[12px]" style={{ color: 'var(--ops-txt)' }}>
                  {t.label}
                  {obligation && !isDraft && (
                    <span
                      className="ml-1.5 font-mono text-[9.5px]"
                      style={{ color: (STATUS_TONE[obligation.status] ?? STATUS_TONE.unmonitored).color }}
                    >
                      ●
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2 font-mono text-[11.5px]" style={{ color: 'var(--ops-bright)' }}>
                  {isDraft && t.valueNumeric != null ? (
                    <input
                      type="number"
                      step="any"
                      defaultValue={t.valueNumeric}
                      onChange={(e) =>
                        setReview((prev) => ({
                          ...prev,
                          [t.field]: { ...reviewFor(t), value: e.target.value },
                        }))
                      }
                      className="w-24 border bg-transparent px-1 py-0.5 font-mono text-[11.5px]"
                      style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)' }}
                    />
                  ) : (
                    (t.valueNumeric ?? t.valueText ?? '—')
                  )}
                  {t.unit && <span style={{ color: 'var(--ops-muted)' }}> {t.unit}</span>}
                </td>
                <td className="py-1.5 pr-2 font-mono text-[10px]" style={{ color: 'var(--ops-muted)' }}>
                  {t.confidence != null ? (
                    <span className="inline-flex items-center gap-1.5">
                      conf {Math.round(t.confidence * 100)}%
                      {t.sourceExcerpt && (
                        <button
                          onClick={() => setExcerptFor(excerptFor === t.id ? null : t.id)}
                          title="Show source excerpt"
                          className="inline-flex items-center"
                          style={{ color: 'var(--ops-txt)' }}
                        >
                          <Quote className="h-3 w-3" />
                        </button>
                      )}
                      {!t.isExplicit && <span title="Derived, not stated verbatim">derived</span>}
                    </span>
                  ) : (
                    'entered manually'
                  )}
                  {excerptFor === t.id && t.sourceExcerpt && (
                    <div
                      className="mt-1 max-w-md border px-2 py-1.5 font-mono text-[10px] italic"
                      style={{
                        borderColor: 'var(--ops-hair)',
                        borderRadius: 'var(--ops-radius)',
                        background: 'var(--ops-panel-2)',
                        color: 'var(--ops-txt)',
                      }}
                    >
                      &ldquo;{t.sourceExcerpt}&rdquo;
                    </div>
                  )}
                </td>
                {isDraft && (
                  <td className="py-1.5 font-mono text-[10px]">
                    <div className="inline-flex overflow-hidden border" style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)' }}>
                      {(['CONFIRMED', 'REJECTED'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() =>
                            setReview((prev) => ({ ...prev, [t.field]: { ...reviewFor(t), status: s } }))
                          }
                          className="px-1.5 py-0.5"
                          style={{
                            background: r.status === s ? 'var(--ops-panel-2)' : 'transparent',
                            color:
                              r.status === s
                                ? s === 'CONFIRMED'
                                  ? 'var(--ops-good, #16a34a)'
                                  : 'var(--ops-bad, #dc2626)'
                                : 'var(--ops-muted)',
                          }}
                        >
                          {s === 'CONFIRMED' ? 'Confirm' : 'Reject'}
                        </button>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
          {contract.terms.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-center text-[12px]" style={{ color: 'var(--ops-muted)' }}>
                No terms were extracted from this document.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {isDraft && (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11.5px]" style={{ color: 'var(--ops-muted)' }}>
            Review each extracted term. Edited values lose their extraction
            provenance. Confirming activates monitoring for supported terms.
          </span>
          <button
            onClick={submitReview}
            disabled={busy}
            className="border px-3 py-1.5 font-mono text-[11px]"
            style={{
              borderColor: 'var(--ops-good, #16a34a)',
              borderRadius: 'var(--ops-radius)',
              color: 'var(--ops-good, #16a34a)',
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? 'Confirming…' : 'Confirm contract'}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-2 font-mono text-[11px]" style={{ color: 'var(--ops-bad, #dc2626)' }}>
          {error === 'Unauthorized' || error.includes('401')
            ? 'Sign in with MANAGE access to review contracts.'
            : error}
        </div>
      )}
    </OpsPanel>
  );
}
