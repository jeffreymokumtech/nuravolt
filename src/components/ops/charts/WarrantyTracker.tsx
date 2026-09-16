'use client';

import { useRef, useState, type ReactNode } from 'react';
import { cn } from '@/helpers/utils';
import OpsTooltip from './OpsTooltip';
import { TONE_VAR } from './chartTheme';

/**
 * Stack of warranty progress bars: capacity guarantee, cycle budget,
 * throughput, calendar age. Each row shows a label/value line followed by
 * a thin progress bar tinted to the row's tone.
 *
 * Interactive: per-row hover highlight + tooltip with the full breakdown
 * (current / limit / headroom).
 */

export interface WarrantyRow {
  label: string;
  /** Right-side value display, e.g. "94.1% / 70% @10yr". */
  value: ReactNode;
  /** Fraction filled [0, 1]. */
  fraction: number;
  /** Bar tone, green if consumed under safety margin, bess otherwise. */
  tone: 'ok' | 'warn' | 'bess' | 'alarm';
  /** Optional tooltip body lines for hover. */
  tooltip?: { label: string; value: string }[];
}

interface WarrantyTrackerProps {
  rows: WarrantyRow[];
  /** Optional projected-breach footer. */
  projectedBreach?: ReactNode;
  className?: string;
}

export default function WarrantyTracker({
  rows,
  projectedBreach,
  className,
}: WarrantyTrackerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const containerW = containerRef.current?.clientWidth ?? 200;
  const hoverRow = hoverIdx != null ? rows[hoverIdx] : null;

  return (
    <div ref={containerRef} className={cn('relative flex flex-col gap-3', className)}>
      {rows.map((row, i) => {
        const isHover = i === hoverIdx;
        return (
          <div
            key={`${row.label}-${i}`}
            className="transition-colors"
            onMouseEnter={(e) => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              setHoverIdx(i);
            }}
            onMouseMove={(e) => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onMouseLeave={() => setHoverIdx(null)}
            style={{
              padding: 2,
              borderRadius: 4,
              background: isHover ? 'var(--ops-row-hair)' : undefined,
            }}
          >
            <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
              <span
                style={{
                  color: isHover ? 'var(--ops-bright)' : 'var(--ops-muted)',
                  fontWeight: isHover ? 600 : undefined,
                }}
              >
                {row.label}
              </span>
              <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                {row.value}
              </span>
            </div>
            <div
              className="h-[7px] overflow-hidden rounded"
              style={{ background: 'var(--ops-row-hair)' }}
            >
              <div
                className="h-full transition-all"
                style={{
                  width: `${Math.max(0, Math.min(1, row.fraction)) * 100}%`,
                  background: TONE_VAR[row.tone],
                  boxShadow: isHover ? '0 0 0 1px var(--ops-bright)' : undefined,
                }}
              />
            </div>
          </div>
        );
      })}
      {projectedBreach && (
        <div
          className="mt-2 flex items-baseline justify-between border-t pt-2 text-[11.5px]"
          style={{ borderColor: 'var(--ops-row-hair)', color: 'var(--ops-muted)' }}
        >
          {projectedBreach}
        </div>
      )}
      {hoverRow?.tooltip && hoverRow.tooltip.length > 0 && (
        <OpsTooltip
          header={hoverRow.label}
          rows={hoverRow.tooltip.map((t, i) => ({
            key: `t-${i}`,
            label: t.label,
            value: t.value,
            tone: hoverRow.tone,
          }))}
          x={pointer.x}
          y={pointer.y}
          containerWidth={containerW}
          width={200}
          top="follow"
        />
      )}
    </div>
  );
}
