/**
 * Default grid sizes per widget type (react-grid-layout 12-col units).
 * Pure module: server-side report tools need these sizes, and the widget
 * registry (a 'use client' module with component imports) cannot be
 * imported from server code. Keep in sync with registry.tsx.
 */
export const WIDGET_DEFAULT_LAYOUTS: Record<string, { w: number; h: number }> = {
  'pv.expected_vs_measured': { w: 8, h: 6 },
  'pv.loss_waterfall': { w: 6, h: 6 },
  'pv.residual_heatmap': { w: 6, h: 8 },
  'pv.soiling_ranking': { w: 6, h: 8 },
  'pv.string_health': { w: 6, h: 6 },
  'bess.soh_history': { w: 8, h: 6 },
  'bess.dispatch': { w: 8, h: 6 },
  'bess.warranty_status': { w: 4, h: 5 },
  'kpi.single_metric': { w: 3, h: 3 },
  'chart.timeseries': { w: 8, h: 6 },
  'contracts.status': { w: 6, h: 5 },
};

export function widgetDefaultLayout(type: string): { w: number; h: number } {
  return WIDGET_DEFAULT_LAYOUTS[type] ?? { w: 6, h: 5 };
}
