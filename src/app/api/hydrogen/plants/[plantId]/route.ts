import { NextRequest, NextResponse } from 'next/server';
import type { H2Asset, H2ProductionRecord, H2StackHealth } from '@prisma/client';
import type {
  HydrogenPlantResponse,
  H2Asset as H2AssetInfo,
  H2ProductionDay,
  H2StackHealthPoint,
} from '@/types/hydrogen';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

function toAssetInfo(a: H2Asset): H2AssetInfo {
  return {
    id: a.id,
    name: a.name,
    technology: a.technology,
    ratedPowerKw: Number(a.rated_power_kw),
    stackCount: a.stack_count,
    ratedKgPerH: Number(a.rated_kg_per_h),
    secBolKwhPerKg: Number(a.sec_bol_kwh_per_kg),
    currentSecKwhPerKg:
      a.current_sec_kwh_per_kg == null ? null : Number(a.current_sec_kwh_per_kg),
    stackHours: a.stack_hours == null ? null : Number(a.stack_hours),
    manufacturer: a.manufacturer,
    model: a.model,
  };
}

function toProductionDay(r: H2ProductionRecord): H2ProductionDay {
  return {
    date: r.production_date.toISOString().slice(0, 10),
    energyInKwh: Number(r.energy_in_kwh),
    h2OutKg: Number(r.h2_out_kg),
    hoursRun: Number(r.hours_run),
    avgLoadPct: r.avg_load_pct == null ? null : Number(r.avg_load_pct),
    secKwhPerKg: Number(r.sec_kwh_per_kg),
    h2PriceEurPerKg: r.h2_price_eur_per_kg == null ? null : Number(r.h2_price_eur_per_kg),
    revenueEur: r.revenue_eur == null ? null : Number(r.revenue_eur),
    powerCostEur: r.power_cost_eur == null ? null : Number(r.power_cost_eur),
    netMarginEur: r.net_margin_eur == null ? null : Number(r.net_margin_eur),
  };
}

function toHealthPoint(h: H2StackHealth): H2StackHealthPoint {
  return {
    date: h.measured_at.toISOString().slice(0, 10),
    stackHours: Number(h.stack_hours),
    secKwhPerKg: Number(h.sec_kwh_per_kg),
    efficiencyHhvPct: Number(h.efficiency_hhv_pct),
    estRulHours: Number(h.est_rul_hours),
    healthPct: Number(h.health_pct),
  };
}

/**
 * GET /api/hydrogen/plants/[plantId]
 *
 * Electrolyzer asset + daily production/economics + stack-health history.
 * DB-first (rows come from real telemetry or the hydrogen_synth provisional
 * twin); always 200 with `_source: 'empty'` when the plant has no H2 asset.
 * Business+ feature (analytics:hydrogen) on org-owned plants; demo plants
 * stay publicly readable like every other analytics route.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:hydrogen');
      if (gate) return gate;
    }

    const empty: HydrogenPlantResponse = {
      asset: null,
      production: [],
      stackHealth: [],
      _source: 'empty',
    };
    if (!readAccess.plant) return NextResponse.json(empty);

    const asset = await prisma.h2Asset.findFirst({
      where: { plant_id: readAccess.plant.id, enabled: true },
    });
    if (!asset) return NextResponse.json(empty);

    const [production, stackHealth] = await Promise.all([
      prisma.h2ProductionRecord.findMany({
        where: { asset_id: asset.id },
        orderBy: { production_date: 'asc' },
        take: 120,
      }),
      prisma.h2StackHealth.findMany({
        where: { asset_id: asset.id },
        orderBy: { measured_at: 'asc' },
        take: 60,
      }),
    ]);

    const body: HydrogenPlantResponse = {
      asset: toAssetInfo(asset),
      production: production.map(toProductionDay),
      stackHealth: stackHealth.map(toHealthPoint),
      _source: 'database',
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('[hydrogen] error:', error);
    return NextResponse.json({ error: 'Failed to load hydrogen data' }, { status: 500 });
  }
}
