import { cn } from '@/helpers/utils';

/**
 * 7px round LED used everywhere status needs to be signalled, alarm rows,
 * nav items, command-bar brand pulse, footer health, telemetry deltas.
 *
 * Tones map to the five signal CSS variables in ops-theme.scss:
 *   ok    → --ops-ok      green
 *   warn  → --ops-warn    ochre
 *   alarm → --ops-alarm   red
 *   info  → --ops-info    teal
 *   bess  → --ops-bess    violet
 *
 * `pulse` is reserved for true-live signals (heartbeat, brand mark).
 */

export type StatusTone = 'ok' | 'warn' | 'alarm' | 'info' | 'bess' | 'muted';

const TONE_VAR: Record<StatusTone, string> = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  info: 'var(--ops-info)',
  bess: 'var(--ops-bess)',
  muted: 'var(--ops-dim)',
};

interface StatusLedProps {
  tone?: StatusTone;
  size?: number;
  pulse?: boolean;
  className?: string;
}

export default function StatusLed({
  tone = 'ok',
  size = 7,
  pulse = false,
  className,
}: StatusLedProps) {
  return (
    <span
      className={cn('inline-block rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: TONE_VAR[tone],
        animation: pulse ? 'ops-pulse 2s ease-in-out infinite' : undefined,
      }}
    />
  );
}
