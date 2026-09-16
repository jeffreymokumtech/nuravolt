'use client';

import { Satellite } from 'lucide-react';
import { QUALITY_COLORS } from './constants';

interface SatelliteFallbackBannerProps {
  active: boolean;
  fallbackSource: string;
  substitutingFor: string;
  ghiConfidenceBandPct: number;
  engagedAt: string;
}

function formatTimeAgo(engagedAt: string): string {
  const engagedDate = new Date(engagedAt);
  const now = new Date();
  const diffMs = now.getTime() - engagedDate.getTime();

  if (Number.isNaN(diffMs) || diffMs < 0) {
    return 'recently';
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0 && minutes <= 0) {
    return 'just now';
  }

  if (hours <= 0) {
    return `${minutes}m ago`;
  }

  if (minutes <= 0) {
    return `${hours}h ago`;
  }

  return `${hours}h ${minutes}m ago`;
}

export default function SatelliteFallbackBanner({
  active,
  fallbackSource,
  substitutingFor,
  ghiConfidenceBandPct,
  engagedAt,
}: SatelliteFallbackBannerProps) {
  if (!active) return null;

  const timeAgo = formatTimeAgo(engagedAt);
  const infoColor = QUALITY_COLORS.primary.DEFAULT;
  const infoBg = QUALITY_COLORS.primary.light;
  const infoBorder = `${infoColor}40`;

  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg border font-mono text-xs"
      style={{
        backgroundColor: infoBg,
        borderColor: infoBorder,
        color: QUALITY_COLORS.text.primary,
      }}
      role="status"
      aria-live="polite"
    >
      <Satellite
        className="w-4 h-4 flex-shrink-0"
        style={{ color: infoColor }}
        aria-hidden="true"
      />
      <span
        className="font-semibold flex-shrink-0"
        style={{ color: QUALITY_COLORS.primary.dark }}
      >
        GHI fallback active
      </span>
      <span
        className="truncate"
        style={{ color: QUALITY_COLORS.text.secondary }}
      >
        On-site {substitutingFor} stale since {timeAgo}; substituting {fallbackSource} (confidence &plusmn;{ghiConfidenceBandPct}%).
      </span>
    </div>
  );
}
