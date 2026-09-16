'use client';

import { QUALITY_COLORS, QUALITY_MONO, QUALITY_TONES } from './constants';

/**
 * DigestCard, LLM-generated AM briefing surfaced at the top of the DQ Hub.
 *
 * Renders a short narrative summary of overnight data-quality findings, with
 * provenance (model badge + generation timestamp) and a verification footer to
 * keep operators honest about AI output.
 *
 * Visibility rules:
 *   - loading + no digest    → 3-line shimmer skeleton
 *   - empty / null + idle    → renders nothing (don't show an empty container)
 *   - digest present         → full card, whitespace-pre-wrap so bullets render
 */

interface DigestCardProps {
  digest: string | null | undefined;
  loading?: boolean;
  generatedAt?: string;
  model?: string;
}

function formatTimeAgo(iso?: string): string {
  if (!iso) return 'just now';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'just now';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) {
    return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

function formatEyebrowDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // YYYY-MM-DD, operator-friendly, unambiguous, locale-independent.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ShimmerLine({ widthPct }: { widthPct: number }) {
  return (
    <div
      className="relative overflow-hidden rounded"
      style={{
        height: 12,
        width: `${widthPct}%`,
        background: QUALITY_TONES.info.border,
        opacity: 0.5,
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.7) 50%, transparent 100%)',
          animation: 'digestShimmer 1.4s linear infinite',
        }}
      />
      <style jsx>{`
        @keyframes digestShimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(100%);
          }
        }
      `}</style>
    </div>
  );
}

export default function DigestCard({
  digest,
  loading = false,
  generatedAt,
  model,
}: DigestCardProps) {
  const trimmed = typeof digest === 'string' ? digest.trim() : '';
  const hasDigest = trimmed.length > 0;

  // Hide entirely when there's nothing to show and nothing is loading.
  if (!hasDigest && !loading) return null;

  const eyebrowDate = formatEyebrowDate(generatedAt);
  const eyebrowParts = ['AM BRIEFING'];
  if (eyebrowDate) eyebrowParts.push(eyebrowDate);
  const eyebrow = eyebrowParts.join(' · ');

  return (
    <div
      className="rounded-xl border"
      style={{
        background: QUALITY_TONES.info.bg,
        borderColor: QUALITY_TONES.info.border,
        padding: 16,
      }}
    >
      {/* Header row: eyebrow + model badge */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{
            color: QUALITY_TONES.info.fg,
            fontFamily: QUALITY_MONO,
          }}
        >
          {eyebrow}
        </span>
        {model ? (
          <span
            className="shrink-0"
            style={{
              fontFamily: QUALITY_MONO,
              fontSize: 10,
              color: QUALITY_TONES.info.fg,
              opacity: 0.75,
            }}
          >
            AI · {model}
          </span>
        ) : null}
      </div>

      {/* Body */}
      {hasDigest ? (
        <p
          className="whitespace-pre-wrap"
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: QUALITY_COLORS.text.primary,
            margin: 0,
          }}
        >
          {trimmed}
        </p>
      ) : (
        // 3-line shimmer skeleton while we wait for the LLM call.
        <div className="flex flex-col gap-2 py-1" aria-busy="true" aria-live="polite">
          <ShimmerLine widthPct={92} />
          <ShimmerLine widthPct={86} />
          <ShimmerLine widthPct={64} />
        </div>
      )}

      {/* Footer (only render when we actually have a digest) */}
      {hasDigest ? (
        <p
          className="mt-3"
          style={{
            fontSize: 11,
            color: QUALITY_COLORS.text.secondary,
            margin: '12px 0 0 0',
          }}
        >
          Updated {formatTimeAgo(generatedAt)} · AI-generated summary, verify
          against raw signals below.
        </p>
      ) : null}
    </div>
  );
}
