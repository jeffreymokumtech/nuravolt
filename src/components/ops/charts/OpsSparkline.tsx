'use client';

import { useId } from 'react';
import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import type { StatusTone } from '../StatusLed';
import OpsTooltip from './OpsTooltip';
import { TONE_VAR, areaGradient } from './chartTheme';

/**
 * Tiny inline sparkline for telemetry cells. Auto-scales the y axis to its
 * own data so the line fills the height. Stroke tone is keyed to the same
 * 5 signal CSS variables every ops primitive uses; a soft gradient fill
 * (opt-out via `fill={false}`) keeps it from reading as a bare plotter trace.
 *
 * Interactive: hover shows the value at the nearest index + optional x-label.
 */

interface OpsSparklineProps {
  values: number[];
  tone?: StatusTone;
  height?: number;
  className?: string;
  /** Optional x-axis labels (same length as values) for the tooltip header. */
  xLabels?: string[];
  /** Label for the value row. Default: "value". */
  valueLabel?: string;
  /** Value formatter. */
  formatValue?: (v: number) => string;
  /** Set false to disable hover. Useful inside dense tables where ~px wins matter. */
  interactive?: boolean;
  /** Gradient area fill under the line. Default on. */
  fill?: boolean;
}

export default function OpsSparkline({
  values,
  tone = 'info',
  height = 24,
  className,
  xLabels,
  valueLabel = 'value',
  formatValue = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)),
  interactive = true,
  fill = true,
}: OpsSparklineProps) {
  const uid = useId().replace(/:/g, '');
  const hover = useChartHover(values.length);

  // Filter out NaN / Infinity so plants without fixture data render an empty
  // sparkline slot rather than emitting SVG paths with NaN coordinates.
  const finiteValues = values.filter((v) => Number.isFinite(v));
  if (finiteValues.length < 2) return null;
  if (values.length !== finiteValues.length) values = finiteValues;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100;
  const h = height;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const xAt = (i: number) => (i / (values.length - 1)) * w;
  const yAt = (v: number) => h - 2 - ((v - min) / range) * (h - 4);

  const containerW = hover.containerRef.current?.clientWidth ?? 100;
  const hoverHeader =
    hover.hoverIdx != null ? (xLabels?.[hover.hoverIdx] ?? `t=${hover.hoverIdx}`) : undefined;

  return (
    <div ref={hover.containerRef} className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        preserveAspectRatio="none"
        className="block"
        onPointerMove={interactive ? hover.onPointerMove : undefined}
        onPointerLeave={interactive ? hover.onPointerLeave : undefined}
      >
        {fill && (
          <>
            <defs>{areaGradient(`spark-${uid}`, tone)}</defs>
            <polygon
              points={`0,${h} ${points} ${w},${h}`}
              fill={`url(#spark-${uid})`}
              stroke="none"
              pointerEvents="none"
            />
          </>
        )}
        <polyline
          points={points}
          fill="none"
          stroke={TONE_VAR[tone]}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={xAt(values.length - 1)}
          cy={yAt(values[values.length - 1]!)}
          r={2.5}
          fill={TONE_VAR[tone]}
          stroke="var(--ops-panel)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        {interactive && hover.hoverIdx != null && (
          <circle
            cx={xAt(hover.hoverIdx)}
            cy={yAt(values[hover.hoverIdx]!)}
            r={2.5}
            fill={TONE_VAR[tone]}
            stroke="var(--ops-panel)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {interactive && hover.hoverIdx != null && (
        <OpsTooltip
          header={hoverHeader}
          rows={[
            {
              key: 'value',
              label: valueLabel,
              value: formatValue(values[hover.hoverIdx]!),
              tone,
            },
          ]}
          x={hover.hoverX}
          containerWidth={containerW}
          width={140}
          top="follow"
          y={hover.hoverY}
        />
      )}
    </div>
  );
}
