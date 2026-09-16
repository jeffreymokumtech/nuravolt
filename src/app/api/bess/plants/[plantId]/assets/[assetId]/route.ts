import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { BessAsset, BessCycleRecord } from '@prisma/client';
import type {
  BessAssetOverviewResponse,
  BessAssetInfo,
  WarrantyStatus,
  CyclingMetricsSummary,
  WarrantyViolation,
  WarrantyViolationType,
  ViolationSeverity,
  DispatchSchedule,
  WarrantyRiskLevel,
} from '@/types/bess';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { resolvePlantForRead } from '@/lib/api/tenant';
import prisma from '@/libs/prisma';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const toNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)) : [];

/** Map a BessAsset DB row into the camelCase API shape. */
function dbAssetToInfo(a: BessAsset): BessAssetInfo {
  return {
    id: a.id,
    plantId: a.plant_id,
    externalAssetId: a.external_asset_id,
    name: a.name,
    chemistry: a.chemistry as BessAssetInfo['chemistry'],
    nominalCapacityKwh: Number(a.nominal_capacity_kwh),
    nominalPowerKw: Number(a.nominal_power_kw),
    moduleCount: a.module_count,
    rackCount: a.rack_count,
    installationDate: a.installation_date ? isoDay(a.installation_date) : null,
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serial_number,
    currentSoh: numOrNull(a.current_soh),
    currentSoc: numOrNull(a.current_soc),
    lastCapacityTest: a.last_capacity_test
      ? a.last_capacity_test.toISOString()
      : null,
    lastUpdated: (a.last_updated ?? a.updated_at).toISOString(),
    enabled: a.enabled,
  };
}

/** Build the CyclingMetricsSummary from daily BessCycleRecord rows (asc). */
function buildCyclingSummary(
  assetId: string,
  daily: BessCycleRecord[]
): CyclingMetricsSummary | null {
  if (daily.length === 0) return null;
  const latest = daily[daily.length - 1];
  const totalCycles = Number(latest.cumulative_cycles);
  const avg = (f: (d: BessCycleRecord) => number) =>
    daily.reduce((sum, d) => sum + f(d), 0) / daily.length;
  return {
    assetId,
    period: {
      start: isoDay(daily[0].cycle_date),
      end: isoDay(latest.cycle_date),
      days: daily.length,
    },
    totals: {
      equivalentFullCycles: totalCycles,
      throughputMwh: Number(latest.cumulative_throughput_kwh) / 1000,
      energyChargedMwh:
        daily.reduce((s, d) => s + Number(d.energy_in_kwh), 0) / 1000,
      energyDischargedMwh:
        daily.reduce((s, d) => s + Number(d.energy_out_kwh), 0) / 1000,
    },
    averages: {
      dailyCycles: avg((d) => Number(d.equivalent_cycles)),
      dod: avg((d) => Number(d.avg_dod ?? 0)),
      cRate: avg((d) => Number(d.avg_c_rate ?? 0)),
      temperature: avg((d) => Number(d.avg_temp_c ?? 0)),
      roundTripEfficiency: avg((d) => Number(d.round_trip_efficiency ?? 0)),
    },
    limits: {
      maxDod: Math.max(...daily.map((d) => Number(d.avg_dod ?? 0))),
      maxCRate: Math.max(...daily.map((d) => Number(d.max_c_rate ?? 0))),
      maxTemp: Math.max(...daily.map((d) => Number(d.max_temp_c ?? 0))),
      minTemp: Math.min(...daily.map((d) => Number(d.min_temp_c ?? 0))),
    },
    stressMetrics: {
      highSocHoursTotal: daily.reduce(
        (s, d) => s + Number(d.high_soc_hours ?? 0),
        0
      ),
      highTempHoursTotal: daily.reduce(
        (s, d) => s + Number(d.high_temp_hours ?? 0),
        0
      ),
      stressWeightedCycles: totalCycles * 1.1,
    },
    dailyRecords: daily.map((d) => ({
      date: isoDay(d.cycle_date),
      equivalentCycles: Number(d.equivalent_cycles),
      throughputKwh: Number(d.energy_in_kwh) + Number(d.energy_out_kwh),
      avgDod: Number(d.avg_dod ?? 0),
      avgCRate: Number(d.avg_c_rate ?? 0),
      avgTemp: Number(d.avg_temp_c ?? 0),
      roundTripEfficiency: Number(d.round_trip_efficiency ?? 0),
      stressWeightedCycles: Number(d.equivalent_cycles) * 1.1,
    })),
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]
 *
 * Returns complete asset overview with current status, warranty, cycling metrics.
 * DB-first: plants with BessAsset rows are served from Postgres; the static
 * fixture JSON remains the fallback for demo/showcase slugs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string; assetId: string } }
) {
  try {
    const { plantId, assetId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // Database branch: serve the overview from Postgres when the plant has
    // BESS assets. Prefer the requested assetId; fall back to first asset.
    if (readAccess.plant) {
      const dbAsset =
        (await prisma.bessAsset.findFirst({
          where: {
            plant_id: readAccess.plant.id,
            OR: [{ id: assetId }, { external_asset_id: assetId }],
          },
        })) ??
        (await prisma.bessAsset.findFirst({
          where: { plant_id: readAccess.plant.id },
          orderBy: { created_at: 'asc' },
        }));

      if (dbAsset) {
        const [wsRow, cycleRowsDesc, violationRows, dispatchRow] =
          await Promise.all([
            prisma.bessWarrantyStatus.findFirst({
              where: { asset_id: dbAsset.id },
              orderBy: { snapshot_date: 'desc' },
            }),
            prisma.bessCycleRecord.findMany({
              where: { asset_id: dbAsset.id },
              orderBy: { cycle_date: 'desc' },
              take: 90,
            }),
            prisma.bessWarrantyViolation.findMany({
              where: { asset_id: dbAsset.id },
              orderBy: { started_at: 'desc' },
              take: 5,
            }),
            prisma.bessDispatchSchedule.findFirst({
              where: { asset_id: dbAsset.id },
              orderBy: { schedule_date: 'desc' },
            }),
          ]);

        let warrantyStatus: WarrantyStatus | null = null;
        if (wsRow) {
          warrantyStatus = {
            id: wsRow.id,
            assetId: dbAsset.id,
            snapshotDate: isoDay(wsRow.snapshot_date),
            currentSoh: Number(wsRow.current_soh),
            warrantyThreshold: Number(wsRow.warranty_threshold),
            sohMargin: Number(wsRow.soh_margin),
            equivalentFullCycles: Number(wsRow.equivalent_full_cycles),
            totalThroughputMwh: Number(wsRow.total_throughput_mwh),
            cycleUsagePct: Number(wsRow.cycle_usage_pct),
            timeUsagePct: Number(wsRow.time_usage_pct),
            yearsRemaining: Number(wsRow.years_remaining),
            avgRte30d: numOrNull(wsRow.avg_rte_30d),
            warrantyHealthScore: Number(wsRow.warranty_health_score),
            riskLevel: wsRow.risk_level as WarrantyRiskLevel,
            projectedEolDate: wsRow.projected_eol_date
              ? isoDay(wsRow.projected_eol_date)
              : null,
            projectedCyclesToEol: wsRow.projected_cycles_to_eol,
            activeViolations: wsRow.active_violations,
          };
        }

        const cyclingMetrics = buildCyclingSummary(
          dbAsset.id,
          cycleRowsDesc.slice().reverse()
        );

        const recentViolations: WarrantyViolation[] = violationRows.map(
          (v) => ({
            id: v.id,
            assetId: dbAsset.id,
            violationType: v.violation_type as WarrantyViolationType,
            startedAt: v.started_at.toISOString(),
            endedAt: v.ended_at ? v.ended_at.toISOString() : null,
            durationMinutes: v.duration_minutes,
            severity: v.severity as ViolationSeverity,
            measuredValue: numOrNull(v.measured_value),
            thresholdValue: numOrNull(v.threshold_value),
            unit: v.unit,
            description: v.description,
            rootCause: v.root_cause,
            affectedModules: v.affected_modules,
            isResolved: v.is_resolved,
            resolutionNotes: v.resolution_notes,
            resolvedAt: v.resolved_at ? v.resolved_at.toISOString() : null,
            resolvedBy: v.resolved_by,
            ticketId: v.ticket_id,
          })
        );

        let dispatchSchedule: DispatchSchedule | null = null;
        if (dispatchRow) {
          dispatchSchedule = {
            id: dispatchRow.id,
            assetId: dbAsset.id,
            scheduleDate: isoDay(dispatchRow.schedule_date),
            horizonHours: dispatchRow.horizon_hours,
            resolutionMinutes: dispatchRow.resolution_minutes,
            chargeScheduleKw: toNumberArray(dispatchRow.charge_schedule_kw),
            dischargeScheduleKw: toNumberArray(
              dispatchRow.discharge_schedule_kw
            ),
            socSchedule: toNumberArray(dispatchRow.soc_schedule),
            priceForecast: toNumberArray(dispatchRow.price_forecast),
            expectedRevenueEur: Number(dispatchRow.expected_revenue_eur),
            degradationCostEur: Number(dispatchRow.degradation_cost_eur),
            netRevenueEur: Number(dispatchRow.net_revenue_eur),
            expectedCycles: Number(dispatchRow.expected_cycles),
            avgDod: numOrNull(dispatchRow.avg_dod),
            optimizerType: dispatchRow.optimizer_type as any,
            objectiveFunction:
              (dispatchRow.objective_function as any) ?? 'balanced',
            solveTimeMs: dispatchRow.solve_time_ms,
            status: dispatchRow.status as any,
            solverMessage: dispatchRow.solver_message,
            warrantyConstrained: dispatchRow.warranty_constrained,
            maxCyclesConstrained: dispatchRow.max_cycles_constrained,
          };
        }

        const response: BessAssetOverviewResponse & { _source: string } = {
          asset: dbAssetToInfo(dbAsset),
          warrantyStatus,
          cyclingMetrics,
          recentViolations,
          dispatchSchedule,
          metadata: {
            generatedAt: new Date().toISOString(),
            dataSource: 'database',
          },
          _source: 'database',
        };
        return NextResponse.json(response);
      }
    }

    // Showcase plants live under public/data/showcase/bess/{plantId}/.
    const baseSubdir = bessFixtureSubdir(plantId);
    const basePath = path.join(process.cwd(), 'public', 'data', baseSubdir, plantId);

    // Load all required data files
    const [assetData, warrantyData, cyclingData, violationsData, dispatchData] = await Promise.all([
      fs.readFile(path.join(basePath, 'asset_info.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'warranty_status.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'cycling_metrics.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'warranty_violations.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'dispatch_schedule.json'), 'utf-8').catch(() => null),
    ]);

    if (!assetData) {
      return NextResponse.json(
        { error: `BESS asset not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const assetInfo = JSON.parse(assetData);
    const warrantyInfo = warrantyData ? JSON.parse(warrantyData) : null;
    const cyclingInfo = cyclingData ? JSON.parse(cyclingData) : null;
    const violations = violationsData ? JSON.parse(violationsData) : [];
    const dispatch = dispatchData ? JSON.parse(dispatchData) : null;

    // Transform asset info
    const asset: BessAssetInfo = {
      id: assetInfo.asset_id,
      plantId: assetInfo.plant_id,
      externalAssetId: assetInfo.asset_id,
      name: assetInfo.name,
      chemistry: assetInfo.chemistry,
      nominalCapacityKwh: assetInfo.nominal_capacity_kwh,
      nominalPowerKw: assetInfo.nominal_power_kw,
      moduleCount: assetInfo.module_count || null,
      rackCount: assetInfo.rack_count || null,
      installationDate: assetInfo.installation_date,
      manufacturer: assetInfo.manufacturer,
      model: assetInfo.model,
      serialNumber: assetInfo.serial_number || null,
      currentSoh: assetInfo.current_soh,
      currentSoc: assetInfo.current_soc,
      lastCapacityTest: null,
      lastUpdated: new Date().toISOString(),
      enabled: true,
    };

    // Transform warranty status
    let warrantyStatus: WarrantyStatus | null = null;
    if (warrantyInfo) {
      const wh = warrantyInfo.warranty_health;
      warrantyStatus = {
        id: `ws-${plantId}`,
        assetId: assetInfo.asset_id,
        snapshotDate: warrantyInfo.snapshot_date,
        currentSoh: wh.current_soh,
        warrantyThreshold: wh.warranty_threshold,
        sohMargin: wh.soh_margin,
        equivalentFullCycles: wh.cycles_used,
        totalThroughputMwh: cyclingInfo?.total_throughput_mwh || 0,
        cycleUsagePct: wh.cycles_used / (wh.cycles_used + wh.cycles_remaining),
        timeUsagePct: 1 - (wh.years_remaining / (warrantyInfo.warranty_terms?.warranty_years || 10)),
        yearsRemaining: wh.years_remaining,
        avgRte30d: null,
        warrantyHealthScore: wh.score,
        riskLevel: wh.risk_level as WarrantyRiskLevel,
        projectedEolDate: null,
        projectedCyclesToEol: wh.cycles_remaining,
        activeViolations: violations.filter((v: any) => !v.is_resolved).length,
      };
    }

    // Transform cycling metrics
    let cyclingMetrics: CyclingMetricsSummary | null = null;
    if (cyclingInfo?.daily_metrics) {
      const dailyMetrics = cyclingInfo.daily_metrics;
      cyclingMetrics = {
        assetId: assetInfo.asset_id,
        period: {
          start: dailyMetrics[0]?.date || '',
          end: dailyMetrics[dailyMetrics.length - 1]?.date || '',
          days: dailyMetrics.length,
        },
        totals: {
          equivalentFullCycles: cyclingInfo.total_cycles,
          throughputMwh: cyclingInfo.total_throughput_mwh,
          energyChargedMwh: cyclingInfo.total_throughput_mwh / 2,
          energyDischargedMwh: cyclingInfo.total_throughput_mwh / 2 * 0.88,
        },
        averages: {
          dailyCycles: dailyMetrics.reduce((sum: number, d: any) => sum + d.equivalent_cycles, 0) / dailyMetrics.length,
          dod: dailyMetrics.reduce((sum: number, d: any) => sum + d.avg_dod, 0) / dailyMetrics.length,
          cRate: dailyMetrics.reduce((sum: number, d: any) => sum + (d.avg_c_rate || 0.3), 0) / dailyMetrics.length,
          temperature: dailyMetrics.reduce((sum: number, d: any) => sum + (d.avg_temp_c || 25), 0) / dailyMetrics.length,
          roundTripEfficiency: dailyMetrics.reduce((sum: number, d: any) => sum + (d.round_trip_efficiency || 0.88), 0) / dailyMetrics.length,
        },
        limits: {
          maxDod: Math.max(...dailyMetrics.map((d: any) => d.avg_dod)),
          maxCRate: Math.max(...dailyMetrics.map((d: any) => d.max_c_rate || 0.6)),
          maxTemp: Math.max(...dailyMetrics.map((d: any) => d.max_temp_c || 30)),
          minTemp: Math.min(...dailyMetrics.map((d: any) => d.min_temp_c || 20)),
        },
        stressMetrics: {
          highSocHoursTotal: dailyMetrics.reduce((sum: number, d: any) => sum + (d.high_soc_hours || 0), 0),
          highTempHoursTotal: dailyMetrics.reduce((sum: number, d: any) => sum + (d.high_temp_hours || 0), 0),
          stressWeightedCycles: cyclingInfo.total_cycles * 1.1,
        },
        dailyRecords: dailyMetrics.map((d: any) => ({
          date: d.date,
          equivalentCycles: d.equivalent_cycles,
          throughputKwh: d.energy_in_kwh + d.energy_out_kwh,
          avgDod: d.avg_dod,
          avgCRate: d.avg_c_rate || 0.3,
          avgTemp: d.avg_temp_c || 25,
          roundTripEfficiency: d.round_trip_efficiency || 0.88,
          stressWeightedCycles: d.equivalent_cycles * 1.1,
        })),
      };
    }

    // Transform violations
    const recentViolations: WarrantyViolation[] = violations.slice(0, 5).map((v: any) => ({
      id: v.id,
      assetId: assetInfo.asset_id,
      violationType: v.type,
      startedAt: v.started_at,
      endedAt: v.ended_at,
      durationMinutes: v.duration_minutes,
      severity: v.severity,
      measuredValue: v.measured_value,
      thresholdValue: v.threshold_value,
      unit: v.unit,
      description: v.description,
      rootCause: null,
      affectedModules: [],
      isResolved: v.is_resolved,
      resolutionNotes: null,
      resolvedAt: null,
      resolvedBy: null,
      ticketId: null,
    }));

    // Transform dispatch schedule
    let dispatchSchedule: DispatchSchedule | null = null;
    if (dispatch) {
      dispatchSchedule = {
        id: `ds-${plantId}`,
        assetId: assetInfo.asset_id,
        scheduleDate: dispatch.schedule_date,
        horizonHours: dispatch.horizon_hours,
        resolutionMinutes: dispatch.resolution_minutes,
        chargeScheduleKw: dispatch.charge_schedule_kw,
        dischargeScheduleKw: dispatch.discharge_schedule_kw,
        socSchedule: dispatch.soc_schedule,
        priceForecast: dispatch.price_forecast,
        expectedRevenueEur: dispatch.expected_revenue_eur,
        degradationCostEur: dispatch.degradation_cost_eur,
        netRevenueEur: dispatch.net_revenue_eur,
        expectedCycles: dispatch.expected_cycles,
        avgDod: null,
        optimizerType: dispatch.optimizer_type as any,
        objectiveFunction: 'balanced',
        solveTimeMs: null,
        status: dispatch.status as any,
        solverMessage: null,
        warrantyConstrained: false,
        maxCyclesConstrained: false,
      };
    }

    const response: BessAssetOverviewResponse = {
      asset,
      warrantyStatus,
      cyclingMetrics,
      recentViolations,
      dispatchSchedule,
      metadata: {
        generatedAt: new Date().toISOString(),
        dataSource: 'demo',
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]/assets/[assetId]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
