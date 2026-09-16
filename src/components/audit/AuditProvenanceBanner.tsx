'use client';

import type { AuditProvenance } from './useAuditData';

/**
 * Provenance notice above the audit sections.
 *
 * Two regimes, because one blanket "provisional" label misdescribes a mixed
 * asset. A battery that ran on the modelled dispatch twin until its BMS was
 * connected has real measured history after the cutover, and saying otherwise
 * undersells evidence the operator actually owns.
 *
 *   modelled  no telemetry connection, the twin owns the whole history
 *   measured  telemetry owns the history
 *   mixed     measured from a date, modelled before it
 *
 * The regime is written by nuravolt/pipeline/bess_measured.py onto
 * BessAsset.metadata.telemetry as {mode, first_measured_date, source}. It
 * arrives here either as the `telemetry` prop or, when a publisher folds it
 * into the artifact, on `provenance.telemetry`.
 */

/** BessAsset.metadata.telemetry, snake_case as written, camelCase as served. */
export interface BessTelemetryRegime {
  mode?: string | null;
  first_measured_date?: string | null;
  firstMeasuredDate?: string | null;
  source?: string | null;
}

type ProvenanceWithTelemetry = AuditProvenance & {
  telemetry?: BessTelemetryRegime | null;
};

export interface RegimeNotice {
  tone: 'warn' | 'info';
  text: string;
}

/** Normalize either spelling of the cutover date to YYYY-MM-DD, or null. */
export function firstMeasuredDate(regime: BessTelemetryRegime | null | undefined): string | null {
  const raw = regime?.first_measured_date ?? regime?.firstMeasuredDate ?? null;
  if (!raw || typeof raw !== 'string') return null;
  const date = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * What the banner should say, from the regime and the audit provenance.
 *
 * Returns null when there is nothing to disclose: a measured asset with no
 * provisional flag needs no banner at all, and a banner that always fires
 * stops being read.
 */
export function regimeNotice(
  provenance: ProvenanceWithTelemetry | null | undefined,
  telemetry?: BessTelemetryRegime | null,
): RegimeNotice | null {
  const regime = telemetry ?? provenance?.telemetry ?? null;
  const mode = regime?.mode?.trim().toLowerCase() ?? null;
  const source = regime?.source?.trim() || null;
  const from = firstMeasuredDate(regime);

  // A mixed asset is described by its cutover, not by its worst half. Without a
  // cutover date "mixed" is not a claim we can make, so it falls through to the
  // modelled wording, which is the conservative reading.
  if (mode === 'mixed' && from) {
    return {
      tone: 'info',
      text:
        `Measured telemetry${source ? ` from ${source}` : ''} from ${from}. ` +
        'Everything before that date is the modelled dispatch twin over real ' +
        'day-ahead prices. Capacity tests and warranty terms are database records.',
    };
  }

  if (mode === 'measured') {
    return {
      tone: 'info',
      text:
        `Operating profile is measured telemetry${source ? ` from ${source}` : ''}. ` +
        'Capacity tests and warranty terms are database records.',
    };
  }

  if (mode === 'modelled' || provenance?.provisional) {
    return {
      tone: 'warn',
      text:
        'Operating profile is a modelled twin over real day-ahead prices, no BMS ' +
        'telemetry connected. Capacity tests and warranty terms are database ' +
        'records; results are a strategy benchmark, not measured hardware behaviour.',
    };
  }

  return null;
}

export default function AuditProvenanceBanner({
  provenance,
  telemetry,
}: {
  provenance: AuditProvenance | null;
  /** BessAsset.metadata.telemetry, when the caller has it in hand. */
  telemetry?: BessTelemetryRegime | null;
}) {
  const notice = regimeNotice(provenance as ProvenanceWithTelemetry | null, telemetry);
  if (!notice) return null;

  const warn = notice.tone === 'warn';
  return (
    <div
      className="mb-4 rounded-lg border px-4 py-2.5 text-[12.5px]"
      style={{
        background: warn ? 'var(--ops-warn-bg, #fffbeb)' : 'var(--ops-info-bg, #eff6ff)',
        borderColor: warn ? 'var(--ops-warn-border, #fde68a)' : 'var(--ops-info-border, #bfdbfe)',
        color: 'var(--ops-ink-soft, #475569)',
      }}
    >
      {notice.text}
    </div>
  );
}
