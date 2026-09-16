'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import type { StatusTone } from '../StatusLed';
import OpsTooltip, { type OpsTooltipRow } from './OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE, TONE_VAR, areaGradient } from './chartTheme';

/**
 * Lightweight multi-series line chart. Inline SVG, no Recharts dep.
 *
 * Two design constraints from the source:
 *   - Lines share a single y-axis (otherwise expected/actual can cross
 *     misleadingly, the design explicitly fixes this bug).
 *   - Hairline grid + a soft gradient fill under solid series only: the fill
 *     is what visually separates measured data from dashed projections.
 *
 * Interactive: pointer crosshair + per-series tooltip (via shared
 * useChartHover + OpsTooltip primitives). Snap to nearest x index;
 * tooltip auto-flips on the right edge.
 */

export interface Series {
  key: string;
  label: string;
  /** null/NaN entries render as gaps (missing data), not zero. */
  values: (number | null)[];
  tone: StatusTone;
  /** Dashed pattern for "expected/projected" series. */
  dashed?: boolean;
  /** Stroke width override. */
  width?: number;
  /** Optional value formatter for the tooltip readout. */
  format?: (v: number) => string;
}

export interface Annotation {
  /** Index into the values array (0-based). */
  index: number;
  /** Optional label string. */
  label?: string;
  tone?: StatusTone;
}

interface OpsLineChartProps {
  series: Series[];
  /** Optional x-axis labels, same length as series[0].values. */
  xLabels?: string[];
  /** Optional descriptive labels for each x-index (shown in tooltip header). */
  xTooltipLabels?: string[];
  /** Annotations (vertical guides) on specific x indices. */
  annotations?: Annotation[];
  /** y-axis labels (top to bottom). */
  yLabels?: string[];
  /** Override the auto-computed y range. */
  yRange?: [number, number];
  /** Chart height in px. */
  height?: number;
  /** Default formatter for tooltip values when series doesn't override. */
  formatValue?: (v: number) => string;
  /**
   * Opt-in drag-to-zoom. Drag horizontally over the chart to select a
   * window; on release the callback receives the inclusive [startIdx, endIdx]
   * into the values arrays. Short drags (<8px) stay clicks; Escape cancels.
   */
  onBrush?: (startIdx: number, endIdx: number) => void;
  className?: string;
}

const DEFAULT_FORMAT = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

export default function OpsLineChart({
  series,
  xLabels,
  xTooltipLabels,
  annotations,
  yLabels,
  yRange,
  height = 220,
  formatValue = DEFAULT_FORMAT,
  onBrush,
  className,
}: OpsLineChartProps) {
  const uid = useId().replace(/:/g, '');
  const n = series[0]?.values.length ?? 0;
  const hover = useChartHover(n);

  // Brush selection state (only active when onBrush is provided). The anchor
  // pixel disambiguates a click from a drag: below the threshold nothing
  // happens, so existing hover/click behavior is untouched.
  const [brush, setBrush] = useState<{ startIdx: number; currentIdx: number; dragging: boolean } | null>(null);
  const brushAnchorX = useRef(0);

  useEffect(() => {
    if (!brush) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBrush(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brush]);

  if (series.length === 0) return null;

  // Use only finite values when auto-ranging so series with missing/NaN data
  // (e.g. a plant with no fixture) don't blow out to NaN axes.
  const allValues = series.flatMap((s) => s.values);
  const finiteValues = allValues.filter((v) => Number.isFinite(v));
  if (finiteValues.length === 0) return null;
  const [yMin, yMax] = yRange ?? [Math.min(...finiteValues), Math.max(...finiteValues)];
  const yRangeSize = yMax - yMin || 1;

  const w = 1000;
  const h = 250;
  const padTop = 20;
  const padBottom = 30;
  const drawH = h - padTop - padBottom;

  const xAt = (i: number) => (i / (n - 1 || 1)) * w;
  const yAt = (v: number) => padTop + drawH - ((v - yMin) / yRangeSize) * drawH;

  const baselineY = padTop + drawH;
  const seriesPaths = series.map((s) => {
    // Split into contiguous finite segments so gaps stay gaps (no NaN
    // coordinates) — both the stroke and the area fill respect them.
    const segments: Array<Array<{ x: number; y: number }>> = [];
    let current: Array<{ x: number; y: number }> = [];
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: xAt(i), y: yAt(v as number) });
    });
    if (current.length) segments.push(current);

    const path = segments
      .map((seg) =>
        seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
      )
      .join(' ');
    // Closed area under each segment (solid series only get it painted).
    const areaPath = segments
      .filter((seg) => seg.length > 1)
      .map((seg) => {
        const line = seg.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        return `M ${seg[0].x.toFixed(1)} ${baselineY.toFixed(1)} ${line} L ${seg[seg.length - 1].x.toFixed(1)} ${baselineY.toFixed(1)} Z`;
      })
      .join(' ');
    const lastSeg = segments[segments.length - 1];
    const endPoint = lastSeg ? lastSeg[lastSeg.length - 1] : null;
    return { ...s, path, areaPath, endPoint };
  });

  const gridLines = [0, 0.33, 0.66, 1].map((p) => padTop + p * drawH);

  const hoverHeaderLabel =
    hover.hoverIdx != null
      ? (xTooltipLabels?.[hover.hoverIdx] ??
          xLabels?.[Math.round((hover.hoverIdx * ((xLabels?.length ?? 1) - 1)) / Math.max(1, n - 1))] ??
          `t=${hover.hoverIdx}`)
      : undefined;

  const tooltipRows: OpsTooltipRow[] =
    hover.hoverIdx != null
      ? series
          .map<OpsTooltipRow | null>((s) => {
            const v = s.values[hover.hoverIdx!];
            if (v == null) return null;
            const fmt = s.format ?? formatValue;
            return { key: s.key, label: s.label, value: fmt(v), tone: s.tone };
          })
          .filter((r): r is OpsTooltipRow => r !== null)
      : [];

  const containerW = hover.containerRef.current?.clientWidth ?? 1000;

  const idxFromEvent = (e: React.PointerEvent<Element>) => {
    const rect = hover.containerRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return null;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round(ratio * (n - 1));
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onBrush || e.button !== 0) return;
    const idx = idxFromEvent(e);
    if (idx == null) return;
    brushAnchorX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    setBrush({ startIdx: idx, currentIdx: idx, dragging: false });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    hover.onPointerMove(e);
    if (!brush) return;
    const idx = idxFromEvent(e);
    if (idx == null) return;
    const dragging = brush.dragging || Math.abs(e.clientX - brushAnchorX.current) > 8;
    setBrush({ ...brush, currentIdx: idx, dragging });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!brush) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (brush.dragging) {
      const a = Math.min(brush.startIdx, brush.currentIdx);
      const b = Math.max(brush.startIdx, brush.currentIdx);
      if (b > a) onBrush?.(a, b);
    }
    setBrush(null);
  };

  const brushRect =
    brush?.dragging && n > 1
      ? {
          x: xAt(Math.min(brush.startIdx, brush.currentIdx)),
          width:
            xAt(Math.max(brush.startIdx, brush.currentIdx)) -
            xAt(Math.min(brush.startIdx, brush.currentIdx)),
        }
      : null;

  return (
    <div ref={hover.containerRef} className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
        style={onBrush ? { cursor: 'crosshair', touchAction: 'pan-y' } : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={hover.onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        {gridLines.map((y, i) => (
          <line
            key={`grid-${i}`}
            x1={0}
            x2={w}
            y1={y}
            y2={y}
            stroke="var(--ops-row-hair)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {annotations?.map((a, i) => {
          const x = xAt(a.index);
          return (
            <line
              key={`ann-${uid}-${i}`}
              x1={x}
              x2={x}
              y1={padTop}
              y2={padTop + drawH}
              stroke={TONE_VAR[a.tone ?? 'warn']}
              strokeWidth="1"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
          );
        })}
        <defs>
          {seriesPaths
            .filter((s) => !s.dashed)
            .map((s) => areaGradient(`grad-${uid}-${s.key}`, s.tone))}
        </defs>
        {seriesPaths
          .filter((s) => !s.dashed && s.areaPath)
          .map((s) => (
            <path
              key={`area-${s.key}`}
              d={s.areaPath}
              fill={`url(#grad-${uid}-${s.key})`}
              stroke="none"
              pointerEvents="none"
            />
          ))}
        {seriesPaths.map((s) => (
          <path
            key={s.key}
            d={s.path}
            fill="none"
            stroke={TONE_VAR[s.tone]}
            strokeWidth={s.width ?? (s.dashed ? 1.6 : 2.5)}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity={s.dashed ? 0.75 : 1}
          />
        ))}
        {/* Persistent end-dot marks the latest reading on measured series. */}
        {seriesPaths
          .filter((s) => !s.dashed && s.endPoint)
          .map((s) => (
            <circle
              key={`end-${s.key}`}
              cx={s.endPoint!.x}
              cy={s.endPoint!.y}
              r={3.5}
              fill={TONE_VAR[s.tone]}
              stroke="var(--ops-panel)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
        {/* Brush selection */}
        {brushRect && (
          <g pointerEvents="none">
            <rect
              x={brushRect.x}
              y={padTop}
              width={brushRect.width}
              height={drawH}
              fill="var(--ops-info)"
              opacity="0.12"
            />
            <line
              x1={brushRect.x}
              x2={brushRect.x}
              y1={padTop}
              y2={padTop + drawH}
              stroke="var(--ops-info)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
            <line
              x1={brushRect.x + brushRect.width}
              x2={brushRect.x + brushRect.width}
              y1={padTop}
              y2={padTop + drawH}
              stroke="var(--ops-info)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
          </g>
        )}
        {/* Crosshair */}
        {hover.hoverIdx != null && (
          <g pointerEvents="none">
            <line
              x1={xAt(hover.hoverIdx)}
              x2={xAt(hover.hoverIdx)}
              y1={padTop}
              y2={padTop + drawH}
              stroke="var(--ops-info)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.6"
              vectorEffect="non-scaling-stroke"
            />
            {series.map((s) => {
              const v = s.values[hover.hoverIdx!];
              if (v == null) return null;
              return (
                <circle
                  key={`dot-${s.key}`}
                  cx={xAt(hover.hoverIdx!)}
                  cy={yAt(v)}
                  r={3}
                  fill={TONE_VAR[s.tone]}
                  stroke="var(--ops-panel)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
        )}
      </svg>

      {/* y-axis labels */}
      {yLabels && (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between',
            AXIS_TEXT_CLASS
          )}
          style={{
            ...AXIS_TEXT_STYLE,
            paddingTop: 14,
            paddingBottom: 30,
            width: 32,
          }}
        >
          {yLabels.map((label, i) => (
            <span key={i} className="pl-1">
              {label}
            </span>
          ))}
        </div>
      )}

      {/* x-axis labels */}
      {xLabels && (
        <div className={cn('mt-1 flex justify-between', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
          {xLabels.map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>
      )}

      {/* Annotation labels (HTML, absolutely positioned) */}
      {annotations?.map((a, i) =>
        a.label ? (
          <div
            key={`ann-label-${i}`}
            className="absolute rounded border px-1.5 py-px text-[10px]"
            style={{
              top: 4,
              left: `calc(${(a.index / (n - 1 || 1)) * 100}% + 4px)`,
              color: 'var(--ops-info)',
              background: 'var(--ops-info-bg)',
              borderColor: 'var(--ops-info-border)',
            }}
          >
            {a.label}
          </div>
        ) : null
      )}

      {hover.hoverIdx != null && !brush?.dragging && (
        <OpsTooltip
          header={hoverHeaderLabel}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={160}
        />
      )}
    </div>
  );
}
