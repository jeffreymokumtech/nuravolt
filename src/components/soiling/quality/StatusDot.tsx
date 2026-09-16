'use client';

import { QUALITY_TONE_DOT, type QualityTone } from './constants';

/**
 * StatusDot — light-system severity LED for the DQ hub (equivalent of the
 * ops StatusLed). `pulse` for attention-demanding states.
 */

interface StatusDotProps {
  tone: QualityTone;
  size?: number;
  pulse?: boolean;
}

export default function StatusDot({ tone, size = 8, pulse = false }: StatusDotProps) {
  const color = QUALITY_TONE_DOT[tone];
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-full w-full rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
