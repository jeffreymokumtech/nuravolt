import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { readArtifact } from '@/lib/analysis/artifacts';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import {
  BESS_SERVICES,
  LANE_ORDER,
  rowTotal,
  serviceValue,
  type RevenueLane,
} from '@/lib/config/bessServices';
import prisma from '@/libs/prisma';

export const runtime = 'nodejs';

/**
 * GET /api/bess/plants/[plantId]/revenue
 *
 * The three-lane revenue ledger. THE LANES ARE NEVER SUMMED INTO ONE TOTAL.
 *
 *   measured   what the asset did, valued at a published price, plus settled
 *              balancing-mechanism revenue rebuilt from the public Elexon
 *              acceptance stacks where a BMU id is declared
 *   declared   what a contract says the asset is paid, from the Contract /
 *              ContractTerm layer, never presented as measured
 *   benchmark  what a perfect-foresight operator would have earned on the same
 *              days and the same published prices
 *
 * A battery discharging at 14:00 could be running arbitrage, delivering an
 * accepted balancing-mechanism offer, or answering a frequency event. The
 * power trace is identical, so attributing it to a service would be a
 * fabrication and adding the lanes together would triple-count the same
 * megawatt hour.
 *
 * The one derived KPI is the gap versus the benchmark. A "capture rate %" KPI
 * used to live here and was deleted because its denominator was a hand-tuned
 * constant engineered to land in a plausible band. It is back because
 * nuravolt/pipeline/bess_revenue_assurance.py now supplies a real denominator:
 * the perfect-foresight arbitrage bound from the published price curve. It is
 * captioned as a ceiling, because perfect foresight is unreachable.
 *
 * Lane rows are written nightly to analysis_results with one model_version per
 * lane (the provenance carrier) and summarised on
 * AnalysisArtifact(kind='bess_revenue_assurance').
 */

const ARTIFACT_KIND = 'bess_revenue_assurance';

const LANE_BY_MODEL_VERSION: Record<string, RevenueLane> = {
  bess_revenue_measured_v1: 'measured',
  bess_revenue_declared_v1: 'declared',
  bess_revenue_benchmark_v1: 'benchmark',
};

/** Metrics that are ratios, so a window aggregate must average and not sum. */
const RATIO_METRIC = /_ratio$/;

/** Metrics that are physical quantities rather than money. */
const QUANTITY_METRIC = /_mwh$/;

interface LaneDay {
  date: string;
  [metric: string]: number | string;
}

interface LaneBlock {
  /** One row per day, keyed by metric. Never merged with another lane's rows. */
  series: LaneDay[];
  /** Per-metric window totals (sums for money, means for ratios). */
  totals: Record<string, number>;
  /** Metrics present in this lane, in a stable order. */
  metrics: string[];
  notes: string[];
}

interface ProvenanceEntry {
  lane: RevenueLane;
  model_version: string;
  source: string;
  caption: string;
}

function emptyLane(): LaneBlock {
  return { series: [], totals: {}, metrics: [], notes: [] };
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Fold per-metric daily values into window totals. Money and quantities sum;
 * ratios average, because a summed capture ratio is a meaningless number that
 * grows with the length of the window.
 */
function foldTotals(series: LaneDay[]): Record<string, number> {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const row of series) {
    for (const [metric, value] of Object.entries(row)) {
      if (metric === 'date' || typeof value !== 'number' || !Number.isFinite(value)) continue;
      sums[metric] = (sums[metric] ?? 0) + value;
      counts[metric] = (counts[metric] ?? 0) + 1;
    }
  }
  const totals: Record<string, number> = {};
  for (const [metric, sum] of Object.entries(sums)) {
    totals[metric] = RATIO_METRIC.test(metric)
      ? round(sum / Math.max(1, counts[metric]), 4)
      : round(sum, 2);
  }
  return totals;
}

/**
 * KPIs. Deliberately per-lane and gap-centric: there is no field here that
 * adds one lane to another, and a reader who wants a single number is given
 * the gap versus the benchmark, not a fabricated grand total.
 */
function buildKpis(ledger: Record<RevenueLane, LaneBlock>) {
  const measured = ledger.measured.totals;
  const declared = ledger.declared.totals;
  const benchmark = ledger.benchmark.totals;

  const declaredTotal = Object.entries(declared)
    .filter(([metric]) => metric.startsWith('revenue_declared_'))
    .reduce((sum, [, value]) => sum + value, 0);

  return {
    measured_energy_value: measured.revenue_measured_energy ?? null,
    measured_charge_cost: measured.revenue_measured_charge_cost ?? null,
    measured_bm_settled: measured.revenue_measured_bm ?? null,
    declared_contracted: Object.keys(declared).length ? round(declaredTotal, 2) : null,
    benchmark_arbitrage_ceiling: benchmark.revenue_benchmark_arbitrage ?? null,
    benchmark_ancillary: benchmark.revenue_benchmark_ancillary ?? null,
    realized_net: benchmark.revenue_realized_net ?? null,
    /** The single derived KPI: ceiling minus realized, on the same days. */
    revenue_gap: benchmark.revenue_gap ?? null,
    capture_ratio: benchmark.capture_ratio ?? null,
    capture_ratio_caption:
      benchmark.capture_ratio != null
        ? 'Share of the perfect-foresight ceiling that was realized. The ceiling is unreachable by construction.'
        : null,
  };
}

/** Shape the nightly analysis_results rows into three independent lane blocks. */
function ledgerFromRows(
  rows: Array<{ time: Date; metric: string; value: number; model_version: string | null }>,
): Record<RevenueLane, LaneBlock> {
  const ledger: Record<RevenueLane, LaneBlock> = {
    measured: emptyLane(),
    declared: emptyLane(),
    benchmark: emptyLane(),
  };
  const byLaneDate: Record<RevenueLane, Map<string, LaneDay>> = {
    measured: new Map(),
    declared: new Map(),
    benchmark: new Map(),
  };

  for (const row of rows) {
    const lane = LANE_BY_MODEL_VERSION[row.model_version ?? ''];
    if (!lane) continue;
    const date = row.time.toISOString().slice(0, 10);
    const bucket = byLaneDate[lane];
    const day = bucket.get(date) ?? { date };
    day[row.metric] = QUANTITY_METRIC.test(row.metric) ? round(row.value, 3) : round(row.value, 4);
    bucket.set(date, day);
  }

  for (const lane of LANE_ORDER) {
    const series = [...byLaneDate[lane].values()].sort((a, b) => a.date.localeCompare(b.date));
    ledger[lane].series = series;
    ledger[lane].totals = foldTotals(series);
    ledger[lane].metrics = [...new Set(series.flatMap((d) => Object.keys(d)))]
      .filter((k) => k !== 'date')
      .sort();
  }
  return ledger;
}

/**
 * Fixture fallback for the showcase plants. The six-service fixture columns are
 * split across the lanes they are actually paid under (see
 * src/lib/config/bessServices.ts) rather than stacked into one bar, so a
 * showcase reader sees the same three-lane structure a real plant gets. There
 * is no benchmark lane in the fixture: the perfect-foresight bound is computed
 * from published prices by the nightly job, and inventing one here would be a
 * fabricated ceiling.
 */
function ledgerFromFixture(days: Array<Record<string, number | string>>): Record<RevenueLane, LaneBlock> {
  const ledger: Record<RevenueLane, LaneBlock> = {
    measured: emptyLane(),
    declared: emptyLane(),
    benchmark: emptyLane(),
  };
  for (const day of days) {
    const date = String(day.date);
    for (const lane of LANE_ORDER) {
      const services = BESS_SERVICES.filter((s) => s.lane === lane);
      if (!services.length) continue;
      const row: LaneDay = { date };
      let any = false;
      for (const service of services) {
        const value = serviceValue(day, service.base);
        row[`revenue_${lane}_${service.base}`] = round(value, 2);
        if (value !== 0) any = true;
      }
      if (any) ledger[lane].series.push(row);
    }
  }
  for (const lane of LANE_ORDER) {
    ledger[lane].totals = foldTotals(ledger[lane].series);
    ledger[lane].metrics = [...new Set(ledger[lane].series.flatMap((d) => Object.keys(d)))]
      .filter((k) => k !== 'date')
      .sort();
  }
  ledger.benchmark.notes.push(
    'No benchmark lane for a fixture-backed plant: the perfect-foresight bound is solved from published prices by the nightly ledger job.',
  );
  return ledger;
}

function fixtureProvenance(): Record<string, ProvenanceEntry> {
  const out: Record<string, ProvenanceEntry> = {};
  for (const service of BESS_SERVICES) {
    out[`revenue_${service.lane}_${service.base}`] = {
      lane: service.lane,
      model_version: 'showcase_fixture',
      source: 'public/data fixture',
      caption:
        service.lane === 'declared'
          ? `${service.label}, an availability payment set by contract or auction. Showcase figures, not a live meter.`
          : `${service.label}, settled or energy value. Showcase figures, not a live meter.`,
    };
  }
  return out;
}

export async function GET(req: NextRequest, { params }: { params: { plantId: string } }) {
  const { plantId } = params;

  // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
  // plants stay publicly readable (showcase).
  const readAccess = await resolvePlantForRead(plantId);
  if (!readAccess.ok) return readAccess.response;
  if (readAccess.access === 'org') {
    const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
    if (gate) return gate;
  }

  const url = new URL(req.url);
  const daysParam = Number(url.searchParams.get('days') ?? 30);
  const windowDays = Number.isFinite(daysParam)
    ? Math.max(1, Math.min(365, Math.round(daysParam)))
    : 30;

  if (readAccess.plant) {
    const assets = await prisma.bessAsset.findMany({
      where: { plant_id: readAccess.plant.id },
      orderBy: { created_at: 'asc' },
    });
    if (assets.length) {
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);

      const modelVersions = Object.keys(LANE_BY_MODEL_VERSION);
      const rows = await prisma.$queryRawUnsafe<
        Array<{ time: Date; metric: string; value: number; model_version: string | null }>
      >(
        `SELECT time, metric, value, model_version FROM analysis_results
         WHERE plant_id = $1::uuid AND domain = 'bess'
           AND model_version = ANY($2::text[]) AND time >= $3
         ORDER BY time ASC`,
        readAccess.plant.id,
        modelVersions,
        cutoff,
      );

      const artifact = await readArtifact<any>(readAccess.plant.id, ARTIFACT_KIND);

      if (rows.length) {
        const ledger = ledgerFromRows(rows);
        const assetReports: any[] = Array.isArray(artifact?.payload?.assets)
          ? artifact!.payload.assets
          : [];
        const provenance: Record<string, ProvenanceEntry> = {};
        const notes: string[] = [];
        for (const report of assetReports) {
          Object.assign(provenance, report?.provenance ?? {});
          for (const note of report?.notes ?? []) notes.push(String(note));
          for (const lane of LANE_ORDER) {
            for (const note of report?.lanes?.[lane]?.notes ?? []) {
              ledger[lane].notes.push(String(note));
            }
          }
        }
        const firstSeries = assetReports.find((r) => r?.series)?.series;
        const dates = LANE_ORDER.flatMap((lane) => ledger[lane].series.map((d) => d.date)).sort();

        return NextResponse.json({
          plant: {
            slug: readAccess.plant.slug,
            name: readAccess.plant.name,
            rated_mw:
              Math.round((Number(assets[0].nominal_power_kw) / 1000) * 100) / 100 || null,
            energy_capacity_mwh:
              Math.round((Number(assets[0].nominal_capacity_kwh) / 1000) * 100) / 100 || null,
          },
          window: {
            from: dates[0] ?? null,
            to: dates[dates.length - 1] ?? null,
            days: windowDays,
          },
          ledger,
          provenance,
          kpis: buildKpis(ledger),
          currency: artifact?.payload?.currency ?? 'EUR',
          resolution_minutes: firstSeries?.resolution_minutes ?? null,
          zone: artifact?.payload?.zone ?? null,
          price_source: assetReports.find((r) => r?.price_source)?.price_source ?? null,
          notes,
          coverage: 'ledger',
          generated_at: artifact?.generatedAt ?? null,
          _source: 'database',
        });
      }

      // The nightly ledger has not run for this plant yet. Fall back to the
      // dispatch optimizer's own net revenue, which is the platform's MODELLED
      // schedule and neither a meter nor a settlement. It is served as a single
      // measured-lane line with that caption attached; the declared and
      // benchmark lanes stay honestly empty rather than being padded.
      const scheduleRows = await prisma.bessDispatchSchedule.findMany({
        where: { asset_id: assets[0].id },
        orderBy: { schedule_date: 'desc' },
        take: windowDays,
      });
      if (!scheduleRows.length) {
        return NextResponse.json({
          plant: { slug: plantId, name: readAccess.plant.name, rated_mw: null },
          ledger: { measured: emptyLane(), declared: emptyLane(), benchmark: emptyLane() },
          provenance: {},
          kpis: buildKpis({
            measured: emptyLane(),
            declared: emptyLane(),
            benchmark: emptyLane(),
          }),
          currency: 'EUR',
          resolution_minutes: null,
          coverage: 'not_yet_enabled',
          _source: 'database',
        });
      }

      const ordered = scheduleRows.slice().reverse();
      const currency = ordered.find((r) => r.currency)?.currency ?? 'EUR';
      const ledger: Record<RevenueLane, LaneBlock> = {
        measured: emptyLane(),
        declared: emptyLane(),
        benchmark: emptyLane(),
      };
      ledger.measured.series = ordered.map((r) => ({
        date: r.schedule_date.toISOString().slice(0, 10),
        revenue_modelled_dispatch_net: round(Number(r.net_revenue_eur), 2),
      }));
      ledger.measured.totals = foldTotals(ledger.measured.series);
      ledger.measured.metrics = ['revenue_modelled_dispatch_net'];
      ledger.measured.notes.push(
        'Modelled dispatch, not a meter and not a settlement. The nightly revenue ledger has not run for this plant yet, so the declared and benchmark lanes are empty rather than estimated.',
      );

      return NextResponse.json({
        plant: {
          slug: readAccess.plant.slug,
          name: readAccess.plant.name,
          rated_mw: Math.round((Number(assets[0].nominal_power_kw) / 1000) * 100) / 100 || null,
          energy_capacity_mwh:
            Math.round((Number(assets[0].nominal_capacity_kwh) / 1000) * 100) / 100 || null,
        },
        window: {
          from: ledger.measured.series[0]?.date ?? null,
          to: ledger.measured.series[ledger.measured.series.length - 1]?.date ?? null,
          days: ordered.length,
        },
        ledger,
        provenance: {
          revenue_modelled_dispatch_net: {
            lane: 'measured' as RevenueLane,
            model_version: String(ordered[0].optimizer_type ?? 'dispatch_optimizer'),
            source: 'BessDispatchSchedule',
            caption:
              'Net revenue of the modelled dispatch schedule over published prices. Modelled, not metered and not settled.',
          },
        },
        kpis: buildKpis(ledger),
        currency,
        resolution_minutes: ordered[0].resolution_minutes ?? null,
        coverage: 'dispatch_only',
        _source: 'database',
      });
    }
  }

  // Fixture branch: showcase plants keep working off their shipped JSON.
  const subdir = bessFixtureSubdir(plantId);
  const base = path.join(process.cwd(), 'public', 'data', subdir, plantId);

  const [revenue, assetInfo] = await Promise.all([
    readJson<{ currency: string; days: Array<Record<string, number | string>> }>(
      path.join(base, 'ancillary_revenue_30d.json'),
    ),
    readJson<{ nominal_power_kw?: number; nominal_capacity_kwh?: number }>(
      path.join(base, 'asset_info.json'),
    ),
  ]);

  if (!revenue?.days?.length) {
    return NextResponse.json({
      plant: { slug: plantId, rated_mw: null },
      ledger: { measured: emptyLane(), declared: emptyLane(), benchmark: emptyLane() },
      provenance: {},
      kpis: buildKpis({ measured: emptyLane(), declared: emptyLane(), benchmark: emptyLane() }),
      currency: 'EUR',
      resolution_minutes: null,
      coverage: 'not_yet_enabled',
      _source: 'fixture',
    });
  }

  const days = revenue.days.slice(-windowDays);
  const ledger = ledgerFromFixture(days);
  // The fixture's own per-day total column, summed over the window. rowTotal
  // reads whatever currency suffix the fixture was written with, so this works
  // for both the GBP and EUR specimens.
  const totalsCheck = days.reduce((sum, day) => sum + rowTotal(day), 0);

  return NextResponse.json({
    plant: {
      slug: plantId,
      rated_mw: assetInfo?.nominal_power_kw
        ? Math.round((assetInfo.nominal_power_kw / 1000) * 100) / 100
        : null,
      energy_capacity_mwh: assetInfo?.nominal_capacity_kwh
        ? Math.round((assetInfo.nominal_capacity_kwh / 1000) * 100) / 100
        : null,
    },
    window: {
      from: String(days[0].date),
      to: String(days[days.length - 1].date),
      days: days.length,
    },
    ledger,
    provenance: fixtureProvenance(),
    kpis: buildKpis(ledger),
    currency: revenue.currency,
    resolution_minutes: null,
    coverage: 'fixture',
    // The fixture's own per-day total column, carried so a reader can see the
    // lane split reconciles against it. It is NOT a ledger total: the three
    // lanes are still never summed together.
    fixture_row_total: round(totalsCheck, 2),
    _source: 'fixture',
  });
}
