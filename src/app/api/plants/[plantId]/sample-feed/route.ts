import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { triggerPlantOnboarding } from '@/lib/analytics/trigger-onboarding';
import { generateSampleFeed, defaultFleet, type SampleDevice } from '@/lib/sample/inverter-feed';

/**
 * POST /api/plants/[plantId]/sample-feed
 *
 * Turn on a sandbox "sample inverter feed" for a plant: provision a synthetic
 * DataConnection + PlantDataSource + field mappings, generate realistic
 * per-inverter telemetry into `measurements` + `LatestDeviceSnapshot`, then
 * kick the existing onboarding pipeline so the twin / soiling / faults refresh
 * over the sample data. This is the anti-dead-end for a paying customer who
 * wants to try the "Inverter API" without real vendor credentials.
 *
 * Idempotent: re-running upserts the connection + measurements deterministically.
 */

const FIELD_MAPPINGS: Array<{ from: string; to: string; unit: string; confidence: number }> = [
  { from: 'INV1.P_AC', to: 'power_ac', unit: 'kW', confidence: 1.0 },
  { from: 'INV1.G_POA', to: 'irradiance_poa', unit: 'W/m2', confidence: 0.95 },
  { from: 'INV1.T_MOD', to: 'temp_module', unit: 'degC', confidence: 0.9 },
];

export async function POST(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
  if (!access.ok) return access.response;
  const { ctx } = orgResult;
  const plant = access.plant;

  try {
    // --- resolve the inverter fleet (configured, else a default fleet) ---
    const inverters = await prisma.inverter.findMany({
      where: { group: { plant_id: plant.id } },
      select: { external_id: true, nominal_power_kw: true, group: { select: { inverter_nominal_power_kw: true } } },
      orderBy: { external_id: 'asc' },
    });

    let devices: SampleDevice[];
    if (inverters.length > 0) {
      devices = inverters.map((i) => ({
        externalId: i.external_id,
        nominalPowerKw: Number(i.nominal_power_kw ?? i.group?.inverter_nominal_power_kw ?? 200),
      }));
    } else {
      devices = defaultFleet(Number(plant.capacity_mw));
    }

    // --- upsert the sample connection (idempotent by deterministic name) ---
    const connName = `Sample inverter feed (${plant.slug})`;
    let connection = await prisma.dataConnection.findFirst({
      where: { organization_id: ctx.org.id, name: connName },
      select: { id: true },
    });
    if (!connection) {
      connection = await prisma.dataConnection.create({
        data: {
          customer_id: ctx.authOrgId,
          organization_id: ctx.org.id,
          name: connName,
          description: 'Synthetic sandbox inverter feed for exploring NuraVolt',
          type: 'sample_api',
          status: 'connected',
          config: { sample: true },
          polling_interval: 900,
          enabled: true,
        },
        select: { id: true },
      });
    }
    const connectionId = connection.id;

    // --- ensure the PlantDataSource + representative field mappings exist ---
    const existingSource = await prisma.plantDataSource.findFirst({
      where: { plant_id: plant.id, connection_id: connectionId },
      select: { id: true },
    });
    if (!existingSource) {
      await prisma.plantDataSource.create({
        data: {
          plant_id: plant.id,
          connection_id: connectionId,
          name: 'Sample inverter feed',
          source_type: 'SCADA',
          purpose: 'INVERTER_DATA',
          provides_metrics: ['power_ac', 'irradiance_poa', 'temp_module'],
          polling_interval: 900,
          is_primary: false,
          enabled: true,
        },
      });
    }
    for (const fm of FIELD_MAPPINGS) {
      await prisma.fieldMapping.upsert({
        where: { connection_id_original_field: { connection_id: connectionId, original_field: fm.from } },
        create: {
          connection_id: connectionId,
          original_field: fm.from,
          mapped_field: fm.to as any,
          unit: fm.unit,
          confidence_score: fm.confidence,
          is_confirmed: true,
        },
        update: { mapped_field: fm.to as any, unit: fm.unit, confidence_score: fm.confidence },
      });
    }

    // --- generate the telemetry (measurements + snapshots) ---
    const feed = await generateSampleFeed({
      plantId: plant.id,
      connectionId,
      plantSlug: plant.slug,
      latitude: Number(plant.latitude),
      longitude: Number(plant.longitude),
      timezone: plant.timezone,
      devices,
      days: 30,
    });

    // --- refresh the analytics over the new measurements ---
    await triggerPlantOnboarding(plant.id);
    const dispatched = Boolean(process.env.GITHUB_DISPATCH_TOKEN && process.env.GITHUB_REPO);

    return NextResponse.json({
      ok: true,
      connection_id: connectionId,
      devices: feed.devices,
      device_count: feed.devices.length,
      rows_written: feed.measurementRows,
      snapshots: feed.snapshots,
      days: feed.days,
      onboarding: dispatched ? 'dispatched' : 'queued',
      message: 'Sample inverter feed generated. Your dashboard will fill in as the analytics run.',
    });
  } catch (error) {
    console.error('[sample-feed] failed:', error);
    return NextResponse.json({ error: 'Failed to generate sample feed' }, { status: 500 });
  }
}
