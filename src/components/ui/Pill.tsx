'use client';

import { cn } from '@/helpers/utils';

/**
 * The one badge/pill. Replaces the ~12 inline `px-2 py-1 rounded-full ...`
 * patterns scattered across the demo/showcase surfaces.
 *
 * `tone` carries the semantic colour; `variant` picks the silhouette.
 * Domain mappers (tier, cause, ticket status, asset type) live here so
 * pages never hand-pick colours for the same concept differently.
 */

export type PillTone =
  | 'neutral'
  | 'brand'
  | 'positive'
  | 'warning'
  | 'critical'
  | 'violet'
  | 'cyan';

export type PillVariant = 'soft' | 'outline' | 'solid';

const TONE_CLASSES: Record<PillTone, Record<PillVariant, string>> = {
  neutral: {
    soft: 'bg-slate-100 text-slate-700',
    outline: 'border border-slate-200 bg-slate-50 text-slate-700',
    solid: 'bg-slate-600 text-white',
  },
  brand: {
    soft: 'bg-blue-100 text-blue-700',
    outline: 'border border-blue-200 bg-blue-50 text-blue-700',
    solid: 'bg-blue-600 text-white',
  },
  positive: {
    soft: 'bg-emerald-100 text-emerald-700',
    outline: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
    solid: 'bg-emerald-600 text-white',
  },
  warning: {
    soft: 'bg-amber-100 text-amber-700',
    outline: 'border border-amber-200 bg-amber-50 text-amber-700',
    solid: 'bg-amber-500 text-white',
  },
  critical: {
    soft: 'bg-rose-100 text-rose-700',
    outline: 'border border-rose-200 bg-rose-50 text-rose-700',
    solid: 'bg-rose-600 text-white',
  },
  violet: {
    soft: 'bg-violet-100 text-violet-700',
    outline: 'border border-violet-200 bg-violet-50 text-violet-700',
    solid: 'bg-violet-600 text-white',
  },
  cyan: {
    soft: 'bg-cyan-100 text-cyan-700',
    outline: 'border border-cyan-200 bg-cyan-50 text-cyan-700',
    solid: 'bg-cyan-600 text-white',
  },
};

export interface PillProps {
  children: React.ReactNode;
  tone?: PillTone;
  variant?: PillVariant;
  /** sm = table cells, md = headers. */
  size?: 'sm' | 'md';
  uppercase?: boolean;
  className?: string;
  title?: string;
}

export function Pill({
  children,
  tone = 'neutral',
  variant = 'outline',
  size = 'sm',
  uppercase = false,
  className,
  title,
}: PillProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs',
        uppercase && 'uppercase tracking-wide',
        TONE_CLASSES[tone][variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ─── Domain mappers ─────────────────────────────────────────────────────────
// Single source of truth for concept → tone, so a DEGRADED pill looks the
// same in the sidebar, the maintenance table, and the rank chart.

export const TIER_TONE: Record<string, PillTone> = {
  ACUTE: 'critical',
  DEGRADED: 'warning',
  CHRONIC: 'warning',
  NORMAL: 'positive',
};

export const CAUSE_TONE: Record<string, PillTone> = {
  SOILING: 'warning',
  SHADING: 'warning',
  THERMAL: 'critical',
  STRING_DEGRADATION: 'warning',
  BYPASS_DIODE: 'critical',
  INVERTER_DERATE: 'critical',
  NORMAL: 'positive',
};

export const TICKET_STATUS_TONE: Record<string, PillTone> = {
  NEW: 'brand',
  VALIDATED: 'violet',
  ASSIGNED: 'cyan',
  IN_PROGRESS: 'warning',
  DONE: 'positive',
  DISMISSED: 'neutral',
};

export const ASSET_TONE: Record<string, PillTone> = {
  PV: 'brand',
  SOLAR: 'brand',
  BESS: 'violet',
  WIND: 'cyan',
  HYBRID: 'violet',
};

export function TierPill({ tier, className }: { tier: string; className?: string }) {
  return (
    <Pill tone={TIER_TONE[tier] ?? 'neutral'} uppercase className={className}>
      {tier}
    </Pill>
  );
}

export function CausePill({ cause, className }: { cause: string; className?: string }) {
  const label = cause.toLowerCase().replace(/_/g, ' ');
  return (
    <Pill tone={CAUSE_TONE[cause] ?? 'neutral'} className={className}>
      {label}
    </Pill>
  );
}

export default Pill;
