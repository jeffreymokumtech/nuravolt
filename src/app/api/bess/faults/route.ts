import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { requireOrg, resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

export const runtime = 'nodejs';

/**
 * WarrantyViolationType → the fault_type strings the faults UI already knows
 * (src/types/faults.ts, ReactiveFaultType). CYCLING_FREQUENCY and
 * THROUGHPUT_EXCEED have no member there yet, so faultType() derives
 * 'bess_cycling_frequency' / 'bess_throughput_exceed' instead of mislabelling
 * them as a neighbouring type.
 */
const FAULT_TYPE_BY_VIOLATION: Record<string, string> = {
  TEMPERATURE_EXCEED: 'bess_temperature_exceed',
  SOC_HIGH_DWELL: 'bess_soc_dwell_high',
  SOC_LOW_DWELL: 'bess_soc_dwell_low',
  CYCLING_DEPTH: 'bess_cycling_depth',
  C_RATE_EXCEED: 'bess_c_rate_exceed',
  VOLTAGE_VIOLATION: 'bess_voltage_violation',
  HVAC_FAILURE: 'bess_hvac_failure',
  RTE_DEGRADATION: 'bess_rte_degradation',
  CAPACITY_DEGRADATION: 'bess_capacity_degradation',
};

const faultType = (t: string): string =>
  FAULT_TYPE_BY_VIOLATION[t] ?? `bess_${t.toLowerCase()}`;

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

const severityOf = (s: string | null | undefined): 'critical' | 'warning' | 'info' =>
  s === 'critical' || s === 'warning' ? s : 'info';

/** Sentence-case label from an enum member, used only for the fallback message. */
function humanType(t: string): string {
  const words = t.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface ViolationLike {
  id: string;
  violation_type: string;
  started_at: string | Date;
  ended_at?: string | Date | null;
  duration_minutes?: number | null;
  severity?: string | null;
  measured_value?: unknown;
  threshold_value?: unknown;
  description?: string | null;
  ticket_id?: string | null;
}

/**
 * Map one warranty violation onto the reactive-fault shape the faults UI reads.
 * `power_loss_kw` / `energy_loss_kwh` stay at zero on purpose: the warranty
 * tables carry no per-violation energy attribution, and an invented number
 * would flow straight into the fleet loss totals.
 */
function toReactiveFault(
  v: ViolationLike,
  equipment: { id: string; name: string }
) {
  const start = new Date(v.started_at);
  const end = v.ended_at ? new Date(v.ended_at) : null;
  const duration =
    v.duration_minutes ??
    Math.max(
      0,
      Math.round(((end ? end.getTime() : Date.now()) - start.getTime()) / 60_000)
    );

  return {
    id: v.id,
    fault_type: faultType(v.violation_type),
    severity: severityOf(v.severity),
    asset_type: 'bess',
    equipment_id: equipment.id,
    equipment_name: equipment.name,
    timestamp_start: start.toISOString(),
    timestamp_end: end ? end.toISOString() : null,
    value: numOrNull(v.measured_value),
    threshold: numOrNull(v.threshold_value),
    message:
      v.description ?? `${humanType(v.violation_type)} warranty violation recorded.`,
    duration_minutes: duration,
    power_loss_kw: 0,
    energy_loss_kwh: 0,
    ticket_id: v.ticket_id ?? undefined,
  };
}

function buildResponse(
  reactive_faults: ReturnType<typeof toReactiveFault>[],
  source: 'database' | 'fixture',
  currency: string
) {
  // No BESS RUL model persists predictions today. The warranty snapshot carries
  // a projected EoL date but no confidence, which the faults UI renders as a
  // percentage — so we return an honest empty list instead of inventing one.
  const predictive_faults: never[] = [];

  return NextResponse.json({
    reactive_faults,
    predictive_faults,
    summary: {
      reactive_count: reactive_faults.length,
      predictive_count: predictive_faults.length,
      critical_count: reactive_faults.filter((f) => f.severity === 'critical').length,
      current_loss_kwh: 0,
      current_loss_value: 0,
      projected_loss_kwh: 0,
      currency,
    },
    _source: source,
  });
}

/**
 * GET /api/bess/faults?plantId=...
 *
 * Reactive BESS faults, read from BessWarrantyViolation joined through
 * BessAsset to the caller's plants. With no plantId the response covers every
 * BESS asset in the caller's org. An org with no violations gets an empty list,
 * never fixtures; static JSON is only served for demo/showcase slugs.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const plantId = searchParams.get('plantId');

    let assets: Array<{ id: string; external_asset_id: string; name: string | null }> = [];
    let currency = 'EUR';
    let fixturePlantId: string | null = null;

    if (plantId) {
      // Tenancy: org-owned plants need a session + PlantAccess; demo/showcase
      // plants stay publicly readable.
      const readAccess = await resolvePlantForRead(plantId);
      if (!readAccess.ok) return readAccess.response;
      if (readAccess.access === 'org') {
        const gate = await requireFeature(
          readAccess.ctx.authOrgId,
          'analytics:fault_detection'
        );
        if (gate) return gate;
      }

      if (readAccess.plant) {
        currency = readAccess.plant.currency ?? currency;
        assets = await prisma.bessAsset.findMany({
          where: { plant_id: readAccess.plant.id, enabled: true },
          select: { id: true, external_asset_id: true, name: true },
          orderBy: { created_at: 'asc' },
        });
      }
      // Only demo/showcase slugs may fall back to static JSON.
      if (!assets.length && readAccess.access === 'public') fixturePlantId = plantId;
    } else {
      // Fleet-wide: every BESS asset the caller's org owns.
      const orgResult = await requireOrg();
      if (orgResult.ok) {
        const gate = await requireFeature(
          orgResult.ctx.authOrgId,
          'analytics:fault_detection'
        );
        if (gate) return gate;
        assets = await prisma.bessAsset.findMany({
          where: { enabled: true, plant: { organization_id: orgResult.ctx.org.id } },
          select: { id: true, external_asset_id: true, name: true },
          orderBy: { created_at: 'asc' },
        });
      }
    }

    // Database branch.
    if (assets.length) {
      const byAsset = new Map(assets.map((a) => [a.id, a]));
      const violations = await prisma.bessWarrantyViolation.findMany({
        where: { asset_id: { in: assets.map((a) => a.id) } },
        orderBy: { started_at: 'desc' },
      });

      // A BESS_SAFETY PlantAlert kind is being added in a later arc: those rows
      // join in here, mapped onto the same reactive-fault shape and merged into
      // `reactive_faults` before the summary is computed.
      const reactive_faults = violations.map((v) => {
        const asset = byAsset.get(v.asset_id)!;
        return toReactiveFault(
          { ...v, violation_type: v.violation_type as string },
          {
            id: asset.external_asset_id,
            name: asset.name ?? asset.external_asset_id,
          }
        );
      });

      return buildResponse(reactive_faults, 'database', currency);
    }

    // Fixture branch (demo/showcase slugs only).
    if (fixturePlantId) {
      const base = path.join(
        process.cwd(),
        'public',
        'data',
        bessFixtureSubdir(fixturePlantId),
        fixturePlantId
      );
      const [violationsRaw, assetRaw] = await Promise.all([
        fs.readFile(path.join(base, 'warranty_violations.json'), 'utf-8').catch(() => null),
        fs.readFile(path.join(base, 'asset_info.json'), 'utf-8').catch(() => null),
      ]);

      if (violationsRaw) {
        const assetInfo = assetRaw ? JSON.parse(assetRaw) : {};
        const equipment = {
          id: assetInfo.asset_id ?? fixturePlantId,
          name: assetInfo.name ?? assetInfo.asset_id ?? fixturePlantId,
        };
        const reactive_faults = (JSON.parse(violationsRaw) as any[]).map((v) =>
          toReactiveFault({ ...v, violation_type: v.type }, equipment)
        );
        return buildResponse(reactive_faults, 'fixture', currency);
      }
    }

    // Nothing to report is a valid answer, not an error.
    return buildResponse([], 'database', currency);
  } catch (error) {
    console.error('Error in /api/bess/faults:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
