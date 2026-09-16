import { NextRequest, NextResponse } from 'next/server';
import {
  joinHourly,
  attributeRevenue,
  PLANT_CONSTANTS,
  type PlantConstants,
} from '@/lib/bess/joinPvBess';
import {
  extendWithGenset,
  DEFAULT_DIESEL_USD_PER_L,
  type GensetSeriesPoint,
  type GensetSummary,
} from '@/lib/bess/gensetHybrid';
import { getCoverage } from '@/lib/prices/omiePrices';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';
import { queryAnalysisResults, type DailyAnalysisRow } from '@/lib/db/timeseries';

export const runtime = 'nodejs';

type Range = '24h' | '7d' | '30d';

const RANGE_HOURS: Record<Range, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const toNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)) : [];

/** Genset lane is a demo-only synthetic layer; real plants get an honest zero summary. */
function emptyGensetSummary(): GensetSummary {
  return {
    config: {
      rating_kw: 0,
      min_load_fraction: 0,
      diesel_usd_per_l: DEFAULT_DIESEL_USD_PER_L,
      site_load_base_kw: 0,
      site_load_peak_kw: 0,
    },
    runtime_h: 0,
    starts: 0,
    fuel_l: 0,
    fuel_usd: 0,
    genset_kwh: 0,
    outages: { count: 0, total_min: 0 },
    unserved_min: 0,
    economics: {
      fuel_l: 0,
      fuel_usd: 0,
      avoided_usd: 0,
      genset_usd_per_kwh: null,
      pv_bess_usd_per_kwh: 0,
    },
    daily_fuel: [],
    events: [],
    postmortem: null,
  };
}

/**
 * GET /api/bess/plants/[plantId]/hybrid?range=24h|7d|30d&diesel_usd_per_l=1.10
 *
 * Returns the joined PV+BESS+genset+price hourly series + the revenue
 * attribution + the plant's nominal constants. Window is anchored on the
 * last hour of available OMIE price data so the cockpit always shows a
 * "complete" window even on plants without recent SCADA fixtures.
 *
 * The genset lane (site load, grid outages, DG dispatch, fuel burn) is a
 * deterministic synthetic layer on top of the PV+BESS timeline; see
 * `@/lib/bess/gensetHybrid`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;

  // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
  // plants stay publicly readable (showcase).
  const readAccess = await resolvePlantForRead(plantId);
  if (!readAccess.ok) return readAccess.response;
  if (readAccess.access === 'org') {
    const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
    if (gate) return gate;
  }

  // Database branch: plants with BessAsset rows get their battery lane from
  // BessDispatchSchedule rows and the PV energy KPI from the digital-twin
  // analysis_results. The synthetic fixture timeline (clear-sky PV + genset
  // story) remains the fallback for demo slugs.
  if (readAccess.plant) {
    const dbPlant = readAccess.plant;
    const dbAsset = await prisma.bessAsset.findFirst({
      where: { plant_id: dbPlant.id },
      orderBy: { created_at: 'asc' },
    });
    if (dbAsset) {
      const dbUrl = new URL(request.url);
      const dbRange = (dbUrl.searchParams.get('range') ?? '7d') as Range;
      const dbHours = RANGE_HOURS[dbRange];
      if (!dbHours) {
        return NextResponse.json(
          { error: `Invalid range "${dbRange}". Use 24h, 7d, or 30d.` },
          { status: 400 }
        );
      }
      const windowDays = Math.max(1, Math.ceil(dbHours / 24));

      const scheduleRows = await prisma.bessDispatchSchedule.findMany({
        where: { asset_id: dbAsset.id },
        orderBy: { schedule_date: 'desc' },
        take: windowDays,
      });
      const rows = scheduleRows.slice().reverse();

      // Nominal constants from the DB (PLANT_CONSTANTS only covers demo slugs).
      const constants: PlantConstants = {
        pv_nameplate_kw: Math.round(Number(dbPlant.capacity_mw) * 1000),
        pv_grid_cap_kw: Math.round(Number(dbPlant.capacity_mw) * 1000),
        bess_power_kw: Number(dbAsset.nominal_power_kw),
        bess_energy_kwh: Number(dbAsset.nominal_capacity_kwh),
        bess_rte: 0.88, // nominal; per-day RTE lives in BessCycleRecord
        latitude_deg: Number(dbPlant.latitude),
        longitude_deg: Number(dbPlant.longitude),
        baseline_soiling: 1,
      };

      // Battery lane from the optimizer schedules. The PV lane is not
      // reconstructed at hourly resolution in the DB path yet, so those
      // fields are honestly zero.
      // TODO: PV overlay from measurements
      const series: GensetSeriesPoint[] = [];
      for (const row of rows) {
        const dateStr = row.schedule_date.toISOString().slice(0, 10);
        const charge = toNumberArray(row.charge_schedule_kw);
        const discharge = toNumberArray(row.discharge_schedule_kw);
        const soc = toNumberArray(row.soc_schedule);
        const price = toNumberArray(row.price_forecast);
        for (let hour = 0; hour < 24; hour++) {
          const chargeKw = Math.abs(charge[hour] ?? 0);
          const dischargeKw = Math.abs(discharge[hour] ?? 0);
          series.push({
            time: `${dateStr}T${String(hour).padStart(2, '0')}:00:00`,
            pv_potential_kw: 0,
            pv_actual_kw: 0,
            pv_curtailed_kw: 0,
            pv_to_bess_kw: 0,
            bess_power_kw: Math.round(chargeKw - dischargeKw),
            bess_soc: soc[hour] ?? 0,
            price_eur_mwh: price[hour] ?? 0,
            site_load_kw: 0,
            grid_available: true,
            genset_power_kw: 0,
            fuel_lph: 0,
            fuel_cum_day_l: 0,
            bess_to_load_kw: 0,
            unserved_kw: 0,
          });
        }
      }

      const fromDate = rows.length
        ? rows[0].schedule_date
        : new Date(Date.now() - dbHours * 3600 * 1000);
      const toDate = rows.length
        ? new Date(rows[rows.length - 1].schedule_date.getTime() + 86_400_000)
        : new Date();

      // PV daily energy from the digital-twin daily aggregate (avg kW × 24 h).
      let pvGenMwh = 0;
      try {
        const dailyRows = (await queryAnalysisResults({
          plantId: dbPlant.id,
          domain: 'digitaltwin',
          metrics: ['power_ac_actual'],
          deviceId: 'PLANT',
          from: fromDate,
          to: toDate,
          resolution: 'daily',
        })) as DailyAnalysisRow[];
        pvGenMwh =
          Math.round(
            (dailyRows.reduce((s, r) => s + Number(r.avg_value) * 24, 0) /
              1000) *
              10
          ) / 10;
      } catch {
        pvGenMwh = 0;
      }

      const dbRevenue = attributeRevenue(series);
      const bessThroughputMwh =
        Math.round(
          (series.reduce((s, p) => s + Math.abs(p.bess_power_kw), 0) /
            1000 /
            2) *
            10
        ) / 10;

      return NextResponse.json({
        plant: { slug: plantId, constants },
        range: dbRange,
        window: {
          from: fromDate.toISOString().slice(0, 19),
          to: toDate.toISOString().slice(0, 19),
        },
        series,
        revenue: dbRevenue,
        genset: emptyGensetSummary(),
        kpis: {
          pv_generation_mwh: pvGenMwh,
          bess_throughput_mwh: bessThroughputMwh,
          curtailment_recovered_mwh: 0, // needs the hourly PV overlay above
          total_revenue_eur: dbRevenue.total_eur,
          uplift_vs_pv_only_eur: dbRevenue.uplift_vs_pv_only_eur,
        },
        _source: 'database',
      });
    }
  }

  if (!PLANT_CONSTANTS[plantId]) {
    return NextResponse.json(
      { error: `No PV+BESS configuration for plantId="${plantId}".` },
      { status: 404 }
    );
  }

  // Standalone BESS (no co-located PV) — return an "empty" payload so the
  // cockpit can render a clean placeholder rather than synthetic sunshine.
  if (PLANT_CONSTANTS[plantId].pv_nameplate_kw === 0) {
    return NextResponse.json({
      plant: { slug: plantId, constants: PLANT_CONSTANTS[plantId] },
      no_pv: true,
      message: 'This is a standalone BESS asset with no co-located PV.',
    });
  }

  const url = new URL(request.url);
  const rangeParam = (url.searchParams.get('range') ?? '7d') as Range;
  const hours = RANGE_HOURS[rangeParam];
  if (!hours) {
    return NextResponse.json(
      { error: `Invalid range "${rangeParam}". Use 24h, 7d, or 30d.` },
      { status: 400 }
    );
  }

  // Anchor on the latest hour of price data we have, then walk back.
  const coverage = getCoverage('ES');
  if (!coverage.hours) {
    return NextResponse.json(
      { error: 'Price fixtures are not loaded.' },
      { status: 500 }
    );
  }
  const lastTs = coverage.lastTime;
  const lastDate = new Date(lastTs + 'Z');
  const fromDate = new Date(lastDate.getTime() - (hours - 1) * 3600 * 1000);
  const from = fromDate.toISOString().slice(0, 19);
  const to = new Date(lastDate.getTime() + 3600 * 1000).toISOString().slice(0, 19);

  // Optional diesel price override (USD per litre) for the fuel economics.
  const dieselParam = url.searchParams.get('diesel_usd_per_l');
  let dieselUsdPerL = DEFAULT_DIESEL_USD_PER_L;
  if (dieselParam !== null) {
    const parsed = Number(dieselParam);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
      return NextResponse.json(
        { error: `Invalid diesel_usd_per_l "${dieselParam}". Use a value between 0 and 10.` },
        { status: 400 }
      );
    }
    dieselUsdPerL = parsed;
  }

  const baseSeries = joinHourly({ plantSlug: plantId, from, to });
  const { series, genset } = extendWithGenset({
    plantSlug: plantId,
    series: baseSeries,
    constants: PLANT_CONSTANTS[plantId],
    dieselUsdPerL,
  });

  // Grid transactions only settle while the grid is up: zero out the spot
  // price during outage hours before attributing revenue.
  const revenue = attributeRevenue(
    series.map((p) => (p.grid_available ? p : { ...p, price_eur_mwh: 0 }))
  );

  // Lightweight summary KPIs the cockpit's hero band uses.
  const pvGenMwh =
    Math.round(series.reduce((s, p) => s + p.pv_actual_kw, 0) / 1000 * 10) / 10;
  const bessThroughputMwh =
    Math.round(
      series.reduce((s, p) => s + Math.abs(p.bess_power_kw), 0) / 1000 / 2 * 10
    ) / 10;
  const curtailmentRecoveredMwh =
    Math.round(series.reduce((s, p) => s + p.pv_to_bess_kw, 0) / 1000 * 10) / 10;

  return NextResponse.json({
    plant: { slug: plantId, constants: PLANT_CONSTANTS[plantId] },
    range: rangeParam,
    window: { from, to },
    series,
    revenue,
    genset,
    kpis: {
      pv_generation_mwh: pvGenMwh,
      bess_throughput_mwh: bessThroughputMwh,
      curtailment_recovered_mwh: curtailmentRecoveredMwh,
      total_revenue_eur: revenue.total_eur,
      uplift_vs_pv_only_eur: revenue.uplift_vs_pv_only_eur,
    },
  });
}
