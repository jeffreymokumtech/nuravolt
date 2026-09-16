'use client';

import { useId, useMemo } from 'react';
import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import OpsTooltip, { type OpsTooltipRow } from './OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE } from './chartTheme';

/**
 * Soiling-ratio forecast chart: median line plus a 95% confidence band, with
 * an optional cleaning-window marker. The teal info colour matches the
 * SmartHelio-inspired design source.
 *
 * Interactive: pointer crosshair + multi-row tooltip (median, low/high CI,
 * AOD if present, cleaning marker indicator).
 */

export interface SrForecastPoint {
  date: string;
  predicted: number;
  lower: number;
  upper: number;
}

export interface AodOverlayPoint {
  date: string;
  /** AOD at 550nm, typically [0, 0.6] */
  aod: number;
}

interface SrForecastChartProps {
  points: SrForecastPoint[];
  /** Index of the cleaning-window marker; falsy hides it. */
  cleaningWindowIndex?: number | null;
  /** Optional label for the marker (e.g. "clean rec · Jan 6"). */
  cleaningWindowLabel?: string;
  /** Optional CAMS AOD overlay, date-matched to points; missing dates skip. */
  aodOverlay?: AodOverlayPoint[];
  /** y range; defaults to [0.90, 0.99]. */
  yRange?: [number, number];
  height?: number;
  className?: string;
  /** Optional click handler, receives the date at the clicked index. */
  onDateClick?: (date: string, index: number) => void;
}

export default function SrForecastChart({
  points,
  cleaningWindowIndex,
  cleaningWindowLabel,
  aodOverlay,
  yRange = [0.9, 0.99],
  height = 230,
  className,
  onDateClick,
}: SrForecastChartProps) {
  const w = 1000;
  const h = 260;
  const padTop = 12;
  const padBottom = 30;
  const drawH = h - padTop - padBottom;

  const uid = useId().replace(/:/g, '');
  const [yMin, yMax] = yRange;
  const range = yMax - yMin;
  const n = points.length;
  const hover = useChartHover(n);

  const xAt = (i: number) => (i / (n - 1 || 1)) * w;
  const yAt = (v: number) => padTop + drawH - ((v - yMin) / range) * drawH;

  const { medianPath, bandPath } = useMemo(() => {
    if (n === 0) return { medianPath: '', bandPath: '' };
    const median = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p.predicted).toFixed(1)}`)
      .join(' ');
    const upper = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p.upper).toFixed(1)}`);
    const lowerReverse = [...points]
      .reverse()
      .map((p, i) => `L ${xAt(n - 1 - i).toFixed(1)} ${yAt(p.lower).toFixed(1)}`);
    return {
      medianPath: median,
      bandPath: [...upper, ...lowerReverse, 'Z'].join(' '),
    };
  }, [points, n, w, drawH, yMin, range]);

  const yLabels = [yMax, yMin + range * 0.66, yMin + range * 0.33, yMin].map(
    (v) => `${(v * 100).toFixed(0)}%`
  );

  const labelStride = Math.max(1, Math.floor(n / 6));
  const xLabels = points.map((p, i) => (i % labelStride === 0 ? p.date.slice(5) : ''));

  const aodByDate = useMemo(() => {
    if (!aodOverlay?.length) return null;
    const map = new Map<string, number>();
    for (const a of aodOverlay) map.set(a.date, a.aod);
    return map;
  }, [aodOverlay]);
  const aodMax = useMemo(() => {
    if (!aodOverlay?.length) return 0;
    return Math.max(...aodOverlay.map((a) => a.aod));
  }, [aodOverlay]);
  const aodBars = useMemo(() => {
    if (!aodByDate || aodMax <= 0) return null;
    return points.map((p, i) => {
      const aod = aodByDate.get(p.date);
      if (aod == null || aod <= 0) return null;
      const barH = Math.min((aod / aodMax) * (drawH * 0.35), drawH * 0.4);
      return {
        x: xAt(i),
        y: padTop + drawH - barH,
        h: barH,
        aod,
      };
    });
  }, [aodByDate, aodMax, points, drawH]);
  const aodHighEvents = useMemo(() => {
    if (!aodOverlay?.length || aodMax < 0.15) return [];
    return points
      .map((p, i) => ({ idx: i, aod: aodByDate?.get(p.date) ?? 0, date: p.date }))
      .filter((e) => e.aod >= 0.18);
  }, [aodByDate, aodMax, aodOverlay, points]);

  const containerW = hover.containerRef.current?.clientWidth ?? 1000;
  const hoverPoint = hover.hoverIdx != null ? points[hover.hoverIdx] : null;
  const hoverAod = hoverPoint && aodByDate?.get(hoverPoint.date);

  const tooltipRows: OpsTooltipRow[] = hoverPoint
    ? [
        {
          key: 'median',
          label: 'SR median',
          value: `${(hoverPoint.predicted * 100).toFixed(1)}%`,
          tone: 'info',
        },
        {
          key: 'upper',
          label: '95% upper',
          value: `${(hoverPoint.upper * 100).toFixed(1)}%`,
          tone: 'muted',
        },
        {
          key: 'lower',
          label: '95% lower',
          value: `${(hoverPoint.lower * 100).toFixed(1)}%`,
          tone: 'muted',
        }, ...(hoverAod != null
          ? [
              {
                key: 'aod',
                label: 'CAMS AOD',
                value: hoverAod.toFixed(3),
                tone: 'warn' as const,
              },
            ]
          : []), ...(cleaningWindowIndex != null && cleaningWindowIndex === hover.hoverIdx
          ? [
              {
                key: 'clean',
                label: 'cleaning',
                value: cleaningWindowLabel ?? 'recommended',
                tone: 'warn' as const,
              },
            ]
          : []),
      ]
    : [];

  const handleClick = () => {
    if (!onDateClick || hover.hoverIdx == null) return;
    const p = points[hover.hoverIdx];
    if (p) onDateClick(p.date, hover.hoverIdx);
  };

  return (
    <div ref={hover.containerRef} className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
        onPointerMove={hover.onPointerMove}
        onPointerLeave={hover.onPointerLeave}
        onClick={onDateClick ? handleClick : undefined}
        style={{ cursor: onDateClick ? 'pointer' : 'default' }}
      >
        {[0, 0.33, 0.66, 1].map((p, i) => (
          <line
            key={`grid-${i}`}
            x1={0}
            x2={w}
            y1={padTop + p * drawH}
            y2={padTop + p * drawH}
            stroke="var(--ops-row-hair)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {aodBars?.map(
          (bar, i) =>
            bar && (
              <rect
                key={`aod-${i}`}
                x={bar.x - 6}
                y={bar.y}
                width={12}
                height={bar.h}
                fill="var(--ops-warn)"
                opacity={0.18}
              />
            )
        )}
        {aodHighEvents.map((e, i) => (
          <circle
            key={`aod-event-${i}`}
            cx={xAt(e.idx)}
            cy={padTop + 4}
            r={3.5}
            fill="var(--ops-warn)"
            opacity={0.85}
          >
            <title>{`Dust event · ${e.date} · AOD ${e.aod.toFixed(3)}`}</title>
          </circle>
        ))}
        <defs>
          {/* Confidence band fade — slightly denser than the standard series
              fill so the 95% envelope stays legible around the median. */}
          <linearGradient id={`sr-band-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ops-info)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--ops-info)" stopOpacity="0.06" />
          </linearGradient>
        </defs>
        <path d={bandPath} fill={`url(#sr-band-${uid})`} stroke="none" />
        <path
          d={medianPath}
          fill="none"
          stroke="var(--ops-info)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {cleaningWindowIndex != null && cleaningWindowIndex >= 0 && (
          <line
            x1={xAt(cleaningWindowIndex)}
            x2={xAt(cleaningWindowIndex)}
            y1={padTop}
            y2={padTop + drawH}
            stroke="var(--ops-warn)"
            strokeWidth="1.4"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
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
            {hoverPoint && (
              <>
                <circle
                  cx={xAt(hover.hoverIdx)}
                  cy={yAt(hoverPoint.predicted)}
                  r={3.5}
                  fill="var(--ops-info)"
                  stroke="var(--ops-panel)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </g>
        )}
      </svg>

      {/* y labels */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between',
          AXIS_TEXT_CLASS
        )}
        style={{
          ...AXIS_TEXT_STYLE,
          paddingTop: 8,
          paddingBottom: 30,
          width: 28,
        }}
      >
        {yLabels.map((label, i) => (
          <span key={i} className="pl-1">
            {label}
          </span>
        ))}
      </div>

      {/* x labels */}
      <div className={cn('mt-1 flex justify-between', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
        {xLabels.filter(Boolean).map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>

      {/* Cleaning window label */}
      {cleaningWindowIndex != null && cleaningWindowLabel && (
        <div
          className="absolute rounded border px-1.5 py-px text-[10px]"
          style={{
            top: 4,
            left: `calc(${(cleaningWindowIndex / (n - 1 || 1)) * 100}% + 4px)`,
            color: 'var(--ops-warn)',
            background: 'var(--ops-warn-bg)',
            borderColor: 'var(--ops-warn-border)',
          }}
        >
          {cleaningWindowLabel}
        </div>
      )}

      {hover.hoverIdx != null && tooltipRows.length > 0 && (
        <OpsTooltip
          header={hoverPoint?.date}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={180}
        />
      )}
    </div>
  );
}
