import { cn } from '@/helpers/utils';

/**
 * Small mono pill that says "LIVE" with a pulsing LED. Used on panels with
 * real-time data (digital twin, BESS.live, dispatch).
 */
interface LiveBadgeProps {
  label?: string;
  tone?: 'ok' | 'info' | 'warn' | 'alarm';
  className?: string;
}

const TONE_VAR: Record<NonNullable<LiveBadgeProps['tone']>, { fg: string; bg: string; border: string }> = {
  ok: { fg: 'var(--ops-ok)', bg: 'var(--ops-ok-bg)', border: 'var(--ops-ok-border)' },
  info: { fg: 'var(--ops-info)', bg: 'var(--ops-info-bg)', border: 'var(--ops-info-border)' },
  warn: { fg: 'var(--ops-warn)', bg: 'var(--ops-warn-bg)', border: 'var(--ops-warn-border)' },
  alarm: { fg: 'var(--ops-alarm)', bg: 'var(--ops-alarm-bg)', border: 'var(--ops-alarm-border)' },
};

export default function LiveBadge({ label = 'LIVE', tone = 'ok', className }: LiveBadgeProps) {
  const t = TONE_VAR[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-px font-mono text-[10px] font-medium tracking-wider',
        className
      )}
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.border}` }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: t.fg, animation: 'ops-pulse 2s ease-in-out infinite' }}
      />
      {label}
    </span>
  );
}
