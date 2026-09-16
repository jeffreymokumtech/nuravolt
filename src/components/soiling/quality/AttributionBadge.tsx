'use client';

import { QUALITY_COLORS } from './constants';

// ============================================================
// Types
// ============================================================

export type AttributionTone = 'warn' | 'info' | 'alarm' | 'muted';

export interface AttributionInfo {
  label: string;
  tooltip: string;
  tone: AttributionTone;
}

interface AttributionBadgeProps {
  cause: string;
  label?: string;
  tooltip?: string;
}

// ============================================================
// Cause -> (label, tooltip, tone) map
// rules.json is documentation; this is the source of truth for UI.
// ============================================================

export const ATTRIBUTION_INFO: Record<string, AttributionInfo> = {
  network_outage: {
    label: 'Network outage',
    tooltip:
      'Multiple co-located streams went stale within ±5 minutes, likely upstream gateway',
    tone: 'warn',
  },
  sensor_drift: {
    label: 'Sensor drift',
    tooltip: 'Distribution shifted vs cohort over a multi-day window',
    tone: 'info',
  },
  inverter_trip: {
    label: 'Inverter trip',
    tooltip: 'Stream gap aligns with a fault event within ±5 minutes',
    tone: 'alarm',
  },
  met_station_shadow: {
    label: 'Pyrano occlusion',
    tooltip:
      'Pyranometer occluded at consistent hour-of-day ≥5 consecutive mornings',
    tone: 'warn',
  },
  dustiq_firmware_quirk: {
    label: 'DustIQ pre-v22000',
    tooltip:
      'Needs ×2 dust-slope correction (Heimsath 2019). Auto-applied upstream.',
    tone: 'info',
  },
  // The live DB compute path emits exactly this cause for any stream whose
  // freshness gap crossed the threshold — without it every live degraded
  // stream fell through to the generic "Needs review" badge.
  stale_stream: {
    label: 'Stale stream',
    tooltip:
      'No fresh samples past the freshness threshold — check the connector/poller for this stream',
    tone: 'warn',
  },
  unknown: {
    label: 'Needs review',
    tooltip: 'No rule matched, manual investigation',
    tone: 'muted',
  },
};

// ============================================================
// Tone -> color mapping (uses existing QUALITY_COLORS tokens)
// ============================================================

const TONE_COLORS: Record<AttributionTone, { fg: string; bg: string; border: string }> = {
  warn: {
    fg: QUALITY_COLORS.status.fair,
    bg: `${QUALITY_COLORS.status.fair}15`,
    border: `${QUALITY_COLORS.status.fair}40`,
  },
  info: {
    fg: QUALITY_COLORS.status.good,
    bg: `${QUALITY_COLORS.status.good}15`,
    border: `${QUALITY_COLORS.status.good}40`,
  },
  alarm: {
    fg: QUALITY_COLORS.status.poor,
    bg: `${QUALITY_COLORS.status.poor}15`,
    border: `${QUALITY_COLORS.status.poor}40`,
  },
  muted: {
    fg: QUALITY_COLORS.text.secondary,
    bg: QUALITY_COLORS.background.section,
    border: QUALITY_COLORS.border.DEFAULT,
  },
};

// ============================================================
// Component
// ============================================================

export default function AttributionBadge({
  cause,
  label,
  tooltip,
}: AttributionBadgeProps) {
  const info = ATTRIBUTION_INFO[cause] ?? ATTRIBUTION_INFO.unknown;
  const resolvedLabel = label ?? info.label;
  const resolvedTooltip = tooltip ?? info.tooltip;
  const colors = TONE_COLORS[info.tone];

  return (
    <span
      className="relative inline-flex items-center group"
      // Native title as a no-JS fallback for users on touch devices or
      // when the CSS hover popover is suppressed by a parent.
      title={resolvedTooltip}
    >
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap cursor-help"
        style={{
          color: colors.fg,
          backgroundColor: colors.bg,
          borderColor: colors.border,
        }}
      >
        {resolvedLabel}
      </span>

      {/* Tiny CSS hover popover. No external tooltip library. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 hidden group-hover:block"
      >
        <span
          className="block px-2 py-1.5 rounded-md shadow-md text-[11px] leading-snug font-mono"
          style={{
            maxWidth: '280px',
            width: 'max-content',
            color: '#FFFFFF',
            backgroundColor: QUALITY_COLORS.text.primary,
          }}
        >
          {resolvedTooltip}
        </span>
      </span>
    </span>
  );
}
