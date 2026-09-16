'use client';

import { useRef, useState } from 'react';
import { Check, FileText, Loader2, Sparkles, Upload } from 'lucide-react';
import {
  VALID_FIELD_TYPES,
  AUTO_CONFIRM_THRESHOLD,
  registerOriginalField,
} from '@/lib/ai/register-map-schema';
import type { ExtractedRegister, RegisterMapResult } from '@/lib/ai/register-map-schema';

/**
 * AI Modbus register-map auto-mapper affordance for the ConnectionWizard's
 * Modbus step. Upload an OEM datasheet PDF or a SCADA register export
 * (CSV/TSV/txt) — POST /api/connections/[id]/register-map extracts and
 * persists the map, and the returned registers render as an editable review
 * table (row-level accept/override PATCHes the FieldMapping).
 *
 * MODBUS_PRESETS stay as fallback seeds: "Prefill from preset" generates
 * rows from the preset's display strings (e.g. "P_AC @30775").
 */

export interface RegisterMapPreset {
  id: string;
  label: string;
  registers: string[];
}

interface Props {
  /** Returns the active connection id, creating the connection if needed. */
  ensureConnectionId: () => Promise<string | null>;
  preset: RegisterMapPreset;
}

interface EditableRow {
  original_field: string;
  address: number;
  name: string;
  dataType: string;
  unit: string;
  scale: number;
  mapped_field: string;
  confidence: number;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
}

interface ExtractionSummary {
  method: string;
  vendor?: string;
  model?: string;
  notes?: string;
  fieldMappingsUpserted?: number;
  unmapped?: number;
  autoConfirmed?: number;
}

// Heuristic guesses for preset display strings like "P_AC @30775"
const PRESET_FIELD_GUESSES: Array<[RegExp, string, number]> = [
  [/^p_?ac\b/i, 'power_ac', 0.9],
  [/^e_?total\b/i, 'energy_total', 0.9],
  [/^v_?dc\b/i, 'voltage_dc', 0.9],
  [/^i_?dc\b/i, 'current_dc', 0.9],
  [/dc\s*power/i, 'power_dc', 0.85],
  [/temp/i, 'temp_inverter', 0.75],
  [/mppt/i, 'voltage_dc', 0.6],
  [/pv\s*strings?/i, 'voltage_dc', 0.6],
];

function guessPresetField(name: string): [string, number] {
  for (const [re, field, confidence] of PRESET_FIELD_GUESSES) {
    if (re.test(name)) return [field, confidence];
  }
  return ['unmapped', 0];
}

/** Parse a preset display string ("P_AC @30775", "MPPT V/I @5011+") into a row. */
function parsePresetRegister(display: string): EditableRow | null {
  const m = display.match(/^(.+?)\s*@\s*(\d+)\+?\s*$/);
  if (!m) return null; // e.g. "SunSpec 40070+" without a concrete signal
  const name = m[1].trim();
  const address = parseInt(m[2], 10);
  const [mapped, confidence] = guessPresetField(name);
  return {
    original_field: registerOriginalField(name),
    address,
    name,
    dataType: 'uint16',
    unit: '',
    scale: 1,
    mapped_field: mapped,
    confidence,
    dirty: true, // preset seeds are unsaved until the user accepts them
    saving: false,
    saved: false,
  };
}

/** Mirror buildRegisterPersistenceRows' key walk so client keys match server keys. */
function toEditableRows(registers: ExtractedRegister[]): EditableRow[] {
  const seen = new Set<string>();
  const rows: EditableRow[] = [];
  for (const reg of registers) {
    let key = registerOriginalField(reg.name);
    if (seen.has(key)) key = `${key}@${reg.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      original_field: key,
      address: reg.address,
      name: reg.name,
      dataType: reg.dataType,
      unit: reg.unit ?? '',
      scale: reg.scale ?? 1,
      mapped_field: reg.mapped_field,
      confidence: reg.confidence,
      dirty: false,
      saving: false,
      saved: reg.mapped_field !== 'unmapped' && reg.confidence >= AUTO_CONFIRM_THRESHOLD,
    });
  }
  return rows;
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const cls =
    value >= AUTO_CONFIRM_THRESHOLD
      ? 'bg-green-100 text-green-700'
      : value >= 0.6
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-600';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {pct}%
    </span>
  );
}

export default function RegisterMapUploader({ ensureConnectionId, preset }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [connId, setConnId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<EditableRow[] | null>(null);
  const [summary, setSummary] = useState<ExtractionSummary | null>(null);

  const resolveConnectionId = async (): Promise<string | null> => {
    if (connId && !connId.startsWith('demo-')) return connId;
    const id = await ensureConnectionId();
    if (!id || id.startsWith('demo-')) {
      setError('Register-map extraction needs a live connection — the API is unavailable in demo mode.');
      return null;
    }
    setConnId(id);
    return id;
  };

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const id = await resolveConnectionId();
      if (!id) return;

      const form = new FormData();
      form.append('file', file);
      if (preset.id && preset.id !== 'generic') form.append('vendor_hint', preset.id);

      const response = await fetch(`/api/connections/${id}/register-map`, {
        method: 'POST',
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Extraction failed');

      const registerMap: RegisterMapResult = data.data.registerMap;
      setRows(toEditableRows(registerMap.registers));
      setSummary({
        method: registerMap.method,
        vendor: registerMap.vendor,
        model: registerMap.model,
        notes: registerMap.notes,
        ...data.data.persistence,
      });
      if (registerMap.registers.length === 0) {
        setError(registerMap.notes || 'No registers found in the uploaded document.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const prefillFromPreset = () => {
    setError(null);
    setSummary(null);
    const seeded = preset.registers
      .map(parsePresetRegister)
      .filter((r): r is EditableRow => r !== null);
    if (seeded.length === 0) {
      setError('This preset has no concrete register addresses to prefill.');
      return;
    }
    setRows(seeded);
  };

  const updateRow = (index: number, patch: Partial<EditableRow>) => {
    setRows(prev =>
      prev
        ? prev.map((r, i) => (i === index ? { ...r, ...patch, dirty: true, saved: false } : r))
        : prev
    );
  };

  const saveRow = async (index: number) => {
    if (!rows) return;
    const row = rows[index];
    setError(null);
    setRows(prev => (prev ? prev.map((r, i) => (i === index ? { ...r, saving: true } : r)) : prev));
    try {
      const id = await resolveConnectionId();
      if (!id) return;
      const response = await fetch(`/api/connections/${id}/register-map`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_field: row.original_field,
          mapped_field: row.mapped_field,
          unit: row.unit || undefined,
          scaling_factor: row.scale,
          field_path: String(row.address),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save mapping');
      setRows(prev =>
        prev
          ? prev.map((r, i) =>
              i === index
                ? { ...r, saving: false, saved: true, dirty: false, confidence: 1.0 }
                : r
            )
          : prev
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mapping');
      setRows(prev =>
        prev ? prev.map((r, i) => (i === index ? { ...r, saving: false } : r)) : prev
      );
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Sparkles className="w-4 h-4 text-blue-600" />
          AI register-map auto-mapper
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Upload the inverter datasheet (PDF) or your SCADA register export (CSV) — registers are
          extracted and mapped to NuraVolt fields automatically. Review below, then accept or
          override each row.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.csv,.tsv,.txt"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading ? 'Extracting…' : 'Upload datasheet or register export'}
        </button>
        {preset.registers.length > 0 && (
          <button
            type="button"
            disabled={uploading}
            onClick={prefillFromPreset}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FileText className="w-4 h-4" />
            Prefill from {preset.label} preset
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}

      {summary && (
        <div className="p-3 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg space-y-0.5">
          <div>
            Extraction method: <span className="font-mono">{summary.method}</span>
            {summary.vendor ? ` · ${summary.vendor}${summary.model ? ` ${summary.model}` : ''}` : ''}
          </div>
          {summary.fieldMappingsUpserted !== undefined && (
            <div>
              {summary.fieldMappingsUpserted} mapping(s) saved · {summary.autoConfirmed ?? 0}{' '}
              auto-confirmed · {summary.unmapped ?? 0} need review
            </div>
          )}
          {summary.notes && <div className="text-blue-600">{summary.notes}</div>}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Address</th>
                <th className="px-2 py-2 text-left font-medium">Name</th>
                <th className="px-2 py-2 text-left font-medium">Type</th>
                <th className="px-2 py-2 text-left font-medium">Unit</th>
                <th className="px-2 py-2 text-left font-medium">Scale</th>
                <th className="px-2 py-2 text-left font-medium">Mapped field</th>
                <th className="px-2 py-2 text-left font-medium">Conf.</th>
                <th className="px-2 py-2 text-left font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row, i) => (
                <tr key={row.original_field} className="bg-white">
                  <td className="px-2 py-1.5 font-mono text-gray-700">{row.address}</td>
                  <td className="px-2 py-1.5 text-gray-800">{row.name}</td>
                  <td className="px-2 py-1.5 font-mono text-gray-500">{row.dataType}</td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.unit}
                      onChange={e => updateRow(i, { unit: e.target.value })}
                      className="w-16 px-1.5 py-1 border border-gray-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="any"
                      value={row.scale}
                      onChange={e => updateRow(i, { scale: parseFloat(e.target.value) || 1 })}
                      className="w-16 px-1.5 py-1 border border-gray-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={row.mapped_field}
                      onChange={e => updateRow(i, { mapped_field: e.target.value })}
                      className="px-1.5 py-1 border border-gray-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {VALID_FIELD_TYPES.map(t => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <ConfidenceBadge value={row.confidence} />
                  </td>
                  <td className="px-2 py-1.5">
                    {row.saved && !row.dirty ? (
                      <span className="inline-flex items-center gap-1 text-green-700">
                        <Check className="w-3.5 h-3.5" /> Saved
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={row.saving || row.mapped_field === ''}
                        onClick={() => saveRow(i)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50"
                      >
                        {row.saving ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Check className="w-3 h-3" />
                        )}
                        {row.dirty ? 'Apply' : 'Accept'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
