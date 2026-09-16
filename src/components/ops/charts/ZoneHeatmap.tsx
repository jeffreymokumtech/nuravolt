'use client';

import { useState } from 'react';
import { cn } from '@/helpers/utils';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE, useHeatRamp } from './chartTheme';

/**
 * Grid of heat-mapped cells (zones, modules, inverters). Each cell renders
 * its value + an identifier; the background is interpolated through a small
 * heat ramp keyed to `valueMin..valueMax`.
 *
 * Used for: zone soiling heatmap (SR%) and module thermal map (°C).
 *
 * Interactive: each cell highlights on hover (ring + slight lift) and
 * reports its identifier through an optional `onCellClick` handler.
 */

export interface HeatCell {
  id: string;
  /** Numeric value used for colour interpolation. */
  value: number;
  /** Sublabel, e.g. inverter number. */
  sublabel?: string;
  /** Optional tooltip body, second line of context (e.g. "12 inverters · 32% loss"). */
  tooltipBody?: string;
}

interface ZoneHeatmapProps {
  cells: HeatCell[];
  columns: number;
  valueMin: number;
  valueMax: number;
  /** Function that returns the display value (default: value with `unit`). */
  formatValue?: (v: number) => string;
  unit?: string;
  /** Five-stop ramp; lower → upper. Defaults to the theme-aware soiling ramp. */
  ramp?: string[];
  className?: string;
  /** Optional click handler, receives the cell id. */
  onCellClick?: (id: string) => void;
  /** Optional currently-selected cell id (renders a thicker ring). */
  selectedId?: string;
}

function lerpColor(stops: string[], t: number): string {
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const scaled = t * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const c1 = hexToRgb(stops[i]);
  const c2 = hexToRgb(stops[i + 1]);
  const r = Math.round(c1.r + (c2.r - c1.r) * f);
  const g = Math.round(c1.g + (c2.g - c1.g) * f);
  const b = Math.round(c1.b + (c2.b - c1.b) * f);
  return `rgb(${r},${g},${b})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const bigint = parseInt(m, 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

export default function ZoneHeatmap({
  cells,
  columns,
  valueMin,
  valueMax,
  formatValue = (v) => v.toString(),
  unit,
  ramp,
  className,
  onCellClick,
  selectedId,
}: ZoneHeatmapProps) {
  const themeRamp = useHeatRamp('soiling');
  const activeRamp = ramp ?? themeRamp;
  const range = valueMax - valueMin || 1;
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <div
      className={cn('grid relative', className)}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 5,
      }}
    >
      {cells.map((cell) => {
        const t = (cell.value - valueMin) / range;
        const bg = lerpColor(activeRamp, t);
        const stressed = t > 0.85;
        const isSelected = selectedId === cell.id;
        const isHovered = hoverId === cell.id;
        return (
          <div
            key={cell.id}
            data-zone-cell={cell.id}
            className={cn(
              'rounded-sm border px-1.5 py-2 text-center font-mono transition-all',
              onCellClick && 'cursor-pointer'
            )}
            style={{
              background: bg,
              borderColor: isSelected
                ? 'var(--ops-info)'
                : isHovered
                ? 'var(--ops-bright)'
                : stressed
                ? 'var(--ops-warn-border)'
                : 'transparent',
              borderWidth: isSelected ? 2 : 1,
              boxShadow: isHovered ? '0 0 0 1px var(--ops-bright) inset' : undefined,
              transform: isHovered ? 'translateY(-1px)' : undefined,
            }}
            onMouseEnter={() => setHoverId(cell.id)}
            onMouseLeave={() => setHoverId(null)}
            onClick={onCellClick ? () => onCellClick(cell.id) : undefined}
            title={cell.tooltipBody ? `${cell.id} · ${cell.tooltipBody}` : cell.id}
          >
            <div className="text-[12px] font-semibold" style={{ color: 'var(--ops-bright)' }}>
              {formatValue(cell.value)}
              {unit && (
                <span className="text-[9px]" style={{ color: 'var(--ops-muted)' }}>
                  {unit}
                </span>
              )}
            </div>
            {cell.sublabel && (
              <div className="text-[9px]" style={{ color: 'var(--ops-muted)' }}>
                {cell.sublabel}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Inline heat-ramp legend chip used in panel headers. */
export function HeatLegend({
  min,
  max,
  unit,
  ramp,
}: {
  min: number;
  max: number;
  unit?: string;
  ramp?: string[];
}) {
  const themeRamp = useHeatRamp('soiling');
  const activeRamp = ramp ?? themeRamp;
  return (
    <div className={cn('flex items-center gap-1.5', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
      <span>
        {min}
        {unit}
      </span>
      <span
        className="inline-block h-2 w-12 rounded-sm"
        style={{ background: `linear-gradient(90deg, ${activeRamp.join(',')})` }}
      />
      <span>
        {max}
        {unit}
      </span>
    </div>
  );
}
