'use client';

import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/helpers/utils';
import { AnimatedCounter } from '@/components/ui/AnimatedKpiCard';

/**
 * The one KPI card. Supersedes AnimatedKpiCard, SimpleKpiCard, and the
 * per-page local variants (BessSection KPICard, PlantCard bare divs).
 *
 * Default look: white card, subtle top accent in the tone colour, optional
 * icon chip, the calm style. `variant="gradient"` keeps the louder
 * gradient fill for hero positions (page-top KPI bands on landing surfaces).
 *
 * Migration note: pages move onto this component during their page-pass in
 * the overhaul; the legacy components remain until all call sites are gone.
 */

export type KpiTone =
  | 'brand'    // blue, neutral metric
  | 'positive' // emerald, good news
  | 'warning'  // amber, needs attention
  | 'critical' // rose, bad news
  | 'violet'   // BESS accent
  | 'cyan'     // wind accent
  | 'slate';   // de-emphasised

/** Asset-type → kpi tone map. Used by `assetType` shortcut prop. */
export type AssetTypeForKpi = 'SOLAR' | 'WIND' | 'BESS';
const ASSET_TONE_MAP: Record<AssetTypeForKpi, KpiTone> = {
  SOLAR: 'brand',
  WIND: 'cyan',
  BESS: 'violet',
};

interface ToneClasses {
  accent: string;       // top border accent
  iconBg: string;
  iconColor: string;
  gradient: string;     // for variant="gradient"
  gradientBorder: string;
  gradientValue: string;
}

const TONES: Record<KpiTone, ToneClasses> = {
  brand: {
    accent: 'border-t-blue-500',
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    gradient: 'from-blue-100 to-blue-50',
    gradientBorder: 'border-blue-200',
    gradientValue: 'text-blue-700',
  },
  positive: {
    accent: 'border-t-emerald-500',
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
    gradient: 'from-emerald-100 to-emerald-50',
    gradientBorder: 'border-emerald-200',
    gradientValue: 'text-emerald-700',
  },
  warning: {
    accent: 'border-t-amber-500',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    gradient: 'from-amber-100 to-amber-50',
    gradientBorder: 'border-amber-200',
    gradientValue: 'text-amber-700',
  },
  critical: {
    accent: 'border-t-rose-500',
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    gradient: 'from-rose-100 to-rose-50',
    gradientBorder: 'border-rose-200',
    gradientValue: 'text-rose-700',
  },
  violet: {
    accent: 'border-t-violet-500',
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-600',
    gradient: 'from-violet-100 to-violet-50',
    gradientBorder: 'border-violet-200',
    gradientValue: 'text-violet-700',
  },
  cyan: {
    accent: 'border-t-cyan-500',
    iconBg: 'bg-cyan-50',
    iconColor: 'text-cyan-600',
    gradient: 'from-cyan-100 to-cyan-50',
    gradientBorder: 'border-cyan-200',
    gradientValue: 'text-cyan-700',
  },
  slate: {
    accent: 'border-t-slate-400',
    iconBg: 'bg-slate-50',
    iconColor: 'text-slate-600',
    gradient: 'from-slate-100 to-slate-50',
    gradientBorder: 'border-slate-200',
    gradientValue: 'text-slate-700',
  },
};

function parseValue(value: string | number): {
  numericValue: number;
  prefix: string;
  suffix: string;
  decimals: number;
} {
  if (typeof value === 'number') {
    return { numericValue: value, prefix: '', suffix: '', decimals: 0 };
  }
  const str = String(value);
  const match = str.match(/^([€$£¥]?)([0-9.]+)\s*(.*)$/);
  if (match) {
    const prefix = match[1] || '';
    const numStr = match[2].replace(/,/g, '');
    const suffix = match[3] || '';
    const numericValue = parseFloat(numStr) || 0;
    const decimals = numStr.includes('.') ? (numStr.split('.')[1]?.length || 0) : 0;
    return {
      numericValue,
      prefix,
      suffix: suffix ? ` ${suffix}`.trimStart() : '',
      decimals,
    };
  }
  return { numericValue: 0, prefix: '', suffix: str, decimals: 0 };
}

export interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  tone?: KpiTone;
  icon?: LucideIcon;
  /** Stagger index for the entrance animation. */
  index?: number;
  /** Animate the number counting up. Default false (calmer). */
  animated?: boolean;
  /** "plain" (default, white + top accent) or "gradient" (hero band). */
  variant?: 'plain' | 'gradient';
  /**
   * Shortcut for plant/asset context, when set, overrides `tone` to the
   * matching asset-accent (PV=blue, Wind=cyan, BESS=violet). Lets a parent
   * page colour every KPI by the plant's `asset_type` without per-card
   * tone wiring.
   */
  assetType?: AssetTypeForKpi;
  className?: string;
}

export default function KpiCard({
  title,
  value,
  subtitle,
  tone = 'brand',
  icon: Icon,
  index = 0,
  animated = false,
  variant = 'plain',
  assetType,
  className,
}: KpiCardProps) {
  const effectiveTone: KpiTone = assetType ? ASSET_TONE_MAP[assetType] : tone;
  const t = TONES[effectiveTone] ?? TONES.brand;
  const parsed = parseValue(value);

  const valueNode =
    animated && parsed.numericValue !== 0 ? (
      <AnimatedCounter
        value={parsed.numericValue}
        decimals={parsed.decimals}
        prefix={parsed.prefix}
        suffix={parsed.suffix}
      />
    ) : (
      value
    );

  if (variant === 'gradient') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
        className={cn(
          'rounded-xl border p-5 shadow-sm bg-gradient-to-br',
          t.gradient,
          t.gradientBorder,
          className,
        )}
      >
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-2">
          {title}
        </div>
        <div className={cn('mt-2 text-3xl font-bold', t.gradientValue)}>{valueNode}</div>
        {subtitle && <div className="mt-1 text-xs text-ink-3">{subtitle}</div>}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05, ease: 'easeOut' }}
      className={cn(
        'relative overflow-hidden rounded-xl border border-divider border-t-2 bg-white p-5 shadow-sm transition-shadow hover:shadow-md',
        t.accent,
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
            {title}
          </div>
          <div className="text-2xl font-bold tracking-tight text-ink">{valueNode}</div>
        </div>
        {Icon && (
          <div className={cn('shrink-0 rounded-lg p-2', t.iconBg, t.iconColor)}>
            <Icon className="h-5 w-5" />
          </div>
        )}
      </div>
      {subtitle && <div className="mt-2 text-xs text-ink-3">{subtitle}</div>}
    </motion.div>
  );
}
