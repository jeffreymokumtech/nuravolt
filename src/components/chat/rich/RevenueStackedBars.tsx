'use client';

import { useId } from 'react';
import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import OpsTooltip, { type OpsTooltipRow } from '@/components/ops/charts/OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE } from '@/components/ops/charts/chartTheme';
import {
  LANE_ORDER,
  LANE_STYLE,
  currencySymbol,
  serviceValue,
  servicesInLane,
  type RevenueLane,
} from '@/lib/config/bessServices';
import {
  HATCH,
  laneColumnsForDay,
  laneMarkProps,
  laneScaleMax,
  laneSubtotals,
  lanesPresent,
  type LaneColumn,
  type LaneSegment,
  type RevenueDay,
} from '@/hooks/useBESSData';

/**
 * Daily revenue bars for the Shams inline BESS revenue render, grouped by
 * ledger lane.
 *
 * THE LANES ARE NEVER SUMMED. Each day gets one column per lane, side by side,
 * stacked internally by service. A single tall stack would read as one
 * confident total, and it would be a fabrication: a declared availability
 * payment and a measured settlement can cover the same megawatt hour, so
 * adding them double counts it. The y axis is therefore scaled to the tallest
 * LANE column, never to a day total, and no tooltip row, legend entry or
 * exported helper in this file produces a cross-lane sum.
 *
 * Lane texture comes from LANE_STYLE and both the bars and the legend swatch
 * go through the same laneMarkProps / HatchPattern pair, so the marks and the
 * legend cannot drift apart. Stripes are horizontal on purpose: the chart svg
 * stretches on x only, and a horizontal stripe survives that unchanged.
 */

export {
  HATCH,
  laneColumnsForDay,
  laneMarkProps,
  laneScaleMax,
  laneSubtotals,
  lanesPresent,
};
export type { LaneColumn, LaneSegment, RevenueDay };

function HatchPattern({ id, color }: { id: string; color: string }) {
  return (
    <pattern id={id} width={HATCH.period} height={HATCH.period} patternUnits="userSpaceOnUse">
      <rect width={HATCH.period} height={HATCH.period} fill={color} fillOpacity={0.3} />
      <rect width={HATCH.period} height={HATCH.on} fill={color} />
    </pattern>
  );
}

/** Legend swatch drawn through the same helpers as the bars. */
export function LaneSwatch({
  lane,
  color = 'var(--ops-label)',
  className,
}: {
  lane: RevenueLane;
  color?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const patternId = `swatch-${uid}-${lane}`;
  return (
    <svg width={14} height={10} className={cn('inline-block shrink-0', className)} aria-hidden="true">
      {LANE_STYLE[lane].pattern === 'hatch' && (
        <defs>
          <HatchPattern id={patternId} color={color} />
        </defs>
      )}
      <rect x={0.5} y={0.5} width={13} height={9} rx={1} {...laneMarkProps(lane, color, patternId)} />
    </svg>
  );
}

export default function RevenueStackedBars({
  series,
  currency,
  height = 150,
  className,
}: {
  series: RevenueDay[];
  currency?: string;
  height?: number;
  className?: string;
}) {
  const n = series.length;
  const hover = useChartHover(n);
  const uid = useId().replace(/:/g, '');
  if (n === 0) return null;

  const lanes = lanesPresent(series);
  if (lanes.length === 0) return null;

  const sym = currencySymbol(currency ?? '');
  const max = laneScaleMax(series);

  const w = 1000;
  const h = 250;
  const padTop = 16;
  const padBottom = 30;
  const drawH = h - padTop - padBottom;
  const slot = w / n;
  const groupW = Math.max(3, slot * 0.74);
  const colW = Math.max(1.5, groupW / lanes.length - Math.min(1.5, groupW * 0.04));

  const fmt = (v: number) =>
    Math.abs(v) >= 1000 ? `${sym}${(v / 1000).toFixed(1)}k` : `${sym}${Math.round(v)}`;

  const stride = Math.max(1, Math.ceil(n / 6));
  const containerW = hover.containerRef.current?.clientWidth ?? 1000;

  const hoverDay = hover.hoverIdx != null ? series[hover.hoverIdx] : null;
  const hoverColumns = laneColumnsForDay(hoverDay);
  const tooltipRows: OpsTooltipRow[] = hoverColumns.flatMap((col) => [
    {
      key: `${col.lane}-subtotal`,
      label: `${LANE_STYLE[col.lane].label} lane`,
      value: fmt(col.subtotal),
    },
    ...col.segments.map((seg) => ({
      key: `${col.lane}-${seg.base}`,
      label: `  ${seg.short}`,
      value: fmt(seg.value),
    })),
  ]);

  // One hatch pattern per (lane, service) pair that needs one.
  const hatchDefs = lanes
    .filter((lane) => LANE_STYLE[lane].pattern === 'hatch')
    .flatMap((lane) => servicesInLane(lane).map((svc) => ({ lane, svc })));

  const patternId = (lane: RevenueLane, base: string) => `bars-${uid}-${lane}-${base}`;

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
        <defs>
          {hatchDefs.map(({ lane, svc }) => (
            <HatchPattern
              key={`${lane}-${svc.base}`}
              id={patternId(lane, svc.base)}
              color={svc.color}
            />
          ))}
        </defs>

        {[0, 0.5, 1].map((p, i) => (
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

        {series.map((day, i) => {
          const active = hover.hoverIdx === i;
          const columns = laneColumnsForDay(day);
          const groupX = i * slot + (slot - groupW) / 2;
          return (
            <g key={day.date} opacity={hover.hoverIdx == null || active ? 1 : 0.45}>
              {columns.map((col) => {
                const laneIdx = lanes.indexOf(col.lane);
                if (laneIdx < 0) return null;
                const x = groupX + laneIdx * (groupW / lanes.length);
                let yCursor = padTop + drawH;
                return (
                  <g key={col.lane}>
                    {col.segments.map((seg) => {
                      const segH = (seg.value / max) * drawH;
                      yCursor -= segH;
                      return (
                        <rect
                          key={seg.base}
                          x={x.toFixed(1)}
                          y={yCursor.toFixed(1)}
                          width={colW.toFixed(1)}
                          height={Math.max(0.5, segH).toFixed(1)}
                          {...laneMarkProps(col.lane, seg.color, patternId(col.lane, seg.base))}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* y labels */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between',
          AXIS_TEXT_CLASS
        )}
        style={{ ...AXIS_TEXT_STYLE, paddingTop: 10, paddingBottom: 30 }}
      >
        <span className="pl-1">{fmt(max)}</span>
        <span className="pl-1">{fmt(max / 2)}</span>
        <span className="pl-1">0</span>
      </div>

      {/* x labels */}
      <div className={cn('mt-1 flex justify-between', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
        {series
          .filter((_, i) => i % stride === 0)
          .map((day) => (
            <span key={day.date}>{day.date.slice(5)}</span>
          ))}
      </div>

      {/* Lane legend: what each texture means */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {lanes.map((lane) => (
          <span
            key={lane}
            title={LANE_STYLE[lane].hint}
            className={cn('inline-flex items-center gap-1', AXIS_TEXT_CLASS)}
            style={AXIS_TEXT_STYLE}
          >
            <LaneSwatch lane={lane} />
            {LANE_STYLE[lane].label}
          </span>
        ))}
      </div>

      {/* Service legend: what each colour means */}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {LANE_ORDER.flatMap((lane) => servicesInLane(lane))
          .filter((svc) => series.some((day) => serviceValue(day, svc.base) > 0))
          .map((svc) => (
            <span
              key={svc.base}
              title={svc.label}
              className={cn('inline-flex items-center gap-1', AXIS_TEXT_CLASS)}
              style={AXIS_TEXT_STYLE}
            >
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: svc.color }} />
              {svc.short}
            </span>
          ))}
      </div>

      <p className={cn('mt-1.5', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
        Lanes sit side by side and are never added together. The axis is scaled to the tallest lane,
        not to a day total.
      </p>

      {hover.hoverIdx != null && tooltipRows.length > 0 && (
        <OpsTooltip
          header={hoverDay?.date}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={172}
        />
      )}
    </div>
  );
}
