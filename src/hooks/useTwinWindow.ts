'use client';

import { useEffect, useMemo, useState } from 'react';
import { bucketSeries, type Bucket } from '@/utils/timeBuckets';
import { formatPlantTime, toUtcDate } from '@/lib/plantTime';

/**
 * Windowed digital-twin data (expected vs actual power) for a plant, shared
 * by the demo/showcase overview and the authenticated dashboard overview.
 *
 * Default surfaces go through /api/digitaltwin/[plantId]/summary (DB-first,
 * fixture fallback — both emit the same contract); showcase surfaces window
 * their own fixture tree client-side because the API can't see it.
 */

export interface TwinWindowRow {
  date: string;
  predicted_kw: number | null;
  actual_kw: number | null;
  residual_kw: number | null;
  loss_pct: number | null;
  predicted_mwh: number | null;
  actual_mwh: number | null;
}

export interface TwinWindowResponse {
  _source?: string;
  _resolution?: string;
  /** Latest twin model version within the returned window. */
  modelVersion?: string | null;
  /** All twin model versions the plant carries, flagship (non-physics) first. */
  modelVersions?: string[];
  metadata?: { data_start?: string | null; data_end?: string | null };
  daily: TwinWindowRow[];
  summary: {
    total_predicted_mwh: number;
    total_actual_mwh: number;
    total_loss_mwh: number;
    avg_loss_pct: number;
    measured_days: number;
  };
}

export type TwinResolution = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface TwinWindowArgs {
  from: string;
  to: string;
  spanDays: number;
  bucket: Bucket | 'hour';
  bucketOverride: Bucket | 'hour' | null;
}

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useFetchJson<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({
    data: null,
    loading: Boolean(url),
    error: null,
  });
  useEffect(() => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState({ data: null, loading: true, error: null });
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as T;
      })
      .then((data) => alive && setState({ data, loading: false, error: null }))
      .catch((e) => alive && setState({ data: null, loading: false, error: String(e) }));
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}

export function twinResolutionFor(args: TwinWindowArgs): TwinResolution {
  // Explicit hourly pick wins (available up to the route's 120-day clamp);
  // short windows get the intraday shape automatically.
  if (args.bucketOverride === 'hour') return 'hourly';
  if (args.spanDays <= 14 && !args.bucketOverride) return 'hourly';
  if (args.bucket === 'week') return 'weekly';
  if (args.bucket === 'month') return 'monthly';
  return 'daily';
}

/** Client-side mirror of the summary route's fixture windowing, for surfaces
 * with a non-default dataRoot (showcase) whose fixtures the API can't see. */
function windowHistoryClient(
  history: any,
  args: TwinWindowArgs,
  resolution: TwinResolution
): TwinWindowResponse | null {
  if (!history?.daily?.length) return null;
  const dataEnd: string = history.metadata?.data_end ?? '';
  let fromKey = args.from;
  let toKey = args.to;
  if (dataEnd && dataEnd < fromKey) {
    toKey = dataEnd;
    const end = new Date(dataEnd + 'T00:00:00Z');
    fromKey = new Date(end.getTime() - args.spanDays * 86400000).toISOString().slice(0, 10);
  }

  let rows: TwinWindowRow[] = [];
  let effResolution = resolution;
  if (resolution === 'hourly') {
    rows = (history.recent ?? [])
      .filter((r: any) => {
        const day = String(r.timestamp).slice(0, 10);
        return day >= fromKey && day <= toKey;
      })
      .map((r: any) => ({
        date: r.timestamp,
        predicted_kw: r.predicted_kw ?? null,
        actual_kw: r.actual_kw ?? null,
        residual_kw: r.residual_kw ?? null,
        loss_pct:
          r.predicted_kw > 0 ? ((r.predicted_kw - r.actual_kw) / r.predicted_kw) * 100 : null,
        predicted_mwh: r.predicted_kw != null ? (r.predicted_kw * 3) / 1000 : null,
        actual_mwh: r.actual_kw != null ? (r.actual_kw * 3) / 1000 : null,
      }));
  }
  if (rows.length === 0) {
    // Window predates the intraday tail — honest downgrade to daily.
    if (resolution === 'hourly') effResolution = 'daily';
    rows = (history.daily ?? []).filter((r: any) => r.date >= fromKey && r.date <= toKey);
  }
  if (rows.length === 0) return null;

  const measured = rows.filter((r) => r.actual_mwh != null);
  const totalPred = measured.reduce((s, r) => s + (r.predicted_mwh ?? 0), 0);
  const totalAct = measured.reduce((s, r) => s + (r.actual_mwh ?? 0), 0);

  let series = rows;
  if (resolution === 'weekly' || resolution === 'monthly') {
    series = bucketSeries(
      rows,
      (r) => r.date.slice(0, 10),
      (r) => ({
        predicted_mwh: r.predicted_mwh,
        actual_mwh: r.actual_mwh,
        predicted_kw: r.predicted_kw,
        actual_kw: r.actual_kw,
      }),
      {
        bucket: resolution === 'weekly' ? 'week' : 'month',
        reduce: 'mean',
        reduceByField: { predicted_mwh: 'sum', actual_mwh: 'sum' },
      }
    ).map((b) => {
      const pred = b.values.predicted_mwh ?? null;
      const act = b.values.actual_mwh ?? null;
      return {
        date: b.date,
        predicted_kw: b.values.predicted_kw ?? null,
        actual_kw: b.values.actual_kw ?? null,
        residual_kw:
          b.values.actual_kw != null && b.values.predicted_kw != null
            ? b.values.actual_kw - b.values.predicted_kw
            : null,
        loss_pct: pred && pred > 0 && act != null ? ((pred - act) / pred) * 100 : null,
        predicted_mwh: pred,
        actual_mwh: act,
      };
    });
  }

  // The residual archives ARE the trained hybrid twin; synth extrapolation is
  // physics-shaped. Label accordingly so showcase plants read honestly.
  const mv = String(history.metadata?.source ?? '').startsWith('synth')
    ? 'physics-v1'
    : 'hybrid-catboost-v1';
  return {
    _source: 'json-client',
    _resolution: effResolution,
    modelVersion: mv,
    modelVersions: [mv],
    metadata: { data_start: history.metadata?.data_start, data_end: dataEnd },
    daily: series,
    summary: {
      total_predicted_mwh: totalPred,
      total_actual_mwh: totalAct,
      total_loss_mwh: totalPred - totalAct,
      avg_loss_pct: totalPred > 0 ? ((totalPred - totalAct) / totalPred) * 100 : 0,
      measured_days: measured.length,
    },
  };
}

/** Pass null args to skip fetching. `dataRoot` defaults to '/data' (API path). */
export function useTwinWindow(
  plantId: string,
  dataRoot: string,
  args: TwinWindowArgs | null
): FetchState<TwinWindowResponse> {
  const isShowcase = dataRoot !== '/data';
  const resolution = args ? twinResolutionFor(args) : 'daily';
  const apiUrl =
    args && !isShowcase
      ? `/api/digitaltwin/${plantId}/summary?from=${args.from}&to=${args.to}&resolution=${resolution}`
      : null;
  const api = useFetchJson<TwinWindowResponse>(apiUrl);
  const historyFile = useFetchJson<any>(
    isShowcase && args ? `${dataRoot}/digitaltwin/${plantId}/plant_power_history.json` : null
  );
  const clientData = useMemo(
    () => (isShowcase && args && historyFile.data ? windowHistoryClient(historyFile.data, args, resolution) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isShowcase, historyFile.data, args?.from, args?.to, args?.bucket, args?.bucketOverride, resolution]
  );
  if (isShowcase) {
    return { data: clientData, loading: historyFile.loading, error: historyFile.error };
  }
  const empty = api.data && (!api.data.daily || api.data.daily.length === 0);
  return { data: empty ? null : api.data, loading: api.loading, error: api.error };
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TwinChartSeries {
  expected: (number | null)[];
  actual: (number | null)[];
  xLabels: string[];
  xTooltipLabels: string[];
  yLabels: string[];
  formatValue: (v: number) => string;
}

export function buildTwinSeries(
  resp: TwinWindowResponse | null,
  plantTz?: string | null,
): TwinChartSeries | null {
  const rows = resp?.daily;
  if (!rows?.length) return null;
  const resolution = resp?._resolution ?? 'daily';
  // Week/month buckets read as energy (MWh sums); day/hourly stay in kW.
  const energyMode = resolution === 'weekly' || resolution === 'monthly';

  const expected = rows.map((r) => (energyMode ? r.predicted_mwh : r.predicted_kw));
  const actual = rows.map((r) => (energyMode ? r.actual_mwh : r.actual_kw));
  const finite = [...expected, ...actual].filter((v): v is number => v != null && v > 0);
  if (finite.length === 0) return null;
  const max = Math.max(...finite, 1);
  const unit = energyMode ? (resolution === 'monthly' ? 'MWh/mo' : 'MWh/wk') : 'kW';
  const fmt = (v: number) =>
    energyMode ? `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} MWh` : `${Math.round(v)} kW`;
  const yLabels = [
    `${Math.round(max)} ${unit}`,
    `${Math.round(max * 0.75)}`,
    `${Math.round(max * 0.5)}`,
    `${Math.round(max * 0.25)}`,
  ];

  // Axis labels render in the PLANT's zone (UTC fallback) — never silently in
  // the viewer's browser zone. Date-only strings stay calendar dates; only
  // hour-carrying stamps go through the tz conversion (they are UTC in the
  // store; the old `.replace(' ', 'T')` parse read them as browser-local).
  const labelFor = (raw: string) => {
    if (raw.length === 10) {
      const d = new Date(raw + 'T00:00:00');
      if (Number.isNaN(d.getTime())) return '';
      if (resolution === 'monthly') return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    const d = toUtcDate(raw);
    if (Number.isNaN(d.getTime())) return '';
    if (resolution === 'monthly') return formatPlantTime(d, plantTz, 'axis-day');
    if (resolution === 'hourly') {
      return `${formatPlantTime(d, plantTz, 'axis-day')} ${formatPlantTime(d, plantTz, 'axis-hour')}`;
    }
    return formatPlantTime(d, plantTz, 'axis-day');
  };
  const xTooltipLabels = rows.map((r) => labelFor(r.date));
  const stride = Math.max(1, Math.floor(rows.length / 5));
  const xLabels: string[] = [];
  for (let i = 0; i < rows.length; i += stride) xLabels.push(xTooltipLabels[i]);

  return { expected, actual, xLabels, xTooltipLabels, yLabels, formatValue: fmt };
}
