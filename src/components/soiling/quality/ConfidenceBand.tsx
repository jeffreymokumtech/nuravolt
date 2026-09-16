'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
  type QualityTone,
} from './constants';

interface ConfidenceBandProps {
  label: string;
  nominal: number;
  bandLo: number;
  bandHi: number;
  unit?: string;
  degradedInputsPct?: number;
  precision?: number;
  /** Methodology note shown in the info tooltip. Pass the per-KPI reference
   *  from the payload when one exists; the default is a generic note, not a
   *  citation. */
  reference?: string;
}

const DEFAULT_REFERENCE =
  'Uncertainty band around the nominal KPI value; the band widens with the share of degraded inputs feeding this KPI.';

function formatValue(value: number, precision: number): string {
  if (!Number.isFinite(value)) return ',';
  return value.toFixed(precision);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function ConfidenceBand({
  label,
  nominal,
  bandLo,
  bandHi,
  unit,
  degradedInputsPct = 0,
  precision,
  reference = DEFAULT_REFERENCE,
}: ConfidenceBandProps) {
  const [tipOpen, setTipOpen] = useState(false);

  const resolvedPrecision =
    typeof precision === 'number'
      ? precision
      : Math.abs(nominal) < 10
        ? 3
        : 1;

  // Tone selection: alarm > warn > ok based on degraded inputs %
  const tone: QualityTone =
    degradedInputsPct > 15 ? 'alarm' : degradedInputsPct > 5 ? 'warn' : 'info';
  const tokens = QUALITY_TONES[tone];

  const halfWidth = Math.max(0, bandHi - nominal);
  const bandRange = bandHi - bandLo;
  const nominalPctRaw = bandRange > 0 ? (nominal - bandLo) / bandRange : 0.5;
  const nominalPct = clamp01(nominalPctRaw) * 100;

  const nominalText = formatValue(nominal, resolvedPrecision);
  const halfText = formatValue(halfWidth, resolvedPrecision);
  const loText = formatValue(bandLo, resolvedPrecision);
  const hiText = formatValue(bandHi, resolvedPrecision);
  const unitSuffix = unit ? ` ${unit}` : '';

  return (
    <div
      className="rounded-lg border bg-white p-3"
      style={{
        borderColor: QUALITY_COLORS.border.DEFAULT,
        fontFamily: QUALITY_MONO,
      }}
    >
      {/* Header row: label + info icon */}
      <div className="flex items-center justify-between gap-2">
        <div
          className="text-[10.5px] uppercase tracking-wider"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          {label}
        </div>

        <div className="relative flex items-center">
          {degradedInputsPct > 0 && (
            <span
              className="mr-2 rounded-sm border px-1.5 py-[1px] text-[9.5px] uppercase tracking-wider"
              style={{
                color: tokens.fg,
                background: tokens.bg,
                borderColor: tokens.border,
              }}
            >
              {`${degradedInputsPct.toFixed(0)}% degraded`}
            </span>
          )}

          <button
            type="button"
            aria-label="Confidence band reference"
            onMouseEnter={() => setTipOpen(true)}
            onMouseLeave={() => setTipOpen(false)}
            onFocus={() => setTipOpen(true)}
            onBlur={() => setTipOpen(false)}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full"
            style={{ color: QUALITY_COLORS.text.muted }}
          >
            <Info className="h-3.5 w-3.5" />
          </button>

          {tipOpen && (
            <div
              role="tooltip"
              className="absolute right-0 top-5 z-20 w-64 rounded-md border bg-white p-2 text-[10.5px] leading-snug shadow-md"
              style={{
                borderColor: QUALITY_COLORS.border.DEFAULT,
                color: QUALITY_COLORS.text.primary,
                fontFamily: QUALITY_MONO,
              }}
            >
              {reference}
            </div>
          )}
        </div>
      </div>

      {/* Value row: nominal left, ± band right */}
      <div className="mt-1.5 flex items-baseline gap-3">
        <div
          className="text-[22px] leading-none"
          style={{ color: QUALITY_COLORS.text.primary, fontVariantNumeric: 'tabular-nums' }}
        >
          {nominalText}
          {unit && (
            <span className="ml-1 text-[11px]" style={{ color: QUALITY_COLORS.text.muted }}>
              {unit}
            </span>
          )}
        </div>
        <div className="text-[11px]" style={{ color: QUALITY_COLORS.text.secondary }}>
          {`± ${halfText}${unitSuffix}`}
        </div>
      </div>

      {/* Sparkline band: bandLo at 0%, bandHi at 100%, nominal tick */}
      <div className="mt-2.5">
        <div
          className="relative h-1.5 w-full overflow-hidden rounded-sm"
          style={{
            background: tokens.bg,
            border: `1px solid ${tokens.border}`,
          }}
        >
          <div
            className="absolute bottom-[-2px] top-[-2px] w-[2px]"
            style={{
              left: `calc(${nominalPct}% - 1px)`,
              background: tokens.fg,
            }}
            aria-hidden="true"
          />
        </div>

        <div
          className="mt-1 flex justify-between text-[9.5px]"
          style={{ color: QUALITY_COLORS.text.muted }}
        >
          <span>{`${loText}${unitSuffix}`}</span>
          <span>{`${hiText}${unitSuffix}`}</span>
        </div>
      </div>
    </div>
  );
}

export default ConfidenceBand;
