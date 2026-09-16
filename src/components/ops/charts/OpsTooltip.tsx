'use client';

import type { CSSProperties } from 'react';
import type { StatusTone } from '../StatusLed';
import { TONE_VAR } from './chartTheme';

export interface OpsTooltipRow {
  key: string;
  label: string;
  value: string;
  tone?: StatusTone;
}

interface OpsTooltipProps {
  header?: string;
  rows: OpsTooltipRow[];
  /** Pointer X in container coords (used for auto-flip). */
  x: number;
  /** Pointer Y in container coords. When `top === 'follow'`, used for vertical placement. */
  y?: number;
  /** Container width, needed for right-edge flip. */
  containerWidth: number;
  width?: number;
  /** `8` = pinned to top of panel; `'follow'` = follows the cursor; number = explicit. */
  top?: number | 'follow';
  className?: string;
}

/**
 * Standardised hover tooltip used by every interactive chart. Sans labels
 * with mono data numerals (.ops-num), hairline border, panel-tone bg + soft
 * shadow, auto-flip on the right edge so the panel never escapes the chart
 * container.
 */
export default function OpsTooltip({
  header,
  rows,
  x,
  y,
  containerWidth,
  width = 180,
  top = 8,
  className,
}: OpsTooltipProps) {
  if (rows.length === 0) return null;

  const left = Math.min(Math.max(0, x + 12), containerWidth - width - 4);
  const resolvedTop = top === 'follow' ? Math.max(8, (y ?? 0) - 8) : top;

  const style: CSSProperties = {
    top: resolvedTop,
    left,
    width,
    background: 'var(--ops-panel)',
    borderColor: 'var(--ops-hair)',
    color: 'var(--ops-txt)',
    padding: '7px 10px',
    fontSize: 11,
    fontFamily: 'var(--ops-font-sans)',
    boxShadow: 'var(--ops-shadow)',
  };

  return (
    <div
      className={`pointer-events-none absolute z-10 rounded-lg border ${className ?? ''}`}
      style={style}
    >
      {header && (
        <div
          className="mb-1 text-[10px]"
          style={{ color: 'var(--ops-label)' }}
        >
          {header}
        </div>
      )}
      <div className="space-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              {row.tone && (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: TONE_VAR[row.tone] }}
                />
              )}
              <span style={{ color: 'var(--ops-muted)' }}>{row.label}</span>
            </span>
            <span className="ops-num" style={{ color: 'var(--ops-bright)' }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
