'use client';

import { cn } from '@/helpers/utils';
import { useState, type ReactNode } from 'react';
import OpsSparkline from './charts/OpsSparkline';
import type { StatusTone } from './StatusLed';
import { friendlyLabel } from './friendlyLabel';

/**
 * Border-collapsed grid of N telemetry cells. Each cell carries a small
 * label, a large value (mono, font-weight 600), an optional unit and a
 * footer line (delta, baseline, target). Optionally an inline sparkline
 * sits below the value.
 *
 * Each cell can be tonally coloured to flag warn/alarm states without
 * shouting, the value picks up the tone CSS variable but the panel stays
 * neutral.
 */

export interface TelemetryCell {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  footer?: ReactNode;
  /** Tone applied to the VALUE only. Cell chrome stays neutral. */
  tone?: StatusTone | 'neutral';
  /** Sparkline data, array of numbers in [0,1]. */
  sparkline?: number[];
  sparklineTone?: StatusTone;
  /** Optional hover-only tooltip body (e.g. definition + source). */
  tooltip?: ReactNode;
}

const TONE_VAR: Record<StatusTone | 'neutral', string> = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  info: 'var(--ops-info)',
  bess: 'var(--ops-bess)',
  muted: 'var(--ops-muted)',
  neutral: 'var(--ops-bright)',
};

interface TelemetryStripProps {
  cells: TelemetryCell[];
  /** Override the column count; default is cells.length. */
  columns?: number;
  className?: string;
}

export default function TelemetryStrip({
  cells,
  columns,
  className,
}: TelemetryStripProps) {
  const cols = columns ?? cells.length;
  const mobileCols = 2;
  const tabletCols = Math.min(4, cols);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  return (
    <div
      className={cn('grid overflow-hidden rounded-md border', className)}
      style={{
        gridTemplateColumns: `repeat(${mobileCols}, minmax(0, 1fr))`,
        gap: '1px',
        background: 'var(--ops-hair)',
        borderColor: 'var(--ops-hair)',
        ['--strip-tablet-cols' as string]: tabletCols.toString(),
        ['--strip-desktop-cols' as string]: cols.toString(),
      }}
      data-responsive-strip
    >
      {cells.map((cell, i) => {
        const isHover = hoverIdx === i;
        return (
          <div
            key={`${cell.label}-${i}`}
            className="relative flex flex-col justify-between px-3 py-2.5 transition-colors"
            style={{
              background: isHover ? 'var(--ops-panel-2)' : 'var(--ops-panel)',
            }}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            title={typeof cell.tooltip === 'string' ? (cell.tooltip as string) : undefined}
          >
            <div className="ops-eyebrow text-[10px]" style={{ letterSpacing: '0.02em' }}>
              {friendlyLabel(cell.label)}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span
                className="ops-num text-[20px] font-semibold leading-none"
                style={{ color: TONE_VAR[cell.tone ?? 'neutral'] }}
              >
                {cell.value}
              </span>
              {cell.unit && (
                <span className="text-[9.5px]" style={{ color: 'var(--ops-label)' }}>
                  {cell.unit}
                </span>
              )}
            </div>
            {cell.sparkline && (
              <OpsSparkline
                values={cell.sparkline}
                tone={(cell.sparklineTone ?? (cell.tone === 'neutral' ? 'info' : (cell.tone ?? 'info'))) as StatusTone}
                height={20}
                className="mt-1.5"
                interactive={false}
              />
            )}
            {cell.footer && (
              <div className="mt-1 text-[10px]" style={{ color: 'var(--ops-label)' }}>
                {cell.footer}
              </div>
            )}
            {cell.tooltip && isHover && typeof cell.tooltip !== 'string' && (
              <div
                className="pointer-events-none absolute top-full left-2 right-2 z-20 mt-1 rounded-md border px-2 py-1.5 font-mono text-[10px]"
                style={{
                  background: 'var(--ops-panel)',
                  borderColor: 'var(--ops-hair)',
                  color: 'var(--ops-txt)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                }}
              >
                {cell.tooltip}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
