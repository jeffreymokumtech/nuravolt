/**
 * Data fetching hook for BESS (Battery Energy Storage System) analytics.
 * Fetches from /api/bess/plants/{plantId}/ endpoints.
 *
 * This file also owns the shaping layer for the three-lane revenue ledger
 * served by /api/bess/plants/{plantId}/revenue. The shapers are pure and
 * exported so both the Revenue Cockpit and the tests can use them without a
 * renderer.
 *
 * THE THREE LANES ARE NEVER SUMMED. There is deliberately no function here
 * that adds a measured number to a declared number to a benchmark number:
 * a battery discharging at 14:00 could be running arbitrage, delivering an
 * accepted balancing-mechanism offer, or answering a frequency event, and the
 * power trace is identical, so adding the lanes would triple-count the same
 * megawatt hour. Cross-lane arithmetic is confined to the one derived KPI the
 * API itself supplies: the gap versus the perfect-foresight benchmark.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  LANE_ORDER,
  LANE_STYLE,
  formatMoney,
  serviceMeta,
  serviceValue,
  servicesInLane,
  type RevenueLane,
} from '@/lib/config/bessServices';
import type {
  BessAssetInfo,
  BessAssetOverviewResponse,
  WarrantyStatusResponse,
  CyclingMetricsResponse,
  DispatchScheduleResponse,
  WarrantyViolationsResponse,
  UseBESSDataReturn,
} from '@/types/bess';

interface UseBESSDataOptions {
  autoLoad?: boolean;
  defaultAssetId?: string;
}

export function useBESSData(
  plantId: string,
  options: UseBESSDataOptions = {}
): UseBESSDataReturn {
  const { autoLoad = true, defaultAssetId } = options;
  const basePath = `/api/bess/plants/${plantId}`;

  // State
  const [assets, setAssets] = useState<BessAssetInfo[] | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(defaultAssetId || null);
  const [assetOverview, setAssetOverview] = useState<BessAssetOverviewResponse | null>(null);
  const [warrantyStatus, setWarrantyStatus] = useState<WarrantyStatusResponse | null>(null);
  const [cyclingMetrics, setCyclingMetrics] = useState<CyclingMetricsResponse | null>(null);
  const [dispatchSchedule, setDispatchSchedule] = useState<DispatchScheduleResponse | null>(null);
  const [violations, setViolations] = useState<WarrantyViolationsResponse | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Derived state
  const selectedAsset = useMemo(() => {
    if (!assets || !selectedAssetId) return null;
    return assets.find(a => a.id === selectedAssetId) || null;
  }, [assets, selectedAssetId]);

  // Fetch list of assets for plant
  const fetchAssets = useCallback(async () => {
    try {
      const response = await fetch(basePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch assets: ${response.statusText}`);
      }
      const data = await response.json();
      setAssets(data.assets || []);

      // Auto-select first asset if none selected
      if (!selectedAssetId && data.assets?.length > 0) {
        setSelectedAssetId(data.assets[0].id);
      }

      return data.assets;
    } catch (err) {
      console.error('Error fetching BESS assets:', err);
      throw err;
    }
  }, [basePath, selectedAssetId]);

  // Fetch asset overview (includes warranty, cycling, violations summary)
  const fetchAssetOverview = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(`${basePath}/assets/${assetId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch asset overview: ${response.statusText}`);
      }
      const data: BessAssetOverviewResponse = await response.json();
      setAssetOverview(data);
      return data;
    } catch (err) {
      console.error('Error fetching asset overview:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch detailed warranty status
  const fetchWarrantyStatus = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(`${basePath}/assets/${assetId}/warranty`);
      if (!response.ok) {
        throw new Error(`Failed to fetch warranty status: ${response.statusText}`);
      }
      const data: WarrantyStatusResponse = await response.json();
      setWarrantyStatus(data);
      return data;
    } catch (err) {
      console.error('Error fetching warranty status:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch cycling metrics
  const fetchCyclingMetrics = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(`${basePath}/assets/${assetId}/cycling`);
      if (!response.ok) {
        throw new Error(`Failed to fetch cycling metrics: ${response.statusText}`);
      }
      const data: CyclingMetricsResponse = await response.json();
      setCyclingMetrics(data);
      return data;
    } catch (err) {
      console.error('Error fetching cycling metrics:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch dispatch schedule
  const fetchDispatchSchedule = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(`${basePath}/assets/${assetId}/dispatch`);
      if (!response.ok) {
        throw new Error(`Failed to fetch dispatch schedule: ${response.statusText}`);
      }
      const data: DispatchScheduleResponse = await response.json();
      setDispatchSchedule(data);
      return data;
    } catch (err) {
      console.error('Error fetching dispatch schedule:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch violations
  const fetchViolations = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(`${basePath}/assets/${assetId}/warranty/violations`);
      if (!response.ok) {
        throw new Error(`Failed to fetch violations: ${response.statusText}`);
      }
      const data: WarrantyViolationsResponse = await response.json();
      setViolations(data);
      return data;
    } catch (err) {
      console.error('Error fetching violations:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch all data for current asset
  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // First fetch assets list
      const assetsList = await fetchAssets();

      // Determine which asset to fetch details for
      const targetAssetId = selectedAssetId || assetsList?.[0]?.id;

      if (!targetAssetId) {
        setIsLoading(false);
        return;
      }

      // Fetch all data in parallel
      await Promise.all([
        fetchAssetOverview(targetAssetId),
        fetchWarrantyStatus(targetAssetId),
        fetchCyclingMetrics(targetAssetId),
        fetchDispatchSchedule(targetAssetId),
        fetchViolations(targetAssetId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [
    fetchAssets,
    fetchAssetOverview,
    fetchWarrantyStatus,
    fetchCyclingMetrics,
    fetchDispatchSchedule,
    fetchViolations,
    selectedAssetId,
  ]);

  // Select a different asset
  const selectAsset = useCallback(async (assetId: string) => {
    setSelectedAssetId(assetId);
    setIsLoading(true);
    setError(null);

    try {
      await Promise.all([
        fetchAssetOverview(assetId),
        fetchWarrantyStatus(assetId),
        fetchCyclingMetrics(assetId),
        fetchDispatchSchedule(assetId),
        fetchViolations(assetId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [
    fetchAssetOverview,
    fetchWarrantyStatus,
    fetchCyclingMetrics,
    fetchDispatchSchedule,
    fetchViolations,
  ]);

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad && plantId) {
      refetch();
    }
  }, [autoLoad, plantId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    assets,
    selectedAsset,
    assetOverview,
    warrantyStatus,
    cyclingMetrics,
    dispatchSchedule,
    violations,
    isLoading,
    error,
    refetch,
    selectAsset,
  };
}

// ===========================================================================
// Three-lane revenue ledger
// ===========================================================================

export interface RevenueProvenanceEntry {
  lane: RevenueLane;
  model_version: string;
  source: string;
  caption: string;
}

export interface RevenueLaneBlock {
  /** One row per day, keyed by metric. Never merged with another lane's rows. */
  series: Array<Record<string, number | string>>;
  /** Per-metric window totals (sums for money, means for ratios). */
  totals: Record<string, number>;
  metrics: string[];
  notes: string[];
}

export interface RevenueKpis {
  measured_energy_value: number | null;
  measured_charge_cost: number | null;
  measured_bm_settled: number | null;
  declared_contracted: number | null;
  benchmark_arbitrage_ceiling: number | null;
  benchmark_ancillary: number | null;
  realized_net: number | null;
  revenue_gap: number | null;
  capture_ratio: number | null;
  capture_ratio_caption: string | null;
}

export type RevenueCoverage = 'ledger' | 'dispatch_only' | 'fixture' | 'not_yet_enabled';

export interface RevenueLedger {
  plant: { slug: string | null; name: string | null; ratedMw: number | null; energyCapacityMwh: number | null };
  window: { from: string | null; to: string | null; days: number | null };
  ledger: Record<RevenueLane, RevenueLaneBlock>;
  provenance: Record<string, RevenueProvenanceEntry>;
  kpis: RevenueKpis;
  /** Settlement currency of THIS ledger. Never assumed, never hardcoded. */
  currency: string;
  /** Settlement period length. GB settles in 30 minute periods, Iberia in 60. */
  resolutionMinutes: number | null;
  /** Derived from resolutionMinutes, so nothing downstream assumes 24 points. */
  periodsPerDay: number | null;
  zone: string | null;
  priceSource: string | null;
  notes: string[];
  coverage: RevenueCoverage;
  generatedAt: string | null;
}

function emptyLaneBlock(): RevenueLaneBlock {
  return { series: [], totals: {}, metrics: [], notes: [] };
}

/**
 * Settlement periods in one day for a given period length. Returns null rather
 * than guessing: a GB battery settles 48 half-hourly periods and an Iberian one
 * settles 24 hourly periods, so a hardcoded 24 is wrong half the time.
 */
export function periodsPerDay(resolutionMinutes: number | null | undefined): number | null {
  const minutes = Number(resolutionMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (1440 % minutes !== 0) return null;
  return 1440 / minutes;
}

function coerceLaneBlock(raw: any): RevenueLaneBlock {
  if (!raw || typeof raw !== 'object') return emptyLaneBlock();
  const series = Array.isArray(raw.series) ? raw.series : [];
  const totals: Record<string, number> = {};
  for (const [metric, value] of Object.entries(raw.totals ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) totals[metric] = value;
  }
  const metrics = Array.isArray(raw.metrics)
    ? raw.metrics.map(String)
    : Array.from(
        new Set<string>(series.flatMap((d: any) => Object.keys(d ?? {})))
      ).filter((k) => k !== 'date');
  return {
    series,
    totals,
    metrics,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
  };
}

/** Normalise the revenue route payload. Currency and resolution come from the
 * payload; there is no fallback that invents either. */
export function normalizeRevenuePayload(json: any): RevenueLedger {
  const rawLedger = json?.ledger ?? {};
  const ledger = {
    measured: coerceLaneBlock(rawLedger.measured),
    declared: coerceLaneBlock(rawLedger.declared),
    benchmark: coerceLaneBlock(rawLedger.benchmark),
  } as Record<RevenueLane, RevenueLaneBlock>;

  const provenance: Record<string, RevenueProvenanceEntry> = {};
  for (const [metric, entry] of Object.entries(json?.provenance ?? {})) {
    const e = entry as any;
    if (!e || typeof e !== 'object') continue;
    provenance[metric] = {
      lane: e.lane,
      model_version: String(e.model_version ?? ''),
      source: String(e.source ?? ''),
      caption: String(e.caption ?? ''),
    };
  }

  const resolution = Number.isFinite(Number(json?.resolution_minutes))
    ? Number(json.resolution_minutes)
    : null;

  const k = json?.kpis ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    plant: {
      slug: json?.plant?.slug ?? null,
      name: json?.plant?.name ?? null,
      ratedMw: num(json?.plant?.rated_mw),
      energyCapacityMwh: num(json?.plant?.energy_capacity_mwh),
    },
    window: {
      from: json?.window?.from ?? null,
      to: json?.window?.to ?? null,
      days: num(json?.window?.days),
    },
    ledger,
    provenance,
    kpis: {
      measured_energy_value: num(k.measured_energy_value),
      measured_charge_cost: num(k.measured_charge_cost),
      measured_bm_settled: num(k.measured_bm_settled),
      declared_contracted: num(k.declared_contracted),
      benchmark_arbitrage_ceiling: num(k.benchmark_arbitrage_ceiling),
      benchmark_ancillary: num(k.benchmark_ancillary),
      realized_net: num(k.realized_net),
      revenue_gap: num(k.revenue_gap),
      capture_ratio: num(k.capture_ratio),
      capture_ratio_caption: k.capture_ratio_caption ?? null,
    },
    // An absent currency renders unlabelled numbers rather than claiming a
    // currency the ledger never stated.
    currency: typeof json?.currency === 'string' && json.currency ? json.currency : '',
    resolutionMinutes: resolution,
    periodsPerDay: periodsPerDay(resolution),
    zone: json?.zone ?? null,
    priceSource: json?.price_source ?? null,
    notes: Array.isArray(json?.notes) ? json.notes.map(String) : [],
    coverage: (json?.coverage ?? 'not_yet_enabled') as RevenueCoverage,
    generatedAt: json?.generated_at ?? null,
  };
}

// ── Metric vocabulary ──────────────────────────────────────────────────────

export type MetricClass = 'revenue' | 'cost' | 'quantity' | 'ratio' | 'derived';

/**
 * What kind of number a ledger metric is. This drives both formatting and, more
 * importantly, what may be stacked: only `revenue` metrics stack, and only
 * inside their own lane. A charging cost is not revenue, a ratio is not money,
 * and the realized-net / gap pair is derived from the benchmark rather than
 * being another earnings line, so none of them join a stack.
 */
export function metricClass(metric: string): MetricClass {
  if (/_ratio$/.test(metric)) return 'ratio';
  if (/_mwh$/.test(metric)) return 'quantity';
  if (/_cost$/.test(metric)) return 'cost';
  if (metric === 'revenue_gap' || metric === 'revenue_realized_net') return 'derived';
  return 'revenue';
}

const METRIC_LABELS: Record<string, string> = {
  revenue_gap: 'Revenue gap versus benchmark',
  revenue_realized_net: 'Realized net',
  capture_ratio: 'Capture rate',
  revenue_measured_energy: 'Discharge energy value',
  revenue_measured_charge_cost: 'Charging cost',
  revenue_measured_bm: 'Balancing mechanism, settled',
  revenue_benchmark_arbitrage: 'Perfect foresight arbitrage ceiling',
  revenue_benchmark_ancillary: 'Perfect foresight ancillary ceiling',
  revenue_modelled_dispatch_net: 'Modelled dispatch net',
  measured_discharge_mwh: 'Discharge energy',
  measured_charge_mwh: 'Charging energy',
};

const LANE_PREFIX = /^(measured|declared|benchmark)_/;

/** Human label for a ledger metric key. */
export function metricLabel(metric: string): string {
  const explicit = METRIC_LABELS[metric];
  if (explicit) return explicit;

  const stripped = metric.replace(/^revenue_/, '').replace(LANE_PREFIX, '');
  const service = serviceMeta(stripped);
  if (service) return service.label;

  const words = stripped.replace(/_/g, ' ').trim();
  const withUnits = words.replace(/\bmwh\b/gi, 'MWh');
  return withUnits.charAt(0).toUpperCase() + withUnits.slice(1);
}

/** Colour for a ledger metric: the shared service palette where the metric maps
 * to a named service, a lane tone otherwise. Keeps the cockpit and the Shams
 * inline chart on one palette. */
export const LANE_TONE: Record<RevenueLane, string> = {
  measured: '#0f766e',
  declared: '#7c3aed',
  benchmark: '#94a3b8',
};

export function metricColor(metric: string, lane: RevenueLane): string {
  const stripped = metric.replace(/^revenue_/, '').replace(LANE_PREFIX, '');
  return serviceMeta(stripped)?.color ?? LANE_TONE[lane];
}

/** Format one metric value in the ledger's own currency and unit. */
export function formatMetric(
  value: number | null | undefined,
  klass: MetricClass,
  currency: string
): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (klass === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (klass === 'quantity') return `${value.toFixed(1)} MWh`;
  const sign = value < 0 ? '-' : '';
  return `${sign}${formatMoney(Math.abs(value), currency)}`;
}

// ── Lane shaping ───────────────────────────────────────────────────────────

export interface LedgerMetricRow {
  metric: string;
  label: string;
  klass: MetricClass;
  lane: RevenueLane;
  color: string;
  /** Window total for this ONE metric. Never a lane total, never a grand total. */
  total: number;
  provenance: RevenueProvenanceEntry | null;
}

const CLASS_ORDER: MetricClass[] = ['revenue', 'derived', 'cost', 'quantity', 'ratio'];

/**
 * The rows of one lane, money first and then the supporting quantities. Each
 * row carries its own window total; nothing here folds the rows together,
 * because a lane can hold a revenue line and a cost line whose netting rule
 * belongs to the pipeline, not to a chart component.
 */
export function laneMetricRows(payload: RevenueLedger, lane: RevenueLane): LedgerMetricRow[] {
  const block = payload.ledger[lane];
  if (!block) return [];
  const metrics = block.metrics.length ? block.metrics : Object.keys(block.totals);
  return metrics
    .map((metric) => ({
      metric,
      label: metricLabel(metric),
      klass: metricClass(metric),
      lane,
      color: metricColor(metric, lane),
      total: block.totals[metric] ?? 0,
      provenance: payload.provenance[metric] ?? null,
    }))
    .sort((a, b) => {
      const byClass = CLASS_ORDER.indexOf(a.klass) - CLASS_ORDER.indexOf(b.klass);
      if (byClass !== 0) return byClass;
      return Math.abs(b.total) - Math.abs(a.total);
    });
}

export interface LedgerChartSeries {
  lane: RevenueLane;
  metric: string;
  label: string;
  color: string;
  /** Aligned to `dates`; null where the lane has no row for that day. */
  data: Array<number | null>;
}

export interface LedgerChart {
  dates: string[];
  series: LedgerChartSeries[];
  lanes: RevenueLane[];
}

/**
 * Daily series for the ledger chart. One series per stackable metric, tagged
 * with its lane so the renderer can stack WITHIN a lane and group ACROSS lanes.
 * The lanes stay three separate columns per day; they are never stacked on top
 * of one another, which is what would make them read as a single total.
 */
export function ledgerChartSeries(payload: RevenueLedger): LedgerChart {
  const dateSet = new Set<string>();
  for (const lane of LANE_ORDER) {
    for (const row of payload.ledger[lane]?.series ?? []) {
      if (typeof row?.date === 'string') dateSet.add(row.date);
    }
  }
  const dates = Array.from(dateSet).sort();
  const index = new Map(dates.map((d, i) => [d, i]));

  const series: LedgerChartSeries[] = [];
  const lanes: RevenueLane[] = [];

  for (const lane of LANE_ORDER) {
    const block = payload.ledger[lane];
    if (!block?.series?.length) continue;
    const stackable = laneMetricRows(payload, lane).filter((r) => r.klass === 'revenue');
    if (!stackable.length) continue;
    lanes.push(lane);
    for (const row of stackable) {
      const data: Array<number | null> = new Array(dates.length).fill(null);
      for (const day of block.series) {
        const i = index.get(String(day.date));
        if (i == null) continue;
        const raw = day[row.metric];
        if (typeof raw === 'number' && Number.isFinite(raw)) data[i] = raw;
      }
      series.push({ lane, metric: row.metric, label: row.label, color: row.color, data });
    }
  }
  return { dates, series, lanes };
}

// ===========================================================================
// Per-service daily rows (Shams inline chart and the by-service chat card)
//
// These live here rather than beside the components because the project's
// tsconfig keeps `jsx: preserve`, so a .tsx module cannot be imported by the
// test runner. Keeping the arithmetic in a .ts module is what lets the
// never-sum-the-lanes rule be tested at all.
// ===========================================================================

export interface RevenueDay {
  date: string;
  [service: string]: number | string;
}

export interface LaneSegment {
  base: string;
  label: string;
  short: string;
  color: string;
  value: number;
}

export interface LaneColumn {
  lane: RevenueLane;
  segments: LaneSegment[];
  /** Sum of this ONE lane's services. Never combined with another lane. */
  subtotal: number;
}

/**
 * Split one daily row into its lane columns. Values are read through
 * serviceValue, so a legacy `_gbp` fixture column, a suffix-free ledger row and
 * a euro-zone `_eur` column all shape identically. That is why one component
 * serves GB and Iberian plants.
 */
export function laneColumnsForDay(day: Record<string, unknown> | null | undefined): LaneColumn[] {
  if (!day) return [];
  const columns: LaneColumn[] = [];
  for (const lane of LANE_ORDER) {
    const segments: LaneSegment[] = [];
    let subtotal = 0;
    for (const svc of servicesInLane(lane)) {
      const value = serviceValue(day, svc.base);
      if (!(value > 0)) continue;
      segments.push({
        base: svc.base,
        label: svc.label,
        short: svc.short,
        color: svc.color,
        value,
      });
      subtotal += value;
    }
    if (segments.length) columns.push({ lane, segments, subtotal });
  }
  return columns;
}

/** Which lanes carry any value across the window, in canonical order. */
export function lanesPresent(series: RevenueDay[]): RevenueLane[] {
  const seen = new Set<RevenueLane>();
  for (const day of series) for (const col of laneColumnsForDay(day)) seen.add(col.lane);
  return LANE_ORDER.filter((lane) => seen.has(lane));
}

/**
 * Window subtotal per lane, kept in three separate fields. There is no
 * combined field, and no caller may add these three numbers together.
 */
export function laneSubtotals(series: RevenueDay[]): Record<RevenueLane, number> {
  const totals: Record<RevenueLane, number> = { measured: 0, declared: 0, benchmark: 0 };
  for (const day of series) {
    for (const col of laneColumnsForDay(day)) totals[col.lane] += col.subtotal;
  }
  return totals;
}

/** Y scale: the tallest single lane column in the window, never a day total. */
export function laneScaleMax(series: RevenueDay[]): number {
  let max = 0;
  for (const day of series) {
    for (const col of laneColumnsForDay(day)) {
      if (col.subtotal > max) max = col.subtotal;
    }
  }
  return max > 0 ? max : 1;
}

/**
 * Stripe geometry for the hatched lane. Shared by the inline SVG bars, their
 * legend swatch and the Revenue Cockpit's ECharts decal, so every surface
 * hatches the declared lane the same way.
 */
export const HATCH = { period: 6, on: 2.4 };

/**
 * SVG paint props for a lane's marks, derived only from LANE_STYLE. The legend
 * swatch runs through this same function, so the marks and the legend cannot
 * drift apart.
 */
export function laneMarkProps(lane: RevenueLane, color: string, patternId: string) {
  const style = LANE_STYLE[lane];
  if (style.pattern === 'hatch') {
    return { fill: `url(#${patternId})`, opacity: style.opacity } as const;
  }
  if (style.pattern === 'outline') {
    return {
      fill: color,
      fillOpacity: 0.16,
      stroke: color,
      strokeWidth: 1.25,
      vectorEffect: 'non-scaling-stroke',
      opacity: style.opacity,
    } as const;
  }
  return { fill: color, opacity: style.opacity } as const;
}

export interface LaneServiceRow {
  base: string;
  label: string;
  color: string;
  total: number;
  /** Share of this lane's subtotal, recomputed. Not a cross-lane share. */
  shareInLanePct: number;
}

export interface LaneServiceGroup {
  lane: RevenueLane;
  rows: LaneServiceRow[];
  /** Sum of this ONE lane's services. */
  subtotal: number;
}

/**
 * Group per-service window totals into lanes. Returns one entry per lane that
 * carries value, each with its own subtotal and shares recomputed within the
 * lane. There is no combined field: a caller cannot render a grand total from
 * this shape without writing the addition itself, which is the point.
 */
export function groupServiceTotalsByLane(
  services: Record<string, { total: number; share_pct?: number }> | null | undefined
): LaneServiceGroup[] {
  if (!services) return [];
  const groups: LaneServiceGroup[] = [];
  for (const lane of LANE_ORDER) {
    const present = servicesInLane(lane)
      .map((meta) => ({ meta, total: Number(services[meta.base]?.total) }))
      .filter((r) => Number.isFinite(r.total) && r.total > 0)
      .sort((a, b) => b.total - a.total);
    if (!present.length) continue;
    const subtotal = present.reduce((sum, r) => sum + r.total, 0);
    groups.push({
      lane,
      subtotal,
      rows: present.map(({ meta, total }) => ({
        base: meta.base,
        label: meta.label,
        color: meta.color,
        total,
        shareInLanePct: subtotal > 0 ? (total / subtotal) * 100 : 0,
      })),
    });
  }
  return groups;
}

// ── Fetch hook ─────────────────────────────────────────────────────────────

export interface UseBessRevenueReturn {
  data: RevenueLedger | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetch the three-lane revenue ledger for one plant. Kept separate from
 * useBESSData so the asset pages do not pay for a revenue query they never
 * render.
 */
export function useBessRevenue(
  plantId: string,
  options: { days?: number; enabled?: boolean } = {}
): UseBessRevenueReturn {
  const { days = 30, enabled = true } = options;
  const [data, setData] = useState<RevenueLedger | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !plantId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetch(`/api/bess/plants/${encodeURIComponent(plantId)}/revenue?days=${days}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setData(normalizeRevenuePayload(json));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error('Revenue fetch failed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [plantId, days, enabled, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, isLoading, error, refetch };
}

export default useBESSData;
