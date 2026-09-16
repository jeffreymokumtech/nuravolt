import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type {
  DispatchScheduleResponse,
  DispatchSchedule,
  DispatchSlot,
  ArbitrageOpportunity,
} from '@/types/bess';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

const toNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)) : [];

/** Snake-case dispatch record — fixture JSON shape and DB rows both map into this. */
interface RawDispatch {
  schedule_date: string;
  horizon_hours: number;
  resolution_minutes: number;
  charge_schedule_kw: number[];
  discharge_schedule_kw: number[];
  soc_schedule: number[];
  price_forecast: number[];
  expected_revenue_eur: number;
  degradation_cost_eur: number;
  net_revenue_eur: number;
  expected_cycles: number;
  avg_dod?: number | null;
  optimizer_type?: string;
  objective_function?: string | null;
  solve_time_ms?: number | null;
  status?: string;
  solver_message?: string | null;
  warranty_constrained?: boolean;
  max_cycles_constrained?: boolean;
}

/**
 * Shared transform: schedule + slots + summary + arbitrage opportunities.
 * Pure computation over the snake-case dispatch record; used by both the
 * database branch and the fixture fallback.
 */
function buildDispatchResponse(
  dispatch: RawDispatch,
  assetId: string,
  scheduleId: string
): DispatchScheduleResponse {
  // Build schedule object
  const schedule: DispatchSchedule = {
    id: scheduleId,
    assetId,
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
    avgDod: dispatch.avg_dod ?? null,
    optimizerType: (dispatch.optimizer_type as any) || 'rule_based',
    objectiveFunction: (dispatch.objective_function as any) ?? 'balanced',
    solveTimeMs: dispatch.solve_time_ms ?? null,
    status: (dispatch.status as any) || 'optimal',
    solverMessage: dispatch.solver_message ?? null,
    warrantyConstrained: dispatch.warranty_constrained ?? false,
    maxCyclesConstrained: dispatch.max_cycles_constrained ?? false,
  };

  // Generate time slots
  const baseDate = new Date(dispatch.schedule_date);
  const slots: DispatchSlot[] = [];

  for (let hour = 0; hour < 24; hour++) {
    const timestamp = new Date(baseDate);
    timestamp.setHours(hour, 0, 0, 0);

    const chargeKw = dispatch.charge_schedule_kw[hour] || 0;
    const dischargeKw = dispatch.discharge_schedule_kw[hour] || 0;

    let action: 'charge' | 'discharge' | 'idle' = 'idle';
    if (chargeKw < 0) action = 'charge';
    else if (dischargeKw > 0) action = 'discharge';

    slots.push({
      timestamp: timestamp.toISOString(),
      hour,
      chargeKw: Math.abs(chargeKw),
      dischargeKw,
      soc: dispatch.soc_schedule[hour] || 0.5,
      priceEurMwh: dispatch.price_forecast[hour] || 50,
      action,
    });
  }

  // Calculate summary
  const totalChargeKwh = slots.reduce(
    (sum, s) => sum + (s.action === 'charge' ? s.chargeKw : 0),
    0
  );
  const totalDischargeKwh = slots.reduce(
    (sum, s) => sum + (s.action === 'discharge' ? s.dischargeKw : 0),
    0
  );

  // Identify arbitrage opportunities (charge windows followed by discharge windows)
  const arbitrageOpportunities: ArbitrageOpportunity[] = [];

  // Find charging windows (low price periods)
  const chargingSlots = slots.filter((s) => s.action === 'charge');
  const dischargingSlots = slots.filter((s) => s.action === 'discharge');

  if (chargingSlots.length > 0 && dischargingSlots.length > 0) {
    // Simple: combine all charging and all discharging into one opportunity
    const avgChargePrice =
      chargingSlots.reduce((sum, s) => sum + s.priceEurMwh, 0) /
      chargingSlots.length;
    const avgDischargePrice =
      dischargingSlots.reduce((sum, s) => sum + s.priceEurMwh, 0) /
      dischargingSlots.length;

    const spread = avgDischargePrice - avgChargePrice;

    if (spread > 10) {
      // Only show if meaningful spread
      arbitrageOpportunities.push({
        chargeWindow: {
          start: chargingSlots[0].timestamp,
          end: chargingSlots[chargingSlots.length - 1].timestamp,
          avgPriceEurMwh: Math.round(avgChargePrice),
        },
        dischargeWindow: {
          start: dischargingSlots[0].timestamp,
          end: dischargingSlots[dischargingSlots.length - 1].timestamp,
          avgPriceEurMwh: Math.round(avgDischargePrice),
        },
        spread: Math.round(spread),
        expectedRevenueEur: dispatch.expected_revenue_eur,
        degradationCostEur: dispatch.degradation_cost_eur,
        netRevenueEur: dispatch.net_revenue_eur,
        requiredCycles: dispatch.expected_cycles,
      });
    }
  }

  return {
    assetId,
    schedule,
    slots,
    summary: {
      totalChargeKwh: Math.round(totalChargeKwh),
      totalDischargeKwh: Math.round(totalDischargeKwh),
      expectedRevenueEur: dispatch.expected_revenue_eur,
      degradationCostEur: dispatch.degradation_cost_eur,
      netRevenueEur: dispatch.net_revenue_eur,
      expectedCycles: dispatch.expected_cycles,
    },
    arbitrageOpportunities,
    metadata: {
      generatedAt: new Date().toISOString(),
      optimizerType: dispatch.optimizer_type || 'rule_based',
      status: dispatch.status || 'optimal',
    },
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/dispatch
 *
 * Returns current dispatch schedule with arbitrage opportunities.
 * DB-first: plants with BessAsset rows are served from Postgres
 * (BessDispatchSchedule); the static fixture JSON remains the fallback for
 * demo/showcase slugs.
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
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    // Database branch.
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
        // Today's schedule if present, else the latest available run.
        const today = new Date(new Date().toISOString().slice(0, 10));
        const row =
          (await prisma.bessDispatchSchedule.findFirst({
            where: { asset_id: dbAsset.id, schedule_date: today },
          })) ??
          (await prisma.bessDispatchSchedule.findFirst({
            where: { asset_id: dbAsset.id },
            orderBy: { schedule_date: 'desc' },
          }));

        if (!row) {
          // A real asset with no optimizer runs yet is a valid state:
          // serve an honest empty payload instead of fixture data.
          return NextResponse.json({
            assetId: dbAsset.id,
            schedule: null,
            slots: [],
            summary: {
              totalChargeKwh: 0,
              totalDischargeKwh: 0,
              expectedRevenueEur: 0,
              degradationCostEur: 0,
              netRevenueEur: 0,
              expectedCycles: 0,
            },
            arbitrageOpportunities: [],
            metadata: {
              generatedAt: new Date().toISOString(),
              optimizerType: 'none',
              status: 'no_schedule',
            },
            _source: 'database',
          });
        }

        const raw: RawDispatch = {
          schedule_date: row.schedule_date.toISOString().slice(0, 10),
          horizon_hours: row.horizon_hours,
          resolution_minutes: row.resolution_minutes,
          charge_schedule_kw: toNumberArray(row.charge_schedule_kw),
          discharge_schedule_kw: toNumberArray(row.discharge_schedule_kw),
          soc_schedule: toNumberArray(row.soc_schedule),
          price_forecast: toNumberArray(row.price_forecast),
          expected_revenue_eur: Number(row.expected_revenue_eur),
          degradation_cost_eur: Number(row.degradation_cost_eur),
          net_revenue_eur: Number(row.net_revenue_eur),
          expected_cycles: Number(row.expected_cycles),
          avg_dod: row.avg_dod == null ? null : Number(row.avg_dod),
          optimizer_type: row.optimizer_type,
          objective_function: row.objective_function,
          solve_time_ms: row.solve_time_ms,
          status: row.status,
          solver_message: row.solver_message,
          warranty_constrained: row.warranty_constrained,
          max_cycles_constrained: row.max_cycles_constrained,
        };
        return NextResponse.json({
          ...buildDispatchResponse(raw, dbAsset.id, row.id),
          _source: 'database',
        });
      }
    }

    const baseSubdir = bessFixtureSubdir(plantId);
    const basePath = path.join(process.cwd(), 'public', 'data', baseSubdir, plantId);

    // Load dispatch schedule and asset info
    const [dispatchData, assetData] = await Promise.all([
      fs.readFile(path.join(basePath, 'dispatch_schedule.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'asset_info.json'), 'utf-8').catch(() => null),
    ]);

    if (!dispatchData) {
      return NextResponse.json(
        { error: `Dispatch schedule not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const dispatch = JSON.parse(dispatchData) as RawDispatch;
    const assetInfo = assetData ? JSON.parse(assetData) : { asset_id: 'unknown' };

    return NextResponse.json(
      buildDispatchResponse(dispatch, assetInfo.asset_id, `ds-${plantId}`)
    );
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]/assets/[assetId]/dispatch:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
