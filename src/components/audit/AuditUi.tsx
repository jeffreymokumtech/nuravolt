'use client';

import type { ReactNode } from 'react';

/**
 * Small shared building blocks for the Audit surface. Light "paper" design
 * language matching the PlantPageChrome pages (white cards, hairline
 * dividers), with the BESS violet as the section accent.
 */

export function fmtEur(v: number, digits = 0): string {
  return `€${v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtNum(v: number, digits = 1): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

/** Amber "Specimen data" pill, mirrors the showcase "Sample Data" chip. */
export function SpecimenChip() {
  return (
    <span className="inline-flex items-center rounded-full border border-signal-warning/30 bg-signal-warning/10 px-2 py-0.5 text-[11px] font-medium text-signal-warning whitespace-nowrap">
      Specimen data
    </span>
  );
}

/** Page-level header for an audit section. `live` suppresses the specimen
 * chip — set it when the bundle came from the weekly artifact job rather
 * than the committed static specimens. */
export function AuditPageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  live = false,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
  live?: boolean;
}) {
  return (
    <div className="rounded-xl border border-divider bg-white p-4 shadow-sm md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-asset-bess">
              {eyebrow}
            </span>
            {!live && <SpecimenChip />}
          </div>
          <h1 className="text-xl font-bold text-ink md:text-2xl">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">{subtitle}</p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** White card with an optional mono header row. */
export function AuditCard({
  title,
  meta,
  children,
  className = '',
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-divider bg-white p-4 shadow-sm md:p-6 ${className}`}>
      {(title || meta) && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {meta && <div className="font-mono text-[11px] text-ink-3">{meta}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export type KpiTone = 'neutral' | 'positive' | 'warning' | 'negative' | 'bess';

const KPI_TONE: Record<KpiTone, string> = {
  neutral: 'text-ink',
  positive: 'text-signal-positive',
  warning: 'text-signal-warning',
  negative: 'text-red-600',
  bess: 'text-asset-bess',
};

/** Headline KPI stat used on the audit overview and section summaries. */
export function KpiStat({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: KpiTone;
}) {
  return (
    <div className="rounded-xl border border-divider bg-white p-4 shadow-sm md:p-5">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1.5 text-2xl font-bold tabular-nums ${KPI_TONE[tone]}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

/** Severity chip for the violations register. */
export function SeverityChip({ severity }: { severity: string }) {
  const isCritical = severity.toLowerCase() === 'critical';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        isCritical
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-amber-200 bg-amber-50 text-amber-700'
      }`}
    >
      {severity}
    </span>
  );
}
