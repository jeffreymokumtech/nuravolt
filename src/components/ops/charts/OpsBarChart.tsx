'use client';

import { cn } from '@/helpers/utils';
import { useChartHover } from '@/hooks/useChartHover';
import type { StatusTone } from '../StatusLed';
import OpsTooltip, { type OpsTooltipRow } from './OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE, TONE_VAR } from './chartTheme';

/**
 * Ops-styled bar chart for bucketed aggregates (loss per month, cycles per
 * month, SoH fade per month). Inline SVG, hairline grid, hover tooltip via
 * the shared useChartHover/OpsTooltip primitives — same visual language as
 * OpsLineChart. Handles negative bars (e.g. capacity-fade deltas) by
 * anchoring bars to a zero baseline inside the auto range.
 */

export interface OpsBar {
  /** Bucket label (also the tooltip header), e.g. "Jun 25". */
  label: string;
  value: number | null;
  tone?: StatusTone;
}

interface OpsBarChartProps {
  bars: OpsBar[];
  /** What the bar values are, for the tooltip (e.g. "Energy loss"). */
  valueLabel?: string;
  /** Optional secondary line drawn over the bars on its own scale. */
  overlay?: {
    label: string;
    values: (number | null)[];
    tone?: StatusTone;
    format?: (v: number) => string;
  };
  height?: number;
  formatValue?: (v: number) => string;
  /** Unit rendered after the top y-label, e.g. "MWh". */
  yUnit?: string;
  defaultTone?: StatusTone;
  className?: string;
}

const DEFAULT_FORMAT = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

export default function OpsBarChart({
  bars,
  valueLabel = 'Value',
  overlay,
  height = 200,
  formatValue = DEFAULT_FORMAT,
  yUnit,
  defaultTone = 'info',
  className,
}: OpsBarChartProps) {
  const n = bars.length;
  const hover = useChartHover(n);
  if (n === 0) return null;

  const finite = bars.map((b) => b.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  // Range always includes zero so bars have an honest baseline.
  const yMax = Math.max(0, ...finite);
  const yMin = Math.min(0, ...finite);
  const range = yMax - yMin || 1;

  const w = 1000;
  const h = 250;
  const padTop = 20;
  const padBottom = 30;
  const drawH = h - padTop - padBottom;

  const yAt = (v: number) => padTop + drawH - ((v - yMin) / range) * drawH;
  const zeroY = yAt(0);
  const slot = w / n;
  const barW = Math.max(2, slot * 0.62);

  // Overlay line normalized to its own scale.
  const ovFinite = (overlay?.values ?? []).filter(
    (v): v is number => v != null && Number.isFinite(v)
  );
  const ovMin = ovFinite.length ? Math.min(...ovFinite) : 0;
  const ovMax = ovFinite.length ? Math.max(...ovFinite) : 1;
  const ovRange = ovMax - ovMin || 1;
  const ovYAt = (v: number) => padTop + drawH - ((v - ovMin) / ovRange) * drawH;
  const overlayPath = (() => {
    if (!overlay || ovFinite.length === 0) return null;
    const parts: string[] = [];
    let move = true;
    overlay.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        move = true;
        return;
      }
      parts.push(`${move ? 'M' : 'L'} ${(i * slot + slot / 2).toFixed(1)} ${ovYAt(v).toFixed(1)}`);
      move = false;
    });
    return parts.join(' ');
  })();

  const gridLines = [0, 0.33, 0.66, 1].map((p) => padTop + p * drawH);
  const yLabels = [yMax, yMin + range * 0.66, yMin + range * 0.33, yMin].map((v, i) =>
    i === 0 && yUnit ? `${formatValue(v)} ${yUnit}` : formatValue(v)
  );

  const stride = Math.max(1, Math.ceil(n / 8));
  const containerW = hover.containerRef.current?.clientWidth ?? 1000;

  const tooltipRows: OpsTooltipRow[] =
    hover.hoverIdx != null
      ? ([
          bars[hover.hoverIdx]?.value != null
            ? {
                key: 'bar',
                label: valueLabel,
                value: formatValue(bars[hover.hoverIdx].value as number),
                tone: bars[hover.hoverIdx].tone ?? defaultTone,
              }
            : null,
          overlay && overlay.values[hover.hoverIdx] != null
            ? {
                key: 'overlay',
                label: overlay.label,
                value: (overlay.format ?? formatValue)(overlay.values[hover.hoverIdx] as number),
                tone: overlay.tone ?? 'muted',
              }
            : null,
        ].filter(Boolean) as OpsTooltipRow[])
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
        {yMin < 0 && (
          <line
            x1={0}
            x2={w}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--ops-hair)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {bars.map((b, i) => {
          if (b.value == null || !Number.isFinite(b.value)) return null;
          const x = i * slot + (slot - barW) / 2;
          const top = Math.min(zeroY, yAt(b.value));
          const hgt = Math.max(1, Math.abs(yAt(b.value) - zeroY));
          const active = hover.hoverIdx === i;
          return (
            <rect
              key={i}
              x={x.toFixed(1)}
              y={top.toFixed(1)}
              width={barW.toFixed(1)}
              height={hgt.toFixed(1)}
              fill={TONE_VAR[b.tone ?? defaultTone]}
              opacity={active ? 1 : 0.9}
              rx={2.5}
            />
          );
        })}
        {overlayPath && (
          <path
            d={overlayPath}
            fill="none"
            stroke={TONE_VAR[overlay?.tone ?? 'muted']}
            strokeWidth={1.75}
            strokeDasharray="5 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity={0.85}
          />
        )}
      </svg>

      {/* y-axis labels */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between',
          AXIS_TEXT_CLASS
        )}
        style={{ ...AXIS_TEXT_STYLE, paddingTop: 14, paddingBottom: 30 }}
      >
        {yLabels.map((label, i) => (
          <span key={i} className="pl-1">
            {label}
          </span>
        ))}
      </div>

      {/* x-axis labels */}
      <div className={cn('mt-1 flex justify-between', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
        {bars
          .filter((_, i) => i % stride === 0)
          .map((b, i) => (
            <span key={`${b.label}-${i}`}>{b.label}</span>
          ))}
      </div>

      {hover.hoverIdx != null && (
        <OpsTooltip
          header={bars[hover.hoverIdx]?.label}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={170}
        />
      )}
    </div>
  );
}
