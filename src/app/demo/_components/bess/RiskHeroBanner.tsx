'use client';

import type { StatusTone } from '@/components/ops/StatusLed';
import StatusLed from '@/components/ops/StatusLed';

/**
 * Risk-tier hero banner, thin signal-toned strip at the top of the Battery
 * Overview that summarises the worst operational indicator at a glance.
 *
 * Twaice-style: operator should never have to scroll to find "how risky is
 * this asset right now?".
 */

export interface RiskIndicator {
  /** Short uppercase label, e.g. "WARRANTY", "CYCLE". */
  label: string;
  /** Value display, e.g. "87%", "64%". */
  value: string;
  /**
   * Tone derived from the indicator's healthiness. `muted` is for an
   * indicator with no measurement behind it: an unmeasured axis rendered in
   * the ok green is the console asserting health it cannot see, and it also
   * drags the banner's overall tier towards NOMINAL.
   */
  tone: 'ok' | 'warn' | 'alarm' | 'muted';
}

/** The banner's own tone. It has no `muted`: the strip is always drawn. */
export type BannerTone = 'ok' | 'warn' | 'alarm';

interface RiskHeroBannerProps {
  /** Overall risk tier label, e.g. "NOMINAL", "WATCH", "ALERT". */
  tier: string;
  /** Banner tone, usually keyed to worst indicator. */
  tone: BannerTone;
  indicators: RiskIndicator[];
  /** Optional summary on the right edge, e.g. asset id + chemistry. */
  summary?: React.ReactNode;
}

const TONE_BG: Record<BannerTone, string> = {
  ok: 'var(--ops-ok-bg)',
  warn: 'var(--ops-warn-bg)',
  alarm: 'var(--ops-alarm-bg)',
};

const TONE_BORDER: Record<BannerTone, string> = {
  ok: 'var(--ops-ok-border)',
  warn: 'var(--ops-warn-border)',
  alarm: 'var(--ops-alarm-border)',
};

const TONE_FG: Record<BannerTone, string> = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
};

const INDICATOR_TONE_VAR: Record<RiskIndicator['tone'], string> = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  muted: 'var(--ops-muted)',
};

const INDICATOR_LED: Record<BannerTone, StatusTone> = {
  ok: 'ok',
  warn: 'warn',
  alarm: 'alarm',
};

/**
 * Overall banner tone from the indicator set. Worst tone wins; a `muted`
 * indicator carries no health claim in either direction, so it neither raises
 * nor lowers the tier. A banner with nothing measured is not NOMINAL.
 */
export function bannerTone(indicators: RiskIndicator[]): {
  tone: BannerTone;
  tier: string;
} {
  if (indicators.some((i) => i.tone === 'alarm')) return { tone: 'alarm', tier: 'ALERT' };
  if (indicators.some((i) => i.tone === 'warn')) return { tone: 'warn', tier: 'WATCH' };
  if (indicators.some((i) => i.tone === 'ok')) return { tone: 'ok', tier: 'NOMINAL' };
  return { tone: 'warn', tier: 'NOT SCORED' };
}

export default function RiskHeroBanner({
  tier,
  tone,
  indicators,
  summary,
}: RiskHeroBannerProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border px-3 py-2 font-mono"
      style={{
        background: TONE_BG[tone],
        borderColor: TONE_BORDER[tone],
        color: TONE_FG[tone],
      }}
    >
      <span className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wider">
        <StatusLed tone={INDICATOR_LED[tone]} size={8} pulse={tone !== 'ok'} />
        [{tier}]
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        {indicators.map((ind) => (
          <span key={ind.label} className="inline-flex items-baseline gap-1.5">
            <span style={{ color: 'var(--ops-label)' }}>{ind.label}</span>
            <span
              className="ops-num"
              style={{ color: INDICATOR_TONE_VAR[ind.tone], fontWeight: 600 }}
            >
              {ind.value}
            </span>
          </span>
        ))}
      </div>
      {summary && (
        <div
          className="ml-auto text-right text-[10.5px]"
          style={{ color: 'var(--ops-muted)' }}
        >
          {summary}
        </div>
      )}
    </div>
  );
}
