import { NextRequest, NextResponse } from 'next/server';
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { allowDemoData, requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

export const runtime = 'nodejs';

interface SohRow {
  date: string;
  soh: number;
  source?: string;
  cumulative_cycles?: number;
}

interface CycleRow {
  date: string;
  rte?: number;
  round_trip_efficiency?: number;
}

interface ViolationRow {
  started_at: string;
  ended_at?: string | null;
  severity?: string;
  type?: string;
  description?: string;
}

interface AssetSeries {
  plant: string;
  asset_name: string;
  /** ISO YYYY-MM-DD strings. */
  days: string[];
  /** SoH (%) per day, interpolated from sparse snapshots. */
  soh_pct: number[];
  /** Day-over-day SoH change (percentage points, ×100). */
  soh_delta_pct: Array<number | null>;
  /** RTE (%) per day, last-known-value-forward. */
  rte_pct: Array<number | null>;
  /** Count of violations starting on that day. */
  violations: number[];
  /** Latest SoH (%). */
  current_soh: number;
  /** Number of violations in window. */
  violation_total: number;
  /** Trend label. */
  trend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Fixture plants, discovered from disk rather than a hardcoded list.
 * bessFixtureSubdir() stays the single source of truth for where a slug's
 * fixtures live, so a directory filed under the wrong root is ignored.
 */
async function fixturePlantIds(): Promise<string[]> {
  const roots: Array<'showcase/bess' | 'bess'> = ['showcase/bess', 'bess'];
  const found: string[] = [];
  for (const root of roots) {
    const dir = path.join(process.cwd(), 'public', 'data', ...root.split('/'));
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch((): Dirent[] => []);
    for (const entry of entries) {
      if (entry.isDirectory() && bessFixtureSubdir(entry.name) === root) {
        found.push(entry.name);
      }
    }
  }
  return found.sort();
}

/** Linearly interpolate SoH from sparse history onto a daily grid. */
function interpolateSoh(history: SohRow[], dayList: string[]): number[] {
  if (!history.length) return dayList.map(() => 100);
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const out: number[] = [];
  for (const day of dayList) {
    if (day <= sorted[0].date) {
      out.push(sorted[0].soh * 100);
      continue;
    }
    if (day >= sorted[sorted.length - 1].date) {
      out.push(sorted[sorted.length - 1].soh * 100);
      continue;
    }
    let lo = 0;
    while (lo < sorted.length - 1 && sorted[lo + 1].date <= day) lo++;
    const hi = Math.min(lo + 1, sorted.length - 1);
    const t0 = sorted[lo].date;
    const t1 = sorted[hi].date;
    const v0 = sorted[lo].soh * 100;
    const v1 = sorted[hi].soh * 100;
    const span = (new Date(t1).getTime() - new Date(t0).getTime()) / 86_400_000;
    const into = (new Date(day).getTime() - new Date(t0).getTime()) / 86_400_000;
    out.push(span > 0 ? v0 + ((v1 - v0) * into) / span : v0);
  }
  return out;
}

function dayList(endDateStr: string, days: number): string[] {
  const end = new Date(endDateStr + 'T00:00:00Z');
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Shared series assembly, so the DB and fixture paths produce one shape. */
function buildSeries(input: {
  plant: string;
  assetName: string;
  grid: string[];
  sohHistory: SohRow[];
  rteByDay: Map<string, number>;
  violationDays: string[];
}): AssetSeries {
  const { plant, assetName, grid, sohHistory, rteByDay, violationDays } = input;

  const sohPct = interpolateSoh(sohHistory, grid);
  const sohDelta: Array<number | null> = sohPct.map((v, i) =>
    i === 0 ? null : Math.round((v - sohPct[i - 1]) * 100) / 100
  );

  const rtePct: Array<number | null> = [];
  let lastRte: number | null = null;
  for (const day of grid) {
    if (rteByDay.has(day)) lastRte = rteByDay.get(day)!;
    rtePct.push(lastRte);
  }

  const violCount: Record<string, number> = {};
  for (const day of violationDays) {
    violCount[day] = (violCount[day] ?? 0) + 1;
  }
  const violations_day = grid.map((d) => violCount[d] ?? 0);

  const current_soh = sohPct[sohPct.length - 1];
  const slope = sohPct[sohPct.length - 1] - sohPct[0];

  return {
    plant,
    asset_name: assetName,
    days: grid,
    soh_pct: sohPct.map((v) => Math.round(v * 100) / 100),
    soh_delta_pct: sohDelta,
    rte_pct: rtePct,
    violations: violations_day,
    current_soh: Math.round(current_soh * 100) / 100,
    violation_total: violations_day.reduce((s, x) => s + x, 0),
    trend: slope > 0.1 ? 'IMPROVING' : slope < -0.3 ? 'DEGRADING' : 'STABLE',
  };
}

function fleetResponse(
  days: number,
  grid: string[],
  assets: AssetSeries[],
  availableEnergyKwh: number,
  source: 'database' | 'fixture'
) {
  // Sort assets: worst SoH first (the rows an operator needs at the top).
  assets.sort((a, b) => a.current_soh - b.current_soh);

  const fleetAvgSoh = assets.length
    ? Math.round(
        (assets.reduce((s, a) => s + a.current_soh, 0) / assets.length) * 100
      ) / 100
    : 0;
  const fleetViolations = assets.reduce((s, a) => s + a.violation_total, 0);
  const fleetHealthScore = assets.length
    ? Math.max(
        0,
        Math.round(100 - (100 - fleetAvgSoh) * 2 - fleetViolations * 3)
      )
    : 0;

  return NextResponse.json({
    days,
    window: { from: grid[0], to: grid[grid.length - 1] },
    assets,
    kpis: {
      available_energy_gwh:
        Math.round((availableEnergyKwh / 1_000_000) * 1000) / 1000,
      fleet_avg_soh_pct: fleetAvgSoh,
      fleet_violations: fleetViolations,
      fleet_health_score: fleetHealthScore,
    },
    _source: source,
  });
}

/**
 * GET /api/bess/fleet/health?days=90
 *
 * Fleet SoH / RTE / violation heatmap series for every BESS asset the caller's
 * org owns, rolled up from BessWarrantyStatus and BessWarrantyViolation. An org
 * with no BESS assets gets an honest empty fleet; the static fixtures are only
 * served to anonymous showcase visitors and the demo identity.
 */
export async function GET(request: NextRequest) {
  try {
    // Try the session; anonymous callers get showcase content only.
    const orgResult = await requireOrg();
    const orgCtx = orgResult.ok ? orgResult.ctx : null;
    if (orgCtx) {
      const gate = await requireFeature(orgCtx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    const url = new URL(request.url);
    const days = Math.max(7, Math.min(180, Number(url.searchParams.get('days') ?? 90)));

    // Database branch.
    const dbAssets = orgCtx
      ? await prisma.bessAsset.findMany({
          where: { enabled: true, plant: { organization_id: orgCtx.org.id } },
          select: {
            id: true,
            name: true,
            external_asset_id: true,
            nominal_capacity_kwh: true,
            plant: { select: { slug: true, name: true } },
          },
          orderBy: { created_at: 'asc' },
        })
      : [];

    if (dbAssets.length) {
      const assetIds = dbAssets.map((a) => a.id);
      const [statusRows, violationRows] = await Promise.all([
        prisma.bessWarrantyStatus.findMany({
          where: { asset_id: { in: assetIds } },
          select: {
            asset_id: true,
            snapshot_date: true,
            current_soh: true,
            avg_rte_30d: true,
          },
          orderBy: { snapshot_date: 'asc' },
        }),
        prisma.bessWarrantyViolation.findMany({
          where: { asset_id: { in: assetIds } },
          select: { asset_id: true, started_at: true },
          orderBy: { started_at: 'asc' },
        }),
      ]);

      // Anchor the window to the latest snapshot rather than "today": a plant
      // whose telemetry stopped weeks ago would otherwise show a flat forward
      // filled line pretending to be current.
      const latestTs = Math.max(
        ...statusRows.map((r) => r.snapshot_date.getTime()),
        ...violationRows.map((r) => r.started_at.getTime()),
        0
      );
      const endDate = latestTs > 0 ? isoDay(new Date(latestTs)) : isoDay(new Date());
      const grid = dayList(endDate, days);

      const assets: AssetSeries[] = [];
      let availableEnergyKwh = 0;

      for (const asset of dbAssets) {
        const rows = statusRows.filter((r) => r.asset_id === asset.id);
        // No SoH evidence at all means there is nothing honest to plot for this
        // asset, so it stays out of the heatmap instead of defaulting to 100%.
        if (!rows.length) continue;

        const rteByDay = new Map<string, number>();
        for (const r of rows) {
          if (r.avg_rte_30d != null) {
            rteByDay.set(isoDay(r.snapshot_date), Number(r.avg_rte_30d) * 100);
          }
        }

        assets.push(
          buildSeries({
            plant: asset.plant.slug,
            assetName: asset.name ?? asset.plant.name ?? asset.external_asset_id,
            grid,
            sohHistory: rows.map((r) => ({
              date: isoDay(r.snapshot_date),
              soh: Number(r.current_soh),
            })),
            rteByDay,
            violationDays: violationRows
              .filter((v) => v.asset_id === asset.id)
              .map((v) => isoDay(v.started_at)),
          })
        );
        availableEnergyKwh += Number(asset.nominal_capacity_kwh);
      }

      return fleetResponse(days, grid, assets, availableEnergyKwh, 'database');
    }

    // Fixture branch: the public showcase and the demo identity only. A real
    // org with no BESS assets falls through to the empty fleet below.
    if (!orgCtx || allowDemoData(orgCtx)) {
      const plants = await fixturePlantIds();

      // Pre-scan all plants to find the latest dated record in the fixtures.
      // The dataset is frozen around early 2026; anchoring to "real today" would
      // leave most plants showing flat values. Use the latest known date instead.
      const preScan = await Promise.all(
        plants.map(async (plant) => {
          const base = path.join(
            process.cwd(),
            'public',
            'data',
            bessFixtureSubdir(plant),
            plant
          );
          const soh = (await readJson<SohRow[]>(path.join(base, 'soh_history.json'))) ?? [];
          const viol =
            (await readJson<ViolationRow[]>(path.join(base, 'warranty_violations.json'))) ?? [];
          return Math.max(
            ...soh.map((s) => new Date(s.date).getTime()),
            ...viol.map((v) => new Date(v.started_at).getTime()),
            0
          );
        })
      );
      const latestTs = preScan.length ? Math.max(...preScan) : 0;
      const endDate = latestTs > 0 ? isoDay(new Date(latestTs)) : isoDay(new Date());
      const grid = dayList(endDate, days);

      const assets: AssetSeries[] = [];
      let availableEnergyKwh = 0;

      for (const plant of plants) {
        const base = path.join(
          process.cwd(),
          'public',
          'data',
          bessFixtureSubdir(plant),
          plant
        );

        const assetInfo = await readJson<{
          name?: string;
          asset_id?: string;
          nominal_capacity_kwh?: number;
        }>(path.join(base, 'asset_info.json'));
        const sohHistory = (await readJson<SohRow[]>(path.join(base, 'soh_history.json'))) ?? [];
        const cyclingDoc = await readJson<{ daily_metrics?: CycleRow[] } | CycleRow[]>(
          path.join(base, 'cycling_metrics.json')
        );
        const cycling: CycleRow[] = Array.isArray(cyclingDoc)
          ? cyclingDoc
          : (cyclingDoc?.daily_metrics ?? []);
        const violations =
          (await readJson<ViolationRow[]>(path.join(base, 'warranty_violations.json'))) ?? [];

        if (!sohHistory.length) continue; // skip plants without SoH fixtures

        const rteByDay = new Map<string, number>();
        for (const c of cycling) {
          const rteRaw = c.rte ?? c.round_trip_efficiency;
          if (rteRaw !== undefined) {
            rteByDay.set(c.date.slice(0, 10), Number(rteRaw) * (rteRaw > 1 ? 1 : 100));
          }
        }

        assets.push(
          buildSeries({
            plant,
            assetName: assetInfo?.name ?? assetInfo?.asset_id ?? plant,
            grid,
            sohHistory,
            rteByDay,
            violationDays: violations.map((v) => v.started_at.slice(0, 10)),
          })
        );
        availableEnergyKwh += Number(assetInfo?.nominal_capacity_kwh ?? 0);
      }

      return fleetResponse(days, grid, assets, availableEnergyKwh, 'fixture');
    }

    // No BESS assets in this org is a valid answer, not an error.
    return fleetResponse(days, dayList(isoDay(new Date()), days), [], 0, 'database');
  } catch (error) {
    console.error('Error in /api/bess/fleet/health:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
