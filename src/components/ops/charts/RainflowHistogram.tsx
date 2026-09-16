'use client';

import { useRef, useState } from 'react';
import { cn } from '@/helpers/utils';
import OpsTooltip from './OpsTooltip';

/**
 * Rainflow DoD histogram for BESS cycle-depth distribution. Vertical bars
 * sized by count, labelled with the DoD bucket centre. Bess violet.
 *
 * Interactive: per-bar hover highlight + tooltip with DoD bucket, count,
 * and optional stress-weighted contribution.
 */

export interface RainflowBar {
  /** DoD bucket label, e.g. "8%", "14%", "22%" */
  label: string;
  /** Cycle count for this bucket. */
  count: number;
  /** Optional stress-weighted cycle equivalent. */
  stressWeighted?: number;
}

interface RainflowHistogramProps {
  bars: RainflowBar[];
  height?: number;
  className?: string;
}

export default function RainflowHistogram({
  bars,
  height = 130,
  className,
}: RainflowHistogramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const maxCount = Math.max(...bars.map((b) => b.count), 1);
  const totalCycles = bars.reduce((s, b) => s + b.count, 0);

  const containerW = containerRef.current?.clientWidth ?? 200;
  const hoverBar = hoverIdx != null ? bars[hoverIdx] : null;

  return (
    <div ref={containerRef} className={cn('relative flex flex-col gap-2', className)}>
      <div className="flex items-end gap-2.5" style={{ height, paddingInline: 4 }}>
        {bars.map((bar, i) => {
          const pct = bar.count / maxCount;
          const isHover = i === hoverIdx;
          return (
            <div
              key={`${bar.label}-${i}`}
              className="flex-1 rounded transition-all"
              style={{
                height: `${Math.max(pct * 100, 4)}%`,
                background: 'var(--ops-bess)',
                opacity: isHover ? 1 : hoverIdx == null ? 0.9 : 0.45,
                transform: isHover ? 'translateY(-2px)' : undefined,
                boxShadow: isHover ? '0 0 0 1px var(--ops-bright)' : undefined,
                cursor: 'default',
              }}
              onMouseEnter={(e) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (rect) {
                  setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }
                setHoverIdx(i);
              }}
              onMouseMove={(e) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (rect) {
                  setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }
              }}
              onMouseLeave={() => setHoverIdx(null)}
            />
          );
        })}
      </div>
      <div
        className="flex gap-2.5 px-1 text-[10px]"
        style={{ color: 'var(--ops-label)', fontVariantNumeric: 'tabular-nums' }}
      >
        {bars.map((bar, i) => (
          <span
            key={`l-${bar.label}-${i}`}
            className="flex-1 text-center transition-colors"
            style={{
              color: i === hoverIdx ? 'var(--ops-bright)' : undefined,
              fontWeight: i === hoverIdx ? 600 : undefined,
            }}
          >
            {bar.label}
          </span>
        ))}
      </div>
      {hoverBar && (
        <OpsTooltip
          header={`DoD ${hoverBar.label}`}
          rows={[
            { key: 'count', label: 'cycles', value: hoverBar.count.toString(), tone: 'bess' },
            {
              key: 'share',
              label: 'fleet share',
              value: `${((hoverBar.count / totalCycles) * 100).toFixed(1)}%`,
              tone: 'muted',
            },
            ...(hoverBar.stressWeighted != null
              ? [
                  {
                    key: 'stress',
                    label: 'stress-weighted',
                    value: hoverBar.stressWeighted.toFixed(1),
                    tone: 'warn' as const,
                  },
                ]
              : []),
          ]}
          x={pointer.x}
          y={pointer.y}
          containerWidth={containerW}
          width={170}
          top="follow"
        />
      )}
    </div>
  );
}
