'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { AskAIButton } from '@/components/copilot/AskAIButton';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

export interface TwinPoint {
  date: string;
  predicted?: number | null;
  actual?: number | null;
  residual?: number | null;
}

export interface FleetBandPoint {
  date: string;
  p10: number;
  p50: number;
  p90: number;
}

type TwinMetric = 'power_ac' | 'temperature' | 'voltage_dc' | 'current_dc';

interface Props {
  /** Predicted/actual series from /api/digitaltwin/.../parquet-query (or /timeseries). */
  series: TwinPoint[];
  /** Y-axis unit label, e.g. "V", "A", "kW", "°C". */
  unit: string;
  /** Optional override for line colours. */
  predictedColor?: string;
  actualColor?: string;
  /** Chart height in px. Defaults to 280. */
  height?: number;
  /** When true, only render daily-truncated dates (good for >100-day windows). */
  truncateToDate?: boolean;
  /**
   * Optional metadata so the chart can render an "Ask Copilot" pill with
   * context. When metric/inverterId/plantId are provided, the pill is shown.
   */
  metric?: TwinMetric;
  inverterId?: string;
  plantId?: string;
  /** Human label shown in seed text. */
  metricLabel?: string;
  /**
   * Optional plant-wide P10/P50/P90 envelope for the same metric, aligned by
   * date. When provided, the chart renders the band as a translucent area
   * behind the predicted/actual lines plus a dashed median line, so the user
   * can see whether this device is sitting inside, above, or below the fleet.
   */
  fleetBand?: FleetBandPoint[];
}

/**
 * Standardised twin chart used by inverter / MPPT / string drill-down pages.
 * Mirrors the inverter detail page's voltage/current/temp chart pattern exactly
 * so the visual language is consistent at every hierarchy level.
 */
export default function TwinTimelineChart({
  series,
  unit,
  predictedColor = '#3b82f6',
  actualColor = '#8b5cf6',
  height = 280,
  truncateToDate = true,
  metric,
  inverterId,
  plantId,
  metricLabel,
  fleetBand,
}: Props) {
  const visibleRange = useMemo(() => {
    if (!series || series.length === 0) return null;
    const dates = series
      .map((s) => s.date?.split('T')[0])
      .filter(Boolean) as string[];
    if (dates.length === 0) return null;
    return { from: dates[0], to: dates[dates.length - 1] };
  }, [series]);

  const askSeed = () => {
    const m = metricLabel ?? metric ?? 'this metric';
    const range = visibleRange ? ` between ${visibleRange.from} and ${visibleRange.to}` : '';
    const inv = inverterId ? ` for inverter ${inverterId}` : '';
    return `What is causing the ${m} predicted-vs-actual divergence${inv}${range}? Use getInverterDiagnosis if helpful.`;
  };
  const options = useMemo(() => {
    if (!series || series.length === 0) return null;
    const dates = series.map((s) =>
      truncateToDate && s.date ? s.date.split('T')[0].split(' ')[0] : s.date
    );
    const round1 = (v: number | null | undefined) =>
      v == null ? null : Math.round(v * 10) / 10;
    const predicted = series.map((s) => round1(s.predicted));
    const actual = series.map((s) => round1(s.actual));

    // Align the fleet band to the device series' date axis so areaStyle stacks
    // cleanly. ECharts stacked areas require equal-length data arrays.
    const fleetByDate = new Map<string, FleetBandPoint>();
    if (fleetBand) {
      for (const f of fleetBand) {
        const d = f.date?.split('T')[0].split(' ')[0] ?? f.date;
        fleetByDate.set(d, f);
      }
    }
    const p10Series = dates.map((d) => {
      const f = fleetByDate.get(d as string);
      return f ? round1(f.p10) : null;
    });
    const p90MinusP10Series = dates.map((d) => {
      const f = fleetByDate.get(d as string);
      return f ? round1(f.p90 - f.p10) : null;
    });
    const p50Series = dates.map((d) => {
      const f = fleetByDate.get(d as string);
      return f ? round1(f.p50) : null;
    });
    const hasFleet = fleetBand && fleetBand.length > 0;

    const baseSeries: any[] = [];
    if (hasFleet) {
      // Lower bound line (invisible, just anchors the stacked area).
      baseSeries.push({
        name: 'Fleet P10',
        type: 'line',
        stack: 'fleet-band',
        data: p10Series,
        symbol: 'none',
        showSymbol: false,
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: { color: 'transparent' },
        z: 1,
        silent: true,
        // Hide from legend, the band is controlled by "Fleet P10,P90".
        legendHoverLink: false,
        tooltip: { show: false },
      });
      // P90 - P10 ribbon stacks on top of P10 to form the band.
      baseSeries.push({
        name: 'Fleet P10,P90',
        type: 'line',
        stack: 'fleet-band',
        data: p90MinusP10Series,
        symbol: 'none',
        showSymbol: false,
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: { color: 'rgba(100, 116, 139, 0.15)' },
        z: 1,
        tooltip: {
          formatter: (params: any) =>
            `Fleet band: ${params.value != null ? `±${params.value.toFixed(1)} ${unit}` : ','}`,
        },
      });
      // P50 median dashed line.
      baseSeries.push({
        name: 'Fleet median',
        type: 'line',
        data: p50Series,
        symbol: 'none',
        lineStyle: { color: '#64748b', width: 1, type: 'dashed' },
        itemStyle: { color: '#64748b' },
        z: 2,
      });
    }
    baseSeries.push({
      name: 'Predicted',
      type: 'line',
      data: predicted,
      symbol: 'none',
      itemStyle: { color: predictedColor },
      lineStyle: { color: predictedColor, width: 1.5 },
      z: 3,
    });
    baseSeries.push({
      name: 'Actual',
      type: 'line',
      data: actual,
      symbol: 'none',
      itemStyle: { color: actualColor },
      lineStyle: { color: actualColor, width: 1.5 },
      z: 3,
    });

    const legendData = hasFleet
      ? ['Predicted', 'Actual', 'Fleet median', 'Fleet P10,P90']
      : ['Predicted', 'Actual'];

    return {
      tooltip: { trigger: 'axis' },
      legend: { data: legendData, top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 50, right: 20, top: 40, bottom: 70 },
      // Short series (a month or two of daily points) open fully visible;
      // long archives open on the recent ~90 points. The slider still lets
      // the user zoom to any window.
      dataZoom: [
        {
          type: 'slider',
          start: dates.length <= 90 ? 0 : Math.round((1 - 90 / dates.length) * 100),
          end: 100,
        },
      ],
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { rotate: 45, fontSize: 9 },
      },
      yAxis: { type: 'value', name: unit },
      // Provide a chart-level color palette so the legend dots match each series
      // automatically (without this, ECharts picks the marker colour from its
      // default palette, producing the blue/green dots even when the line is
      // drawn in a different colour).
      color: [predictedColor, actualColor, '#64748b', '#94a3b8'],
      series: baseSeries,
    };
  }, [series, unit, predictedColor, actualColor, truncateToDate, fleetBand]);

  if (!options) {
    return (
      <div className="text-sm text-gray-400 italic py-8 text-center">
        No twin data available for this device / period.
      </div>
    );
  }
  return (
    <div className="relative">
      {(metric || inverterId) && (
        <div className="absolute right-1 top-1 z-10">
          <AskAIButton
            seed={askSeed}
            context={{
              plantId,
              inverterId,
              twin: metric,
              range: visibleRange ?? undefined,
            }}
            variant="pill"
            label="Ask Shams"
            title={`Ask Shams about ${metricLabel ?? metric ?? 'this metric'}`}
          />
        </div>
      )}
      <ReactECharts
        option={options}
        style={{ height: `${height}px`, width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}
