'use client';

import ZoneHeatmap, { HeatLegend, type HeatCell } from './ZoneHeatmap';
import { useHeatRamp } from './chartTheme';

/**
 * Thin wrapper around ZoneHeatmap pre-configured for module thermal data:
 * °C unit, 1-decimal formatter, theme-aware cool→warm thermal ramp.
 */

interface ThermalMapProps {
  cells: HeatCell[];
  columns?: number;
  /** Default 27. */
  rangeMin?: number;
  /** Default 32. */
  rangeMax?: number;
  className?: string;
}

export default function ThermalMap({
  cells,
  columns = 8,
  rangeMin = 27,
  rangeMax = 32,
  className,
}: ThermalMapProps) {
  const ramp = useHeatRamp('thermal');
  return (
    <ZoneHeatmap
      cells={cells}
      columns={columns}
      valueMin={rangeMin}
      valueMax={rangeMax}
      formatValue={(v) => v.toFixed(1)}
      unit="°"
      ramp={ramp}
      className={className}
    />
  );
}

export { HeatLegend as ThermalLegend };
