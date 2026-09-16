import { ReactNode } from 'react';
import { cn } from '@/helpers/utils';
import { motion } from 'framer-motion';

type Signal = 'positive' | 'warning' | 'critical' | 'neutral';
type Size = 'sm' | 'md' | 'lg';
type Tone = 'paper' | 'data';

interface KPIReadoutProps {
  value: ReactNode;
  label: ReactNode;
  delta?: ReactNode;
  signal?: Signal;
  size?: Size;
  tone?: Tone;
  align?: 'left' | 'center';
  className?: string;
  delay?: number;
}

const valueClass: Record<Size, string> = {
  sm: 'text-xl',
  md: 'text-2xl',
  lg: 'text-4xl',
};

const labelClass: Record<Size, string> = {
  sm: 'text-[11px]',
  md: 'text-meta',
  lg: 'text-meta',
};

const labelToneClass: Record<Tone, string> = {
  paper: 'text-ink-3',
  data: 'text-data-fg-2',
};

const valueToneClass: Record<Tone, string> = {
  paper: 'text-ink',
  data: 'text-data-fg',
};

const signalClass: Record<Signal, string> = {
  positive: 'text-signal-positive',
  warning: 'text-signal-warning',
  critical: 'text-signal-critical',
  neutral: '',
};

/**
 * The only on-system way to render a KPI on the marketing surface.
 * Mono numerics, meta-cased labels, optional delta and signal state.
 */
export function KPIReadout({
  value,
  label,
  delta,
  signal = 'neutral',
  size = 'md',
  tone = 'paper',
  align = 'left',
  className,
  delay = 0,
}: KPIReadoutProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
      className={cn(align === 'center' ? 'text-center' : 'text-left', className)}
    >
      <div
        className={cn(
          // `kpi-value` is a styling hook: ops-theme.scss remaps the neutral
          // ink tones to theme-aware ops text inside .ops-canvas (the
          // marketing ink tokens don't flip with the ops dark theme).
          'kpi-value font-mono font-semibold tabular-nums tracking-tight',
          valueClass[size],
          signal === 'neutral' ? valueToneClass[tone] : signalClass[signal],
        )}
      >
        {value}
        {delta ? (
          <span
            className={cn(
              'ml-2 font-normal',
              signal === 'neutral' ? labelToneClass[tone] : signalClass[signal],
              size === 'lg' ? 'text-base' : 'text-xs',
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          // `kpi-label` is a styling hook: ops-theme.scss softens these labels
          // (no uppercase, tighter tracking) inside .ops-canvas only, so the
          // marketing default below stays untouched.
          'kpi-label mt-1 font-sans uppercase tracking-[0.08em]',
          labelClass[size],
          labelToneClass[tone],
        )}
      >
        {label}
      </div>
    </motion.div>
  );
}

export default KPIReadout;
