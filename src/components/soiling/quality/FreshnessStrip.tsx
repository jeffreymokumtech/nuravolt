'use client';

import StatusDot from './StatusDot';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  type QualityTone,
} from './constants';
import type { QualityFreshnessSummary } from '@/hooks/useQualityToday';

/**
 * FreshnessStrip — the stream-freshness census of the daily snapshot.
 * The /quality/today payload has always carried these buckets; this strip
 * finally renders them: how many streams are reporting, and how stale the
 * laggards are.
 *
 * Bucket labels reflect the live compute thresholds (fresh < 1.5 h; then
 * < 6 h, < 24 h, ≥ 24 h). Hand-authored fixtures use tighter buckets, which
 * still satisfy these upper bounds.
 */

interface FreshnessStripProps {
  summary: QualityFreshnessSummary;
}

interface Bucket {
  key: keyof QualityFreshnessSummary;
  label: string;
  tone: QualityTone;
}

const BUCKETS: Bucket[] = [
  { key: 'fresh', label: 'Fresh', tone: 'ok' },
  { key: 'stale_under_1h', label: 'Stale · under 6 h', tone: 'info' },
  { key: 'stale_under_24h', label: 'Stale · under 24 h', tone: 'warn' },
  { key: 'stale_over_24h', label: 'Stale · over 24 h', tone: 'alarm' },
];

export default function FreshnessStrip({ summary }: FreshnessStripProps) {
  if (!summary || summary.total_streams === 0) return null;

  return (
    <div
      className="flex flex-wrap items-stretch gap-px overflow-hidden rounded-xl border bg-white"
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
      role="group"
      aria-label="Stream freshness summary"
    >
      <div className="flex min-w-[130px] flex-1 flex-col justify-center px-4 py-3">
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          Streams reporting
        </span>
        <span
          className="text-xl font-bold leading-tight"
          style={{
            fontFamily: QUALITY_MONO,
            fontVariantNumeric: 'tabular-nums',
            color: QUALITY_COLORS.text.primary,
          }}
        >
          {summary.total_streams}
        </span>
      </div>
      {BUCKETS.map((b) => {
        const value = summary[b.key];
        const isZero = value === 0;
        return (
          <div
            key={b.key}
            className="flex min-w-[130px] flex-1 flex-col justify-center border-l px-4 py-3"
            style={{ borderColor: QUALITY_COLORS.border.light }}
          >
            <span
              className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: QUALITY_COLORS.text.secondary }}
            >
              <StatusDot tone={isZero ? 'muted' : b.tone} size={7} />
              {b.label}
            </span>
            <span
              className="text-xl font-bold leading-tight"
              style={{
                fontFamily: QUALITY_MONO,
                fontVariantNumeric: 'tabular-nums',
                color: isZero ? QUALITY_COLORS.text.muted : QUALITY_COLORS.text.primary,
              }}
            >
              {value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
