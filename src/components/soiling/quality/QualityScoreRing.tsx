'use client';

import { useMemo } from 'react';
import { QUALITY_COLORS, getQualityClass, getQualityLabel } from './constants';

interface QualityScoreRingProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

const SIZE_CONFIG = {
  sm: { width: 80, strokeWidth: 6, fontSize: 'text-lg', labelSize: 'text-xs' },
  md: { width: 120, strokeWidth: 8, fontSize: 'text-2xl', labelSize: 'text-sm' },
  lg: { width: 160, strokeWidth: 10, fontSize: 'text-4xl', labelSize: 'text-base' },
} as const;

export default function QualityScoreRing({
  score,
  size = 'md',
  showLabel = true,
  className = '',
}: QualityScoreRingProps) {
  const config = SIZE_CONFIG[size];
  const radius = (config.width - config.strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const qualityClass = getQualityClass(score);
  const qualityLabel = getQualityLabel(qualityClass);
  const color = QUALITY_COLORS.status[qualityClass];

  // Calculate stroke offset for progress
  const progress = Math.min(100, Math.max(0, score));
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  // Background track color
  const trackColor = QUALITY_COLORS.border.DEFAULT;

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: config.width, height: config.width }}>
        <svg
          width={config.width}
          height={config.width}
          viewBox={`0 0 ${config.width} ${config.width}`}
          className="transform -rotate-90"
        >
          {/* Background track */}
          <circle
            cx={config.width / 2}
            cy={config.width / 2}
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth={config.strokeWidth}
          />
          {/* Progress arc */}
          <circle
            cx={config.width / 2}
            cy={config.width / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={config.strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-500 ease-out"
          />
        </svg>

        {/* Score text in center */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-bold ${config.fontSize}`} style={{ color }}>
            {Math.round(score)}
          </span>
          {showLabel && (
            <span
              className={`${config.labelSize} font-medium`}
              style={{ color }}
            >
              {qualityLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact version for sensor cards
export function QualityScoreBadge({
  score,
  className = ''
}: {
  score: number;
  className?: string;
}) {
  const qualityClass = getQualityClass(score);
  const qualityLabel = getQualityLabel(qualityClass);
  const color = QUALITY_COLORS.status[qualityClass];

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-white text-sm font-medium ${className}`}
      style={{ backgroundColor: color }}
    >
      <span>{Math.round(score)}</span>
      <span className="text-white/80">|</span>
      <span>{qualityLabel}</span>
    </div>
  );
}
