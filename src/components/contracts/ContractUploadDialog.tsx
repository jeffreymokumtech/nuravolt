'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Contract upload: PDF + type (+ BESS asset when applicable). POSTs to the
 * plant contracts route; on success hands the created DRAFT contract id back
 * so the parent can open the review flow immediately.
 */

const TYPES: Array<{ value: string; label: string }> = [
  { value: 'PPA', label: 'Power purchase agreement' },
  { value: 'MODULE_WARRANTY', label: 'Module performance warranty' },
  { value: 'INVERTER_WARRANTY', label: 'Inverter warranty' },
  { value: 'OM_SLA', label: 'O&M service level agreement' },
  { value: 'BESS_WARRANTY', label: 'Battery warranty' },
  { value: 'OTHER', label: 'Other contract' },
];

interface BessAssetOption {
  id: string;
  name: string | null;
}

export default function ContractUploadDialog({
  plantId,
  onClose,
  onUploaded,
}: {
  plantId: string;
  onClose: () => void;
  onUploaded: (contractId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [contractType, setContractType] = useState('PPA');
  const [title, setTitle] = useState('');
  const [bessAssets, setBessAssets] = useState<BessAssetOption[]>([]);
  const [bessAssetId, setBessAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (contractType !== 'BESS_WARRANTY') return;
    fetch(`/api/bess/plants/${plantId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const assets: BessAssetOption[] = Array.isArray(d?.assets) ? d.assets : [];
        setBessAssets(assets);
        if (assets.length === 1) setBessAssetId(assets[0].id);
      })
      .catch(() => setBessAssets([]));
  }, [contractType, plantId]);

  const submit = async () => {
    if (!file) {
      setError('Choose a PDF file first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('contract_type', contractType);
      if (title.trim()) form.append('title', title.trim());
      if (contractType === 'BESS_WARRANTY' && bessAssetId) {
        form.append('bess_asset_id', bessAssetId);
      }
      const res = await fetch(`/api/plants/${plantId}/contracts`, {
        method: 'POST',
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422) {
          throw new Error('This PDF has no machine-readable text (likely a scan). OCR is not supported yet.');
        }
        if (res.status === 409) {
          throw new Error('This document is already on file for this plant.');
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error('Sign in with MANAGE access to upload contracts.');
        }
        throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`);
      }
      onUploaded(body.contract.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md border p-4"
        style={{
          background: 'var(--ops-panel)',
          borderColor: 'var(--ops-hair)',
          borderRadius: 'var(--ops-radius)',
          boxShadow: 'var(--ops-shadow)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="ops-eyebrow">Upload contract</span>
          <button onClick={onClose} style={{ color: 'var(--ops-muted)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 text-[12.5px]" style={{ color: 'var(--ops-txt)' }}>
          <div>
            <label className="mb-1 block font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
              Contract PDF (max 25 MB, text-based)
            </label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full font-mono text-[11px]"
            />
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
              Contract type
            </label>
            <select
              value={contractType}
              onChange={(e) => setContractType(e.target.value)}
              className="w-full border bg-transparent px-2 py-1.5 text-[12px]"
              style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)' }}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {contractType === 'BESS_WARRANTY' && (
            <div>
              <label className="mb-1 block font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
                Battery asset (confirmed terms sync to its warranty tracker)
              </label>
              <select
                value={bessAssetId}
                onChange={(e) => setBessAssetId(e.target.value)}
                className="w-full border bg-transparent px-2 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)' }}
              >
                <option value="">Not linked to an asset</option>
                {bessAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name ?? a.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 block font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
              Title (optional, defaults to the file name)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border bg-transparent px-2 py-1.5 text-[12px]"
              style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)' }}
            />
          </div>

          {error && (
            <div className="font-mono text-[11px]" style={{ color: 'var(--ops-bad, #dc2626)' }}>
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="border px-3 py-1.5 font-mono text-[11px]"
              style={{ borderColor: 'var(--ops-hair)', borderRadius: 'var(--ops-radius)', color: 'var(--ops-muted)' }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !file}
              className="border px-3 py-1.5 font-mono text-[11px]"
              style={{
                borderColor: 'var(--ops-txt)',
                borderRadius: 'var(--ops-radius)',
                color: 'var(--ops-txt)',
                opacity: busy || !file ? 0.5 : 1,
              }}
            >
              {busy ? 'Extracting terms…' : 'Upload and extract'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
