'use client';

import { useRef, useState } from 'react';
import { cn } from '@/helpers/utils';
import type { StatusTone } from '../StatusLed';
import OpsTooltip, { type OpsTooltipRow } from './OpsTooltip';
import { TONE_VAR } from './chartTheme';

/**
 * SVG ring for a 0-100 health score. The arc fills clockwise; the tone is
 * keyed off the score so red below 50, warn 50-75, ok 75+.
 *
 * Interactive: hover shows a tooltip with the score breakdown if `breakdown`
 * rows are provided.
 */

interface HealthRingProps {
  /** 0-100 */
  score: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Optional override tone, defaults to deriving from score. */
  tone?: StatusTone;
  /** Optional centre subtitle (e.g. "health"). */
  subtitle?: string;
  /** Optional breakdown rows shown in the hover tooltip. */
  breakdown?: OpsTooltipRow[];
}

function autoTone(score: number): StatusTone {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'warn';
  if (score >= 0) return 'alarm';
  return 'muted';
}

export default function HealthRing({
  score,
  size = 84,
  strokeWidth = 7,
  className,
  tone,
  subtitle,
  breakdown,
}: HealthRingProps) {
  const safe = Math.max(0, Math.min(100, score));
  const stroke = TONE_VAR[tone ?? autoTone(safe)];
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const dashLength = (safe / 100) * c;

  const containerW = containerRef.current?.clientWidth ?? size;

  return (
    <div
      ref={containerRef}
      className={cn('inline-flex flex-col items-center justify-center relative', className)}
      onMouseEnter={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        setHovering(true);
      }}
      onMouseMove={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ops-row-hair)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dashLength} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 200ms ease-out' }}
          />
        </svg>
        <div
          className="absolute inset-0 flex flex-col items-center justify-center"
          style={{ color: 'var(--ops-bright)' }}
        >
          <span
            className="ops-num text-[20px] font-semibold leading-none transition-transform"
            style={{ transform: hovering ? 'scale(1.05)' : undefined }}
          >
            {Math.round(safe)}
          </span>
          {subtitle && (
            <span
              className="mt-0.5 text-[9px] tracking-[0.02em]"
              style={{ color: 'var(--ops-label)' }}
            >
              {subtitle}
            </span>
          )}
        </div>
      </div>
      {hovering && breakdown && breakdown.length > 0 && (
        <OpsTooltip
          header={`Health · ${Math.round(safe)}/100`}
          rows={breakdown}
          x={pointer.x}
          y={pointer.y}
          containerWidth={Math.max(containerW, 200)}
          width={200}
          top="follow"
        />
      )}
    </div>
  );
}
