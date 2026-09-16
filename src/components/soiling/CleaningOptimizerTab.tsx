'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  CalendarCheck,
  Droplets,
  Eraser,
  HelpCircle,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Trash2,
  Zap,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import KpiCard from '@/components/ui/KpiCard';
import SectionCard from '@/components/ui/SectionCard';
import PlannedCleaningsPanel from '@/components/soiling/PlannedCleaningsPanel';
import { optimizeSchedule } from '@/lib/soiling/optimizeSchedule';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { Pill } from '@/components/ui/Pill';
import {
  scoreSchedule,
  validateDate,
  type WhatIfParams,
} from '@/lib/soiling/whatif';
import {
  computeMeteoPriorBaseline,
  loadClimatePriors,
  type MeteoPriorBaseline,
} from '@/lib/soiling/meteoBaseline';
import type {
  DigitalTwinDataPoint,
  DigitalTwinResponse,
  OptimizationResponse,
} from '@/types/soiling';

// Fallback climate-zone mapping for plants whose ml_forecast_365d.json doesn't
// expose `climate_zone` in metadata. Authoritative source is the JSON; this is
// just a safety net so the meteo baseline never silently degrades to "flat".
const PLANT_CLIMATE_ZONE_FALLBACK: Record<string, string> = {
  ribera: 'MEDITERRANEAN',
  alpha: 'MEDITERRANEAN',
  eta: 'MEDITERRANEAN',
  gamma: 'MEDITERRANEAN',
  theta: 'MEDITERRANEAN',
  delta: 'MEDITERRANEAN',
  zeta: 'MEDITERRANEAN',
  epsilon: 'TEMPERATE_CONTINENTAL',
};

interface RainHistoryRow {
  date: string;
  precipitation_mm?: number;
  mm?: number;
}

interface AodHistoryRow {
  date: string;
  aod_mean?: number | null;
  dust_mean?: number | null;
}

interface DustiqHistoryRow {
  date: string;
  sr_dustiq?: number | null;
}

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface PlantMeta {
  name: string;
  capacityMW: number;
  currency: string;
  latitude: number | null;
  longitude: number | null;
}

const fmtEur = (v: number, currency = 'EUR') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(v);

export default function CleaningOptimizerTab({ plantId }: { plantId: string }) {
  const routePrefix = usePlantRoutePrefix();
  const [twin, setTwin] = useState<DigitalTwinDataPoint[] | null>(null);
  const [meta, setMeta] = useState<PlantMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dates, setDates] = useState<string[]>([]);
  const [electricityRate, setElectricityRate] = useState(65);
  const [cleaningCostPerMW, setCleaningCostPerMW] = useState(150);
  const [minDaysBetween, setMinDaysBetween] = useState(14);
  const [minCleanings, setMinCleanings] = useState(1);
  const [maxCleanings, setMaxCleanings] = useState(12);

  const [optimizing, setOptimizing] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optResult, setOptResult] = useState<OptimizationResponse | null>(null);
  const [addWarning, setAddWarning] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState<string | null>(null);
  const [adoptWithTickets, setAdoptWithTickets] = useState(true);
  const [plannedVersion, setPlannedVersion] = useState(0);

  // Meteo-prior baseline (Phase 2): independent forward simulation anchored at
  // the latest observed SR, walked forward with climate-zone priors + typical-
  // year rain climatology. Renders alongside the cleaning-schedule trajectory
  // so the two curves are physically independent (the baseline isn't a
  // derivative of the ML model, it's a climate-priors what-if).
  const [meteoBaseline, setMeteoBaseline] = useState<MeteoPriorBaseline | null>(null);
  const [meteoWarning, setMeteoWarning] = useState<string | null>(null);

  // Load forecast + plant meta.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch(`/api/soiling/plants/${plantId}/digital-twin?source=ml_model`).then(
        async (r) => {
          if (!r.ok) throw new Error(`Forecast unavailable (HTTP ${r.status})`);
          return (await r.json()) as DigitalTwinResponse;
        },
      ),
      fetch(`/api/plants/${plantId}`).then(async (r) =>
        r.ok ? (await r.json()).data : null,
      ),
    ])
      .then(([twinRes, plant]) => {
        if (!alive) return;
        setTwin(twinRes.daily_forecasts);
        setMeta({
          name: plant?.name ?? plantId,
          capacityMW: plant?.capacity_mw
            ? Number(plant.capacity_mw)
            : twinRes.capacity_MW,
          currency: plant?.currency ?? 'EUR',
          latitude: plant?.latitude != null ? Number(plant.latitude) : null,
          longitude: plant?.longitude != null ? Number(plant.longitude) : null,
        });
      })
      .catch((e) => alive && setLoadError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [plantId]);

  // Load meteo-prior baseline. Runs independently of the twin fetch so a
  // missing fixture for one plant doesn't break the rest of the tab.
  useEffect(() => {
    let alive = true;
    setMeteoBaseline(null);
    setMeteoWarning(null);

    // Probe the ml-forecast fixture first: org plants that have generated
    // static artifacts (e.g. the shared demo plant) get the full overlays on
    // /dashboard too; plants without it skip the remaining fixture fetches so
    // the tab doesn't fire a volley of /data 404s.
    (async () => {
      const mlRaw = await fetchJsonOrNull<any>(
        `/data/soiling/${plantId}/ml_forecast_365d.json`,
      );
      const hasFixtures = mlRaw != null || routePrefix !== '/dashboard';
      const [priors, rainRaw, aodRaw, dustiqRaw] = hasFixtures
        ? await Promise.all([
            loadClimatePriors().catch(() => null),
            fetchJsonOrNull<{ daily_data?: RainHistoryRow[] }>(
              `/data/soiling/${plantId}/rain_history.json`,
            ),
            fetchJsonOrNull<{ daily_data?: AodHistoryRow[] }>(
              `/data/soiling/${plantId}/aod_history.json`,
            ),
            fetchJsonOrNull<{ daily_data?: DustiqHistoryRow[] }>(
              `/data/soiling/${plantId}/dustiq_history.json`,
            ),
          ])
        : [null, null, null, null];
      if (!alive) return;

      const climateZone: string =
        mlRaw?.metadata?.climate_zone ??
        PLANT_CLIMATE_ZONE_FALLBACK[plantId] ??
        'MEDITERRANEAN';

      // Observed SR: most recent DustIQ reading, else most recent sr_predicted.
      let observedSr: number | null = null;
      const dustRows = dustiqRaw?.daily_data ?? [];
      for (let i = dustRows.length - 1; i >= 0; i--) {
        const v = dustRows[i]?.sr_dustiq;
        if (typeof v === 'number' && Number.isFinite(v)) {
          observedSr = Math.min(1, Math.max(0, v));
          break;
        }
      }
      if (observedSr === null) {
        const mlRows = (mlRaw?.daily_forecasts ?? []) as Array<{ sr_predicted?: number }>;
        for (let i = 0; i < mlRows.length; i++) {
          const v = mlRows[i]?.sr_predicted;
          if (typeof v === 'number' && Number.isFinite(v)) {
            observedSr = v;
            break;
          }
        }
      }
      if (observedSr === null) observedSr = 0.98;

      // Forecast horizon: align with the twin (1 year) starting today.
      const startDate = new Date();
      startDate.setUTCHours(0, 0, 0, 0);
      const daysAhead = 364;

      const rainHistory = (rainRaw?.daily_data ?? [])
        .map((r) => ({ date: r.date, mm: Number(r.precipitation_mm ?? r.mm ?? 0) }))
        .filter((r) => r.date && Number.isFinite(r.mm));
      const aodHistory = (aodRaw?.daily_data ?? [])
        .map((r) => ({
          date: r.date,
          aod: Number(r.aod_mean ?? r.dust_mean ?? 0),
        }))
        .filter((r) => r.date && Number.isFinite(r.aod) && r.aod > 0);

      if (!priors) {
        setMeteoWarning(
          'Climate priors unavailable, baseline shown as flat line at observed SR.',
        );
      }

      const baseline = computeMeteoPriorBaseline({
        observedSr,
        climateZone,
        startDate,
        daysAhead,
        rainHistory: rainHistory.length > 0 ? rainHistory : undefined,
        aodHistory: aodHistory.length > 0 ? aodHistory : undefined,
        climatePriors: priors,
      });

      if (!alive) return;
      setMeteoBaseline(baseline);
    })();

    return () => {
      alive = false;
    };
  }, [plantId, routePrefix]);

  const params: WhatIfParams = useMemo(
    () => ({
      capacityMW: meta?.capacityMW ?? 9,
      electricityRatePerMWh: electricityRate,
      cleaningCostPerMW,
      minDaysBetween,
    }),
    [meta, electricityRate, cleaningCostPerMW, minDaysBetween],
  );

  const score = useMemo(
    () => (twin ? scoreSchedule(twin, dates, params) : null),
    [twin, dates, params],
  );

  // Re-score the optimizer's candidate schedules with the *current* economic
  // params so the comparison always agrees with the headline KPIs.
  const comparison = useMemo(() => {
    if (!twin || !optResult) return null;
    const byN = new Map<number, { dates: string[]; net: number; roi: number; energy: number }>();
    const candidates = [optResult.optimal_schedule, ...(optResult.alternatives ?? [])];
    for (const alt of candidates) {
      if (!alt?.dates) continue;
      const s = scoreSchedule(twin, alt.dates, params);
      const existing = byN.get(s.nCleanings);
      if (!existing || s.netEUR > existing.net) {
        byN.set(s.nCleanings, {
          dates: s.dates,
          net: s.netEUR,
          roi: s.roiPct,
          energy: s.energyRecoveredMWh,
        });
      }
    }
    return Array.from(byN.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([n, v]) => ({ n, ...v }));
  }, [twin, optResult, params]);

  const bestNet = useMemo(
    () => (comparison ? Math.max(...comparison.map((c) => c.net), 0) : 0),
    [comparison],
  );

  const warnings = useMemo(() => {
    if (!twin) return [];
    return dates.flatMap((d) =>
      validateDate(d, dates, twin, minDaysBetween).filter(
        (v) => v.severity === 'warning',
      ),
    );
  }, [twin, dates, minDaysBetween]);

  const toggleDate = useCallback(
    (date: string) => {
      setAddWarning(null);
      setDates((prev) => {
        // Clicking on/near an existing cleaning removes it.
        const near = prev.find(
          (d) => Math.abs(Date.parse(d) - Date.parse(date)) / 86_400_000 <= 3,
        );
        if (near) return prev.filter((d) => d !== near);
        if (!twin) return prev;
        const errors = validateDate(date, prev, twin, minDaysBetween).filter(
          (v) => v.severity === 'error',
        );
        if (errors.length > 0) {
          setAddWarning(errors[0].message);
          return prev;
        }
        return [...prev, date].sort();
      });
    },
    [twin, minDaysBetween],
  );

  const removeDate = useCallback((date: string) => {
    setDates((prev) => prev.filter((d) => d !== date));
  }, []);

  // Run the scenario search in the browser: the TS optimizer
  // (src/lib/soiling/optimizeSchedule.ts) enumerates candidate schedules over
  // the already-loaded twin forecast and scores them with the same whatif.ts
  // economics the rest of this tab uses. No server job, works on serverless,
  // completes in well under a second. Rain-awareness comes from a best-effort
  // 16-day Open-Meteo forecast fetched right before the search.
  const runOptimizer = useCallback(async () => {
    if (!meta || !twin) return;
    setOptError(null);
    setOptResult(null);
    setOptimizing(true);
    try {
      // Server-side proxy (browser CSP blocks direct Open-Meteo calls).
      const rain = await fetch(
        `/api/soiling/plants/${encodeURIComponent(plantId)}/rain-forecast`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => json?.data ?? null)
        .catch(() => null);
      // Yield a frame so the button's busy state paints before the
      // synchronous search runs.
      await new Promise((r) => setTimeout(r, 30));
      const result = optimizeSchedule({
        plantId,
        forecast: twin,
        params: {
          capacityMW: meta.capacityMW,
          electricityRatePerMWh: electricityRate,
          cleaningCostPerMW: cleaningCostPerMW,
          minDaysBetween,
        },
        minCleanings,
        maxCleanings,
        maxScenariosPerCount: 600,
        rainForecast: rain,
      });
      setOptResult(result);
      if (result.optimal_schedule?.dates) {
        setDates([...result.optimal_schedule.dates].sort());
      }
    } catch (e) {
      setOptError(e instanceof Error ? e.message : 'Optimization failed');
    } finally {
      setOptimizing(false);
    }
  }, [
    plantId,
    meta,
    twin,
    electricityRate,
    cleaningCostPerMW,
    minDaysBetween,
    minCleanings,
    maxCleanings,
  ]);

  // Persist the current what-if schedule as the plant's adopted plan,
  // optionally creating one maintenance ticket per cleaning date.
  const adoptSchedule = useCallback(async () => {
    if (!score || score.nCleanings === 0) return;
    setAdopting(true);
    setAdoptMsg(null);
    try {
      const res = await fetch(
        `/api/soiling/plants/${plantId}/cleaning-schedules`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleName: `Optimizer plan (${score.nCleanings} cleanings)`,
            dates: score.dates,
            estimatedEnergyRecoveredMwh: score.energyRecoveredMWh,
            estimatedRevenueRecoveredEur: score.revenueEUR,
            estimatedCleaningCostEur: score.costEUR,
            avgSrBaseline: score.avgSrWithout,
            avgSrOptimized: score.avgSrWith,
            createTickets: adoptWithTickets,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setAdoptMsg(
        adoptWithTickets
          ? `Plan adopted. ${json.data?.ticketIds?.length ?? 0} maintenance tickets created.`
          : 'Plan adopted.',
      );
      setPlannedVersion((v) => v + 1);
    } catch (e) {
      setAdoptMsg(
        `Could not adopt the plan: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    } finally {
      setAdopting(false);
    }
  }, [score, plantId, adoptWithTickets]);

  const chartOption = useMemo(() => {
    if (!twin || !score) return null;
    const axisDates = twin.map((d) => d.date);
    const scheduled = score.srSeries.map((v) => +(v * 100).toFixed(2));
    const rain = twin.map((d) => +(d.rainfall_mm ?? 0).toFixed(1));

    // Align meteo-prior baseline to the chart's date axis. Meteo dates are
    // typically a 1:1 match with twin dates but we lookup by date to be safe
    // (e.g. if today's UTC date drifts the meteo start by a day).
    const meteoCentral: Array<number | null> = new Array(axisDates.length).fill(null);
    const meteoP25: Array<number | null> = new Array(axisDates.length).fill(null);
    const meteoP75Delta: Array<number | null> = new Array(axisDates.length).fill(null);
    if (meteoBaseline) {
      const idxByDate = new Map<string, number>();
      meteoBaseline.dates.forEach((d, i) => idxByDate.set(d, i));
      for (let i = 0; i < axisDates.length; i++) {
        const mi = idxByDate.get(axisDates[i]);
        if (mi !== undefined) {
          const c = meteoBaseline.sr_central[mi];
          const p25 = meteoBaseline.sr_p25[mi];
          const p75 = meteoBaseline.sr_p75[mi];
          meteoCentral[i] = +(c * 100).toFixed(2);
          meteoP25[i] = +(p25 * 100).toFixed(2);
          // Stacked-area ribbon: lower = p25, upper = p75-p25 stacked on top.
          meteoP75Delta[i] = +((p75 - p25) * 100).toFixed(2);
        }
      }
    }

    // Rain-day x-axis tick marks from the typical-year climatology used in the
    // meteo simulation. Render as small markPoint glyphs on the meteo line.
    const rainDayMarks = (meteoBaseline?.rain_days ?? [])
      .map((iso) => iso.slice(0, 10))
      .filter((d) => axisDates.includes(d))
      .map((d) => ({
        xAxis: d,
        yAxis: 70,
        symbol: 'triangle',
        symbolSize: 6,
        symbolRotate: 180,
        itemStyle: { color: '#0ea5e9', opacity: 0.7 },
        label: { show: false },
      }));

    const allValues: number[] = [...scheduled];
    for (const v of meteoCentral) if (v !== null) allValues.push(v);
    for (const v of meteoP25) if (v !== null) allValues.push(v);
    const minSr = allValues.length > 0 ? Math.min(...allValues) : 80;

    const legendEntries = [
      'With cleanings',
      'Meteo-prior baseline (no further cleaning)',
      'Climate-prior band (p25,p75)',
      'Rainfall',
    ];

    return {
      animation: false,
      grid: { left: 48, right: 52, top: 36, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number | null | undefined) =>
          v === null || v === undefined ? ',' : `${v}`,
      },
      legend: {
        top: 0,
        data: legendEntries,
        textStyle: { fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: axisDates,
        axisLabel: {
          fontSize: 10,
          formatter: (v: string) => format(parseISO(v), 'MMM yy'),
          interval: 30,
        },
      },
      yAxis: [
        {
          type: 'value',
          min: Math.max(Math.floor(minSr - 2), 70),
          max: 100,
          axisLabel: { formatter: '{value}%', fontSize: 10 },
          name: 'Soiling ratio',
          nameTextStyle: { fontSize: 10 },
        },
        {
          type: 'value',
          min: 0,
          max: Math.max(20, Math.ceil(Math.max(...rain) / 5) * 5),
          axisLabel: { formatter: '{value}mm', fontSize: 10 },
          name: 'Rain',
          nameTextStyle: { fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Rainfall',
          type: 'bar',
          yAxisIndex: 1,
          data: rain,
          itemStyle: { color: 'rgba(56,189,248,0.45)' },
          barWidth: 2,
          silent: true,
        },
        // p25 line (invisible), base of the stacked ribbon.
        {
          name: 'meteo-p25-base',
          type: 'line',
          data: meteoP25,
          stack: 'meteo-band',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          tooltip: { show: false },
          silent: true,
          // Hide from legend.
          legendHoverLink: false,
        },
        // Delta to p75, fills the ribbon area on top of the invisible base.
        {
          name: 'Climate-prior band (p25,p75)',
          type: 'line',
          data: meteoP75Delta,
          stack: 'meteo-band',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(148,163,184,0.18)' },
          tooltip: { show: false },
          silent: true,
        },
        {
          name: 'Meteo-prior baseline (no further cleaning)',
          type: 'line',
          data: meteoCentral,
          showSymbol: false,
          lineStyle: { type: 'dashed', width: 1.5, color: '#64748b' },
          itemStyle: { color: '#64748b' },
          markPoint:
            rainDayMarks.length > 0
              ? {
                  symbol: 'triangle',
                  symbolSize: 6,
                  symbolRotate: 180,
                  data: rainDayMarks,
                  label: { show: false },
                  tooltip: {
                    show: true,
                    formatter: () =>
                      'Typical-year rainfall &gt; 5mm (cleaning expected)',
                  },
                }
              : undefined,
        },
        {
          name: 'With cleanings',
          type: 'line',
          data: scheduled,
          showSymbol: false,
          lineStyle: { width: 2, color: '#2563eb' },
          itemStyle: { color: '#2563eb' },
          areaStyle: { color: 'rgba(37,99,235,0.06)' },
          markLine: {
            symbol: 'none',
            label: {
              formatter: (p: any) => format(parseISO(p.name), 'MMM d'),
              fontSize: 10,
              color: '#059669',
            },
            lineStyle: { color: '#059669', width: 1.5 },
            data: dates.map((d) => ({ xAxis: d, name: d })),
          },
        },
      ],
    };
  }, [twin, score, dates, meteoBaseline]);

  // Clicks on empty plot area don't fire ECharts series events, so listen at
  // the ZRender level and convert the pixel position back to a data index.
  const twinRef = useRef(twin);
  twinRef.current = twin;
  const toggleDateRef = useRef(toggleDate);
  toggleDateRef.current = toggleDate;

  const onChartReady = useCallback((chart: any) => {
    chart.getZr().on('click', (e: any) => {
      const forecast = twinRef.current;
      if (!forecast) return;
      const point = [e.offsetX, e.offsetY];
      if (!chart.containPixel('grid', point)) return;
      const coords = chart.convertFromPixel('grid', point) as number[];
      const idx = Math.round(coords?.[0]);
      const day = Number.isFinite(idx) ? forecast[idx] : undefined;
      if (day) toggleDateRef.current(day.date);
    });
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-xl border border-gray-200 bg-gray-100" />
      </div>
    );
  }

  if (loadError || !twin || !score) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load the cleaning forecast: {loadError ?? 'no forecast data'}
      </div>
    );
  }

  const windowLabel = `${format(parseISO(twin[0].date), 'MMM d, yyyy')}, ${format(
    parseISO(twin[twin.length - 1].date),
    'MMM d, yyyy',
  )}`;

  return (
    <div className="space-y-6">
      {/* Adopted plan (if any) */}
      <PlannedCleaningsPanel plantId={plantId} refreshKey={plannedVersion} />

      {/* Controls */}
      <SectionCard
        title="Cleaning optimizer"
        description={`What-if analysis on the ${meta?.name ?? plantId} digital twin · forecast window ${windowLabel}`}
        actions={
          <div className="flex items-center gap-2">
            {optResult && (
              <span
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  optResult.rain_aware
                    ? 'border-sky-200 bg-sky-50 text-sky-700'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
                title={
                  optResult.rain_aware
                    ? 'The optimizer avoided cleaning right before forecast rain (16-day Open-Meteo forecast at the plant coordinates).'
                    : 'No rain forecast was available for this run; scheduling ignored upcoming rain.'
                }
              >
                {optResult.rain_aware ? 'Rain-aware: next 16 days' : 'Rain forecast unavailable'}
              </span>
            )}
            {dates.length > 0 && (
              <button
                onClick={() => setDates([])}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                <Eraser className="h-3.5 w-3.5" /> Clear
              </button>
            )}
            <button
              onClick={runOptimizer}
              disabled={optimizing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-wait disabled:bg-gray-300"
            >
              {optimizing ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Optimizing…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Find optimal schedule
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block">
            <span className="text-xs font-medium text-gray-500">
              Electricity price ({meta?.currency ?? 'EUR'}/MWh)
            </span>
            <input
              type="number"
              min={0}
              step={5}
              value={electricityRate}
              onChange={(e) => setElectricityRate(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-500">
              Cleaning cost ({meta?.currency ?? 'EUR'}/MW)
            </span>
            <input
              type="number"
              min={0}
              step={10}
              value={cleaningCostPerMW}
              onChange={(e) => setCleaningCostPerMW(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-500">Min days between cleanings</span>
            <input
              type="number"
              min={1}
              max={120}
              value={minDaysBetween}
              onChange={(e) => setMinDaysBetween(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-500">
              Min cleanings / yr
            </span>
            <input
              type="number"
              min={1}
              max={26}
              value={minCleanings}
              onChange={(e) => {
                const v = Math.max(1, Math.min(26, Number(e.target.value) || 1));
                setMinCleanings(v);
                if (v > maxCleanings) setMaxCleanings(v);
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-500">
              Max cleanings / yr
            </span>
            <input
              type="number"
              min={1}
              max={26}
              value={maxCleanings}
              onChange={(e) => {
                const v = Math.max(1, Math.min(26, Number(e.target.value) || 1));
                setMaxCleanings(v);
                if (v < minCleanings) setMinCleanings(v);
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <div className="flex flex-col justify-end">
            <span className="text-xs font-medium text-gray-500">Cost per cleaning</span>
            <span className="mt-1 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900">
              {fmtEur((meta?.capacityMW ?? 0) * cleaningCostPerMW, meta?.currency)}
              <span className="ml-1 font-normal text-gray-400">
                ({meta?.capacityMW ?? 0} MW)
              </span>
            </span>
          </div>
        </div>
        {optError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Optimizer failed: {optError}
          </div>
        )}
        {optimizing && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
            Scoring candidate schedules against the digital-twin forecast…
          </div>
        )}
      </SectionCard>

      {/* KPI band, single engine, always consistent with the chart and table */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          title="Scheduled cleanings"
          value={score.nCleanings}
          subtitle={
            score.nCleanings > 0
              ? `cost ${fmtEur(score.costEUR, meta?.currency)}`
              : 'click the chart to add'
          }
          tone="brand"
          icon={CalendarCheck}
        />
        <KpiCard
          title="Energy recovered"
          value={`${score.energyRecoveredMWh.toFixed(0)} MWh`}
          subtitle={`avg SR ${(score.avgSrWith * 100).toFixed(1)}% vs ${(score.avgSrWithout * 100).toFixed(1)}% untreated`}
          tone="brand"
          icon={Zap}
        />
        <KpiCard
          title="Net benefit"
          value={fmtEur(score.netEUR, meta?.currency)}
          subtitle={`revenue ${fmtEur(score.revenueEUR, meta?.currency)} − cost ${fmtEur(score.costEUR, meta?.currency)}`}
          tone={score.nCleanings === 0 ? 'slate' : score.netEUR >= 0 ? 'positive' : 'critical'}
          icon={TrendingUp}
        />
        <KpiCard
          title="ROI"
          value={score.nCleanings > 0 ? `${score.roiPct.toFixed(0)}%` : '–'}
          subtitle="over the forecast window"
          tone={score.nCleanings === 0 ? 'slate' : score.roiPct >= 0 ? 'positive' : 'critical'}
          icon={Droplets}
        />
      </div>

      {/* SR trajectory chart */}
      <SectionCard
        title="Soiling-ratio trajectory"
        description="Click anywhere on the chart to schedule a cleaning on that day; click a green marker again to remove it."
        actions={
          meteoBaseline ? (
            <div className="flex items-center gap-2">
              <span
                title={`Forward simulation using ${meteoBaseline.climate_zone} climate priors and typical-year rainfall climatology (ERA5). Independent of POA/irradiance measurements. Confidence band reflects climate-prior uncertainty (p25,p75). Source: ${meteoBaseline.source}.`}
                className="inline-flex cursor-help items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[10px] font-medium text-blue-700"
              >
                Zone: {meteoBaseline.climate_zone}
              </span>
              <span
                title="Meteo-prior baseline is a forward simulation using climate-zone priors and typical-year rainfall climatology (ERA5). It is independent of POA/irradiance measurements. The shaded band reflects climate-prior uncertainty (p25,p75). Small blue triangles below the line mark typical-year rain days &gt; 5mm where cleaning is expected."
                className="inline-flex cursor-help items-center text-slate-400 hover:text-slate-600"
                aria-label="About the meteo-prior baseline"
              >
                <HelpCircle className="h-4 w-4" />
              </span>
            </div>
          ) : undefined
        }
      >
        {addWarning && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {addWarning}
          </div>
        )}
        {meteoWarning && (
          <div
            className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
            title="The meteo-prior baseline requires /data/soiling/_climate_priors.json. Without it, the baseline is shown as a flat line anchored at the latest observed SR."
          >
            {meteoWarning}
          </div>
        )}
        {chartOption && (
          <ReactECharts
            option={chartOption}
            style={{ height: 380 }}
            opts={{ renderer: 'canvas' }}
            onChartReady={onChartReady}
            notMerge
          />
        )}
        {warnings.length > 0 && (
          <div className="mt-3 space-y-1">
            {warnings.map((w, i) => (
              <div
                key={i}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              >
                {w.message}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Optimizer comparison */}
      {comparison && comparison.length > 0 && (
        <SectionCard
          title="Optimizer scenarios"
          description="Best candidate schedule per number of cleanings, scored with your current prices. Apply one and fine-tune it on the chart."
          flush
        >
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-5 py-3">Cleanings</th>
                <th className="px-5 py-3">Dates</th>
                <th className="px-5 py-3 text-right">Energy</th>
                <th className="px-5 py-3 text-right">Net benefit</th>
                <th className="px-5 py-3 text-right">ROI</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => {
                const isApplied =
                  row.dates.length === dates.length &&
                  row.dates.every((d, i) => d === dates[i]);
                const isBest = row.net === bestNet && row.net > 0;
                return (
                  <tr key={row.n} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-5 py-3 font-semibold text-gray-900">
                      {row.n}
                      {isBest && (
                        <Pill tone="positive" variant="soft" className="ml-2">
                          best
                        </Pill>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-600">
                      {row.dates.map((d) => format(parseISO(d), 'MMM d')).join(', ')}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {row.energy.toFixed(0)} MWh
                    </td>
                    <td
                      className={`px-5 py-3 text-right font-semibold ${
                        row.net >= 0 ? 'text-emerald-600' : 'text-rose-600'
                      }`}
                    >
                      {fmtEur(row.net, meta?.currency)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {row.roi.toFixed(0)}%
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => setDates(row.dates)}
                        disabled={isApplied}
                        className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
                      >
                        {isApplied ? 'Applied' : 'Apply'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SectionCard>
      )}

      {/* Schedule table */}
      <SectionCard
        title="Cleaning schedule"
        description={
          dates.length > 0
            ? 'Per-cleaning impact, attributed until the following cleaning.'
            : undefined
        }
        actions={
          dates.length > 0 ? (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={adoptWithTickets}
                  onChange={(e) => setAdoptWithTickets(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300"
                />
                Create tickets
              </label>
              <button
                onClick={adoptSchedule}
                disabled={adopting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-wait disabled:bg-gray-300"
              >
                {adopting ? 'Adopting…' : 'Adopt schedule'}
              </button>
            </div>
          ) : undefined
        }
        flush={dates.length > 0}
      >
        {adoptMsg && (
          <div
            className={`mx-5 mt-3 rounded-lg border px-3 py-2 text-sm ${
              adoptMsg.startsWith('Could not')
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800'
            }`}
          >
            {adoptMsg}
          </div>
        )}
        {dates.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">
            No cleanings scheduled. Click the trajectory chart to add one
            manually, or run the optimizer to get a full-year schedule.
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">SR before → after</th>
                <th className="px-5 py-3 text-right">Energy recovered</th>
                <th className="px-5 py-3 text-right">Cost</th>
                <th className="px-5 py-3 text-right">Net</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {score.perCleaning.map((c) => (
                <tr key={c.date} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">
                    {format(parseISO(c.date), 'EEE, MMM d, yyyy')}
                  </td>
                  <td className="px-5 py-3 text-gray-700">
                    {(c.srBefore * 100).toFixed(1)}% →{' '}
                    <span className="font-medium text-emerald-600">
                      {(c.srAfter * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700">
                    {c.energyRecoveredMWh.toFixed(1)} MWh
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700">
                    {fmtEur(c.costEUR, meta?.currency)}
                  </td>
                  <td
                    className={`px-5 py-3 text-right font-semibold ${
                      c.netEUR >= 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {fmtEur(c.netEUR, meta?.currency)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => removeDate(c.date)}
                      title="Remove cleaning"
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
