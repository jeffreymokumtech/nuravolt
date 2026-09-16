/**
 * Types for interactive dashboards (Reporter feature).
 *
 * A Dashboard is a saved layout of widgets over a configurable scope
 * (plants, devices, time range). Widgets are identified by type IDs
 * (`pv.expected_vs_measured`, `bess.soh_history`, …) and each carries
 * its own `config` JSON that may override the dashboard-level scope.
 */

/** Supported preset time ranges — mirrors ReportPeriod values for consistency. */
export type DateRangePreset =
  | 'last_7d'
  | 'last_14d'
  | 'last_30d'
  | 'last_month'
  | 'last_quarter'
  | 'year_to_date'
  | 'custom';

export interface DashboardScope {
  /** Plant slugs or UUIDs. */
  plantIds: string[];
  /** Device external ids, e.g. "INV 01.057", "BESS-01". */
  deviceIds: string[];
  range: DateRangePreset;
  /** Only set when range === 'custom'. ISO strings. */
  from?: string | null;
  to?: string | null;
}

/**
 * Per-widget configuration. Any field that is also in DashboardScope acts
 * as an override for that specific widget (scope resolution: widget > dashboard).
 */
export interface WidgetConfig {
  title?: string;
  plantIds?: string[];
  deviceIds?: string[];
  /** Range preset override. */
  range?: DateRangePreset;
  from?: string | null;
  to?: string | null;
  /** Arbitrary widget-specific options (metric key, colour, etc.). */
  options?: Record<string, unknown>;
}

/** Layout entry stored in the Dashboard.widgets JSON column. */
export interface DashboardWidget {
  /** Stable id within the dashboard (nanoid). */
  id: string;
  /** Widget type — key into the registry. */
  type: string;
  /** react-grid-layout coords. */
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfig;
}

export interface Dashboard {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  owner_id: string | null;
  organization_id: string | null;
  scope_plant_ids: string[];
  scope_device_ids: string[];
  default_range: DateRangePreset;
  default_from: string | null;
  default_to: string | null;
  widgets: DashboardWidget[];
  share_token: string | null;
  share_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the effective scope for a widget, merging widget-level overrides
 * over dashboard-level defaults. Used by every widget when fetching data.
 */
export function resolveWidgetScope(
  dashboardScope: DashboardScope,
  widget: DashboardWidget,
): DashboardScope {
  const c = widget.config;
  return {
    plantIds: c.plantIds?.length ? c.plantIds : dashboardScope.plantIds,
    deviceIds: c.deviceIds?.length ? c.deviceIds : dashboardScope.deviceIds,
    range: c.range ?? dashboardScope.range,
    from: c.from ?? dashboardScope.from ?? null,
    to: c.to ?? dashboardScope.to ?? null,
  };
}

/**
 * Convert a DateRangePreset + optional custom bounds into concrete from/to
 * ISO date strings. Used by widgets when calling range-based APIs.
 */
export function expandDateRange(
  range: DateRangePreset,
  customFrom?: string | null,
  customTo?: string | null,
): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);

  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  switch (range) {
    case 'last_7d':
      return { from: daysAgo(7), to };
    case 'last_14d':
      return { from: daysAgo(14), to };
    case 'last_30d':
      return { from: daysAgo(30), to };
    case 'last_month': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
    }
    case 'last_quarter': {
      const q = Math.floor(now.getMonth() / 3) - 1;
      const year = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const startMonth = ((q + 4) % 4) * 3;
      const first = new Date(year, startMonth, 1);
      const last = new Date(year, startMonth + 3, 0);
      return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
    }
    case 'year_to_date': {
      const first = new Date(now.getFullYear(), 0, 1);
      return { from: first.toISOString().slice(0, 10), to };
    }
    case 'custom':
      return {
        from: customFrom || daysAgo(30),
        to: customTo || to,
      };
  }
}
