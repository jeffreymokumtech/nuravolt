/**
 * Chartable-metric vocabulary shared by the chart.timeseries widget, the
 * getChart chat tool, and the MCP chart tool. Pure module — no React, no
 * prisma — importable from server tools and client widgets alike.
 *
 * Two data sources:
 * - 'twin':         GET /api/digitaltwin/[plant]/timeseries (daily
 *                   predicted/actual/residual; device_id "PLANT" or an
 *                   inverter external id; optional fleet band)
 * - 'measurements': GET /api/measurements/[plant]?resolution=daily
 *                   (measured telemetry only; long-format daily rows)
 */

export type ChartSource = 'twin' | 'measurements';

export interface ChartMetricMeta {
  source: ChartSource;
  unit: string;
  label: string;
}

export const CHART_METRIC_KEYS = [
  'power_ac',
  'temperature',
  'voltage_dc',
  'current_dc',
  'energy_daily',
  'irradiance_poa',
  'irradiance_ghi',
  'soiling_ratio',
  'temp_ambient',
  'temp_module',
  'power_dc',
] as const;

export type ChartMetric = (typeof CHART_METRIC_KEYS)[number];

export const CHART_METRICS: Record<ChartMetric, ChartMetricMeta> = {
  // Digital-twin metrics (predicted vs actual)
  power_ac: { source: 'twin', unit: 'kW', label: 'AC power' },
  temperature: { source: 'twin', unit: 'degC', label: 'Inverter temperature' },
  voltage_dc: { source: 'twin', unit: 'V', label: 'DC voltage' },
  current_dc: { source: 'twin', unit: 'A', label: 'DC current' },
  // Measured telemetry (no prediction channel)
  energy_daily: { source: 'measurements', unit: 'kWh', label: 'Daily energy' },
  irradiance_poa: { source: 'measurements', unit: 'W/m2', label: 'POA irradiance' },
  irradiance_ghi: { source: 'measurements', unit: 'W/m2', label: 'GHI irradiance' },
  soiling_ratio: { source: 'measurements', unit: 'ratio', label: 'Soiling ratio' },
  temp_ambient: { source: 'measurements', unit: 'degC', label: 'Ambient temperature' },
  temp_module: { source: 'measurements', unit: 'degC', label: 'Module temperature' },
  power_dc: { source: 'measurements', unit: 'kW', label: 'DC power' },
};

export function chartMetricMeta(metric: string): ChartMetricMeta | null {
  return (CHART_METRICS as Record<string, ChartMetricMeta>)[metric] ?? null;
}
