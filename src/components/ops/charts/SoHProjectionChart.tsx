'use client';

import { useId, useMemo } from 'react';
import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import OpsTooltip, { type OpsTooltipRow } from './OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE, areaGradient } from './chartTheme';

/**
 * SoH degradation projection chart.
 *
 *   solid violet line   → measured SoH up to today
 *   dashed violet line  → projected fade (model: semi-empirical)
 *   dashed red horizontal → warranty floor (typically 80%)
 *   dashed vertical     → EOL crossing the floor
 *
 * Interactive: hover scrubs the timeline; tooltip shows year, SoH%,
 * measured/projected status, distance to warranty floor.
 */

export interface SoHPoint {
  year: number;
  /** SoH as a fraction (0-1). */
  soh: number;
  /** True iff measured (vs projected). */
  measured: boolean;
}

interface SoHProjectionChartProps {
  points: SoHPoint[];
  warrantyFloor: number; // e.g. 0.80
  /** Year at which the projection crosses the warranty floor. */
  eolYear?: number;
  /** y range; defaults to [0.78, 1.00]. */
  yRange?: [number, number];
  /**
   * Labels for the four horizontal gridlines (top → bottom). Defaults match
   * the default yRange; pass explicit labels when overriding `yRange`.
   */
  yLabels?: [string, string, string, string];
  height?: number;
  className?: string;
}

export default function SoHProjectionChart({
  points,
  warrantyFloor,
  eolYear,
  yRange = [0.78, 1.0],
  yLabels = ['100%', '92%', '84%', '78%'],
  height = 230,
  className,
}: SoHProjectionChartProps) {
  const w = 1000;
  const h = 250;
  const padTop = 14;
  const padBottom = 30;
  const drawH = h - padTop - padBottom;
  const padLeft = 32;

  const [yMin, yMax] = yRange;
  const range = yMax - yMin;
  const years = points.map((p) => p.year);
  const xMin = Math.min(...years);
  const xMax = Math.max(...years);
  const xRange = xMax - xMin || 1;
  const hover = useChartHover(points.length);

  const xAt = (year: number) => padLeft + ((year - xMin) / xRange) * (w - padLeft);
  const yAt = (soh: number) => padTop + drawH - ((soh - yMin) / range) * drawH;

  const uid = useId().replace(/:/g, '');
  const { measuredPath, measuredAreaPath, projectedPath } = useMemo(() => {
    const measured = points.filter((p) => p.measured);
    const projected = points.filter((p) => !p.measured);
    const lastMeasured = measured[measured.length - 1];
    const projWithBridge = lastMeasured ? [lastMeasured, ...projected] : projected;

    const toPath = (pts: SoHPoint[]) =>
      pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(p.year).toFixed(1)} ${yAt(p.soh).toFixed(1)}`)
        .join(' ');

    // Area fill under measured only — projection stays a bare dashed line.
    const base = (padTop + drawH).toFixed(1);
    const area =
      measured.length > 1
        ? `M ${xAt(measured[0].year).toFixed(1)} ${base} ${measured
            .map((p) => `L ${xAt(p.year).toFixed(1)} ${yAt(p.soh).toFixed(1)}`)
            .join(' ')} L ${xAt(lastMeasured.year).toFixed(1)} ${base} Z`
        : '';

    return {
      measuredPath: toPath(measured),
      measuredAreaPath: area,
      projectedPath: toPath(projWithBridge),
    };
  }, [points, xMin, xRange, yMin, range, w, drawH]);

  const floorY = yAt(warrantyFloor);
  const eolX = eolYear != null ? xAt(eolYear) : null;

  const yPositions = [0, 0.33, 0.66, 1].map((p) => padTop + p * drawH);

  const containerW = hover.containerRef.current?.clientWidth ?? 1000;
  const hoverPoint = hover.hoverIdx != null ? points[hover.hoverIdx] : null;

  const tooltipRows: OpsTooltipRow[] = hoverPoint
    ? [
        {
          key: 'soh',
          label: 'SoH',
          value: `${(hoverPoint.soh * 100).toFixed(1)}%`,
          tone: 'bess',
        },
        {
          key: 'kind',
          label: hoverPoint.measured ? 'measured' : 'projected',
          value: hoverPoint.measured ? '✓' : '~',
          tone: hoverPoint.measured ? 'ok' : 'muted',
        },
        {
          key: 'floor',
          label: 'vs floor',
          value: `${((hoverPoint.soh - warrantyFloor) * 100).toFixed(1)}pp`,
          tone: hoverPoint.soh > warrantyFloor ? 'ok' : 'alarm',
        },
      ]
    : [];

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
      >
        {[0, 0.33, 0.66, 1].map((p, i) => (
          <line
            key={`grid-${i}`}
            x1={padLeft}
            x2={w}
            y1={padTop + p * drawH}
            y2={padTop + p * drawH}
            stroke="var(--ops-row-hair)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={padLeft}
          x2={w}
          y1={floorY}
          y2={floorY}
          stroke="var(--ops-alarm)"
          strokeWidth="1.2"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        {eolX != null && (
          <line
            x1={eolX}
            x2={eolX}
            y1={padTop}
            y2={padTop + drawH}
            stroke="var(--ops-label)"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <defs>{areaGradient(`soh-${uid}`, 'bess')}</defs>
        {measuredAreaPath && (
          <path d={measuredAreaPath} fill={`url(#soh-${uid})`} stroke="none" pointerEvents="none" />
        )}
        <path
          d={projectedPath}
          fill="none"
          stroke="var(--ops-bess)"
          strokeWidth="1.6"
          strokeDasharray="5 4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          opacity="0.7"
        />
        <path
          d={measuredPath}
          fill="none"
          stroke="var(--ops-bess)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Crosshair */}
        {hover.hoverIdx != null && hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={xAt(hoverPoint.year)}
              x2={xAt(hoverPoint.year)}
              y1={padTop}
              y2={padTop + drawH}
              stroke="var(--ops-info)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.5"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xAt(hoverPoint.year)}
              cy={yAt(hoverPoint.soh)}
              r={3.5}
              fill="var(--ops-bess)"
              stroke="var(--ops-panel)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>

      <div
        className={cn('pointer-events-none absolute left-0', AXIS_TEXT_CLASS)}
        style={{ ...AXIS_TEXT_STYLE, top: 0, bottom: padBottom, width: padLeft }}
      >
        {yLabels.map((label, i) => (
          <span
            key={i}
            className="absolute right-1"
            style={{ top: (yPositions[i] / h) * 100 + '%', transform: 'translateY(-50%)' }}
          >
            {label}
          </span>
        ))}
      </div>

      <div
        className="absolute text-[10px]"
        style={{
          top: `${(floorY / h) * 100}%`,
          left: padLeft + 4,
          color: 'var(--ops-alarm)',
          background: 'var(--ops-panel)',
          padding: '0 4px',
          transform: 'translateY(-50%)',
        }}
      >
        Warranty floor · {(warrantyFloor * 100).toFixed(0)}% SoH
      </div>

      {eolYear != null && eolX != null && (
        <div
          className="absolute rounded border px-1 py-px text-[10px]"
          style={{
            bottom: 18,
            left: `${(eolX / w) * 100}%`,
            transform: 'translateX(6px)',
            color: 'var(--ops-muted)',
            background: 'var(--ops-panel)',
            borderColor: 'var(--ops-hair)',
          }}
        >
          EOL ≈ {eolYear}
        </div>
      )}

      <div
        className={cn('mt-1 flex justify-between', AXIS_TEXT_CLASS)}
        style={{ ...AXIS_TEXT_STYLE, paddingLeft: padLeft }}
      >
        {[xMin, xMin + xRange * 0.25, xMin + xRange * 0.5, xMin + xRange * 0.75, xMax].map((y, i) => (
          <span key={i}>{Math.round(y)}</span>
        ))}
      </div>

      <div
        className="mt-2 flex gap-4 text-[11px]"
        style={{ color: 'var(--ops-muted)', paddingLeft: padLeft }}
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: 'var(--ops-bess)' }} />
          Measured SoH
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-4"
            style={{ borderTop: '2px dashed var(--ops-bess)', height: 0 }}
          />
          Projected fade
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-4"
            style={{ borderTop: '2px dashed var(--ops-alarm)', height: 0 }}
          />
          Warranty floor
        </span>
      </div>

      {hover.hoverIdx != null && hoverPoint && (
        <OpsTooltip
          header={`Year ${hoverPoint.year}`}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={180}
        />
      )}
    </div>
  );
}
