'use client';

import type { ComponentType } from 'react';
import type { DashboardScope, DashboardWidget, WidgetConfig } from '@/types/dashboard';
import PvExpectedVsMeasured from './PvExpectedVsMeasured';
import PvLossWaterfall from './PvLossWaterfall';
import PvResidualHeatmap from './PvResidualHeatmap';
import BessSohHistory from './BessSohHistory';
import BessDispatch from './BessDispatch';
import BessWarrantyStatus from './BessWarrantyStatus';
import KpiSingleMetric from './KpiSingleMetric';
import ChartTimeseries from './ChartTimeseries';
import ContractStatus from './ContractStatus';
import PvSoilingRanking from './PvSoilingRanking';
import PvStringHealth from './PvStringHealth';

export interface WidgetProps {
  scope: DashboardScope;
  widget: DashboardWidget;
  onConfigChange?: (config: WidgetConfig) => void;
  readOnly?: boolean;
}

export interface WidgetTypeMeta {
  id: string;
  label: string;
  description: string;
  /** Rough intended grid size (react-grid-layout 12-col units). */
  defaultLayout: { w: number; h: number };
  category: 'PV' | 'BESS' | 'Portfolio' | 'KPI';
  component: ComponentType<WidgetProps>;
}

/**
 * Central registry of widget types. Adding a widget = one entry here + one
 * file in widgets/. Keep the component prop contract stable ({ scope, widget,
 * onConfigChange, readOnly }) so widgets stay swappable.
 */
export const WIDGET_TYPES: Record<string, WidgetTypeMeta> = {
  'chart.timeseries': {
    id: 'chart.timeseries',
    label: 'Metric Chart',
    description:
      'Any metric over time: twin power/temperature (predicted vs actual), daily energy, irradiance, soiling ratio. The chart Shams adds from chat.',
    defaultLayout: { w: 8, h: 6 },
    category: 'PV',
    component: ChartTimeseries,
  },
  'pv.expected_vs_measured': {
    id: 'pv.expected_vs_measured',
    label: 'Expected vs Measured Power',
    description:
      'Digital-twin predicted vs actual power (daily). Pick a plant or inverter.',
    defaultLayout: { w: 8, h: 6 },
    category: 'PV',
    component: PvExpectedVsMeasured,
  },
  'pv.loss_waterfall': {
    id: 'pv.loss_waterfall',
    label: 'Loss Disaggregation Waterfall',
    description:
      'Reference → net energy cascade: soiling, temperature, spectral, inverter, wiring, degradation.',
    defaultLayout: { w: 6, h: 6 },
    category: 'PV',
    component: PvLossWaterfall,
  },
  'pv.residual_heatmap': {
    id: 'pv.residual_heatmap',
    label: 'Fleet Loss Ranking',
    description: 'Top-40 inverters sorted by power loss % over the selected window.',
    defaultLayout: { w: 6, h: 8 },
    category: 'PV',
    component: PvResidualHeatmap,
  },
  'pv.soiling_ranking': {
    id: 'pv.soiling_ranking',
    label: 'Soiling Ranking',
    description:
      'Per-inverter soiling ratio, dirtiest first, with the fleet mean and cleaning recommendation.',
    defaultLayout: { w: 6, h: 8 },
    category: 'PV',
    component: PvSoilingRanking,
  },
  'pv.string_health': {
    id: 'pv.string_health',
    label: 'String Health',
    description:
      'String and MPPT status rollup with the current string anomalies (open circuit, mismatch, degradation).',
    defaultLayout: { w: 6, h: 6 },
    category: 'PV',
    component: PvStringHealth,
  },
  'bess.soh_history': {
    id: 'bess.soh_history',
    label: 'BESS State-of-Health History',
    description: 'Capacity degradation curve vs warranty threshold. Pick a BESS asset.',
    defaultLayout: { w: 8, h: 6 },
    category: 'BESS',
    component: BessSohHistory,
  },
  'bess.dispatch': {
    id: 'bess.dispatch',
    label: 'BESS Dispatch Schedule',
    description: 'Charge/discharge plan, SoC, and price forecast for the current day.',
    defaultLayout: { w: 8, h: 6 },
    category: 'BESS',
    component: BessDispatch,
  },
  'bess.warranty_status': {
    id: 'bess.warranty_status',
    label: 'BESS Warranty Status',
    description: 'Health score, margin to threshold, cycles used, years remaining.',
    defaultLayout: { w: 4, h: 5 },
    category: 'BESS',
    component: BessWarrantyStatus,
  },
  'kpi.single_metric': {
    id: 'kpi.single_metric',
    label: 'Single KPI Tile',
    description: 'One big number, pick a metric (loss %, avg power, …) and a plant.',
    defaultLayout: { w: 3, h: 3 },
    category: 'KPI',
    component: KpiSingleMetric,
  },
  'contracts.status': {
    id: 'contracts.status',
    label: 'Contract Status',
    description:
      'Every contract in scope (PPA, warranties, O&M SLA) with its live obligation status: on track, at risk, or breach.',
    defaultLayout: { w: 6, h: 5 },
    category: 'Portfolio',
    component: ContractStatus,
  },
};

export const WIDGET_LIST = Object.values(WIDGET_TYPES);
