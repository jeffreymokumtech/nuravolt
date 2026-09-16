'use client';

import { type LucideIcon } from 'lucide-react';
import { QUALITY_COLORS } from './constants';

interface MetricTileProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  subtext?: string;
  trend?: {
    direction: 'up' | 'down' | 'stable';
    value: string;
  };
  status?: 'excellent' | 'good' | 'fair' | 'poor' | 'neutral';
  className?: string;
}

export default function MetricTile({
  icon: Icon,
  label,
  value,
  subtext,
  trend,
  status = 'neutral',
  className = '',
}: MetricTileProps) {
  const statusColor = status === 'neutral'
    ? QUALITY_COLORS.primary.DEFAULT
    : QUALITY_COLORS.status[status];

  const trendColor = trend?.direction === 'up'
    ? QUALITY_COLORS.status.excellent
    : trend?.direction === 'down'
      ? QUALITY_COLORS.status.poor
      : QUALITY_COLORS.text.secondary;

  return (
    <div
      className={`
        bg-white rounded-lg border p-4
        hover:shadow-sm transition-shadow
        ${className}
      `}
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      <div className="flex items-start gap-3">
        <div
          className="p-2 rounded-lg"
          style={{ backgroundColor: `${statusColor}15` }}
        >
          <Icon className="w-5 h-5" style={{ color: statusColor }} />
        </div>

        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium truncate"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            {label}
          </p>

          <div className="flex items-baseline gap-2 mt-1">
            <p
              className="text-2xl font-bold"
              style={{ color: QUALITY_COLORS.text.primary }}
            >
              {value}
            </p>

            {trend && (
              <span
                className="text-sm font-medium"
                style={{ color: trendColor }}
              >
                {trend.direction === 'up' ? '+' : trend.direction === 'down' ? '' : ''}
                {trend.value}
              </span>
            )}
          </div>

          {subtext && (
            <p
              className="text-xs mt-1"
              style={{ color: QUALITY_COLORS.text.muted }}
            >
              {subtext}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact version for inline display
export function MetricBadge({
  label,
  value,
  status = 'neutral',
  className = '',
}: {
  label: string;
  value: string | number;
  status?: 'excellent' | 'good' | 'fair' | 'poor' | 'neutral';
  className?: string;
}) {
  const bgColor = status === 'neutral'
    ? QUALITY_COLORS.background.section
    : `${QUALITY_COLORS.status[status]}15`;

  const textColor = status === 'neutral'
    ? QUALITY_COLORS.text.primary
    : QUALITY_COLORS.status[status];

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ${className}`}
      style={{ backgroundColor: bgColor }}
    >
      <span
        className="text-xs font-medium"
        style={{ color: QUALITY_COLORS.text.secondary }}
      >
        {label}:
      </span>
      <span
        className="text-sm font-bold"
        style={{ color: textColor }}
      >
        {value}
      </span>
    </div>
  );
}
