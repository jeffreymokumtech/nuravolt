'use client';

import { Info } from 'lucide-react';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
  type QualityTone,
} from './constants';

/**
 * SlaBanner, SLA-exposure header for the DQ-Hub "Today" tab.
 *
 * Anchors the operator's eye on three numbers:
 *   1. MTD coverage (big, mono, left), what we have right now
 *   2. Gap-to-contract delta (tone-coded badge), exposure narrative
 *   3. Projected end-of-month (small KPI, right), trajectory
 *
 * Tone ladder (driven by mtdPct vs contractPct):
 *   alarm, mtdPct < contractPct - 1   (already in breach territory)
 *   warn, 0 < gap < 1                 (close to the line, still recoverable)
 *   ok, mtdPct >= contractPct       (comfortable)
 *
 * Pure component. No state, no effects, no network. Light design system
 * (QUALITY_COLORS / QUALITY_TONES) like the rest of the hub.
 */

export interface SlaBannerProps {
  /** Contractual SLA coverage, percent (e.g. 98). */
  contractPct: number;
  /** 'default' when no SLA is configured and the platform default is shown. */
  contractSource?: 'configured' | 'default';
  /** Month-to-date achieved coverage, percent. */
  mtdPct: number;
  /** Projected end-of-month coverage given current trajectory, percent. */
  projectedEomPct: number;
  /** How the projection was derived, e.g. "linear run-rate". */
  projectionMethod?: string;
  /** Calendar days remaining in the current month. */
  daysRemaining: number;
  /** IEC clause backing the contract value, e.g. "IEC 61724-1:2017 §7.1". */
  iecReference: string;
}

function classifyTone(mtdPct: number, contractPct: number): QualityTone {
  const gap = contractPct - mtdPct; // positive => below SLA
  if (gap > 1) return 'alarm';
  if (gap > 0) return 'warn';
  return 'ok';
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function buildBadgeText(
  mtdPct: number,
  contractPct: number,
  daysRemaining: number,
): string {
  const gap = contractPct - mtdPct;
  const absGap = Math.abs(gap).toFixed(1);
  if (gap > 1) {
    return `${absGap}% below SLA, ${daysRemaining} ${
      daysRemaining === 1 ? 'day' : 'days'
    } to recover`;
  }
  if (gap > 0) {
    return `${absGap}% below SLA, within recovery window`;
  }
  if (gap === 0) {
    return 'On contract';
  }
  return `${absGap}% above SLA, comfortable`;
}

export default function SlaBanner({
  contractPct,
  contractSource,
  mtdPct,
  projectedEomPct,
  projectionMethod,
  daysRemaining,
  iecReference,
}: SlaBannerProps) {
  const tone = classifyTone(mtdPct, contractPct);
  const tokens = QUALITY_TONES[tone];
  const badgeText = buildBadgeText(mtdPct, contractPct, daysRemaining);
  const contractNote =
    contractSource === 'default'
      ? `${iecReference} · platform default (no SLA configured for this plant)`
      : iecReference;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-6 rounded-xl border bg-white p-5"
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      {/* Left: MTD big number + tone badge */}
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex flex-col">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            MTD coverage
          </span>
          <span
            className="font-bold leading-none"
            style={{
              fontFamily: QUALITY_MONO,
              fontVariantNumeric: 'tabular-nums',
              fontSize: '2.75rem',
              color: QUALITY_COLORS.text.primary,
              marginTop: '0.35rem',
            }}
          >
            {formatPct(mtdPct)}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span
            className="inline-flex w-fit items-center rounded-md border px-2.5 py-1 text-xs font-semibold"
            style={{
              color: tokens.fg,
              background: tokens.bg,
              borderColor: tokens.border,
            }}
            role="status"
            aria-live="polite"
          >
            {badgeText}
          </span>
          <span
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            <span>Contract</span>
            <span
              className="font-semibold"
              style={{
                fontFamily: QUALITY_MONO,
                color: QUALITY_COLORS.text.primary,
              }}
            >
              {formatPct(contractPct)}
            </span>
            {contractSource === 'default' && (
              <span
                className="rounded border px-1 py-[1px] text-[9.5px] uppercase tracking-wider"
                style={{
                  color: QUALITY_TONES.muted.fg,
                  background: QUALITY_TONES.muted.bg,
                  borderColor: QUALITY_TONES.muted.border,
                }}
              >
                default
              </span>
            )}
            <span
              title={contractNote}
              aria-label={`Reference: ${contractNote}`}
              className="inline-flex cursor-help items-center"
              style={{ color: QUALITY_COLORS.text.muted }}
            >
              <Info className="h-3 w-3" aria-hidden="true" />
            </span>
          </span>
        </div>
      </div>

      {/* Right: Projected EOM KPI */}
      <div className="flex flex-col items-start sm:items-end">
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Projected EOM
        </span>
        <span
          className="font-semibold leading-tight"
          style={{
            fontFamily: QUALITY_MONO,
            fontVariantNumeric: 'tabular-nums',
            fontSize: '1.5rem',
            color: QUALITY_COLORS.text.primary,
            marginTop: '0.2rem',
          }}
        >
          {formatPct(projectedEomPct)}
        </span>
        <span className="text-[11px]" style={{ color: QUALITY_COLORS.text.muted }}>
          {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining
          {projectionMethod ? ` · ${projectionMethod}` : ''}
        </span>
      </div>
    </div>
  );
}
