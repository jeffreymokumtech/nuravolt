import prisma from '@/libs/prisma';
import { ownsConnection, type OrgContext } from '@/lib/api/tenant';
import {
  createPlantForOrg,
  type BessAssetInput,
  type CreatePlantRequest,
  type InverterInput,
} from '@/lib/plants/create';

/**
 * DiscoveredPlant → Plant promotion — the zero-touch onboarding core.
 *
 * Cloud discovery already captures everything a Plant needs (name, coords,
 * kWp, timezone, commissioning date, device inventory in metadata.devices);
 * this turns that into a real Plant + InverterGroup + Inverters +
 * PlantDataSource and kicks the analytics pipeline via the shared create
 * service (identical plan-limit enforcement as POST /api/plants).
 *
 * Idempotent: created plants are stamped with
 * metadata.promoted_from = { connection_id, external_plant_id }; a repeat
 * call returns the existing plant with created:false.
 */

export interface PromoteOverrides {
  name?: string;
  latitude?: number;
  longitude?: number;
  capacity_mw?: number;
  timezone?: string;
  /**
   * Declared storage energy (MWh). Operator-supplied: no cloud vendor reports
   * a battery nameplate today (NormalizedPlant in
   * src/lib/services/cloud-connector.ts has no energy field), so this is the
   * only reliable source for a promoted storage plant.
   */
  energy_capacity_mwh?: number;
  /** Battery nameplate detail (chemistry, rack/module counts, GB market ids). */
  storage?: BessAssetInput;
}

export type PromoteOutcome =
  | { ok: true; created: boolean; plant: { id: string; slug: string; name: string } }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Device classes that map to Inverter rows (cloud-connector taxonomy). */
const INVERTER_DEVICE_TYPES = new Set([
  'string_inverter',
  'residential_inverter',
  'hybrid_inverter',
  'inverter',
]);

export async function promoteDiscoveredPlant(
  ctx: OrgContext,
  connectionId: string,
  externalPlantId: string,
  overrides: PromoteOverrides = {},
): Promise<PromoteOutcome> {
  // 1. Connection ownership (cross-tenant → 404, same as discover/test).
  const connection = await prisma.dataConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection || !ownsConnection(ctx, connection)) {
    return { ok: false, status: 404, body: { error: 'connection_not_found' } };
  }

  // 2. Load the discovered plant — by the (connection, external id) unique
  //    key, falling back to the DiscoveredPlant uuid.
  const discovered =
    (await prisma.discoveredPlant.findUnique({
      where: {
        connection_id_external_plant_id: {
          connection_id: connectionId,
          external_plant_id: externalPlantId,
        },
      },
    })) ??
    (await prisma.discoveredPlant.findFirst({
      where: { id: externalPlantId, connection_id: connectionId },
    }));
  if (!discovered) {
    return { ok: false, status: 404, body: { error: 'discovered_plant_not_found' } };
  }

  // 3. Idempotency: has this discovery already been promoted?
  const existing = await prisma.plant.findFirst({
    where: {
      organization_id: ctx.org.id,
      metadata: {
        path: ['promoted_from', 'external_plant_id'],
        equals: discovered.external_plant_id,
      },
    },
    select: { id: true, slug: true, name: true, metadata: true },
  });
  if (
    existing &&
    (existing.metadata as any)?.promoted_from?.connection_id === connectionId
  ) {
    return { ok: true, created: false, plant: existing };
  }

  // 4. Resolve plant fields — overrides win over discovery.
  const location = (discovered.location ?? {}) as {
    lat?: number;
    lng?: number;
    address?: string;
    country?: string;
  };
  const name = overrides.name ?? discovered.name ?? `Plant ${discovered.external_plant_id}`;
  const latitude = overrides.latitude ?? location.lat;
  const longitude = overrides.longitude ?? location.lng;
  const capacityMw =
    overrides.capacity_mw ?? (discovered.capacity_mw != null ? Number(discovered.capacity_mw) : undefined);

  // Storage nameplate. Discovery cannot supply this: no adapter writes an
  // energy capacity, so in practice it arrives in the caller's overrides. The
  // metadata read exists only so an adapter that starts reporting a real
  // nameplate is honoured without another change here.
  //
  // Deliberately NOT derived from capacity_mw. When nothing declares the MWh
  // the plant is created without a BessAsset (createPlantForOrg guards on the
  // declared value) rather than with an invented duration, and the operator
  // can add the nameplate later.
  const metadataMwh = Number((discovered.metadata as any)?.energy_capacity_mwh);
  const energyCapacityMwh =
    overrides.energy_capacity_mwh ??
    overrides.storage?.energy_capacity_mwh ??
    (Number.isFinite(metadataMwh) && metadataMwh > 0 ? metadataMwh : undefined);

  const missing: string[] = [];
  if (latitude == null) missing.push('latitude');
  if (longitude == null) missing.push('longitude');
  if (capacityMw == null || !(capacityMw > 0)) missing.push('capacity_mw');
  if (missing.length > 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'discovery_incomplete',
        missing,
        detail: `The vendor did not report: ${missing.join(', ')}. Provide the missing values in overrides.`,
      },
    };
  }

  // 5. Device inventory → Inverter rows (twin requires at least one).
  const rawDevices = ((discovered.metadata as any)?.devices ?? []) as Array<{
    external_device_id?: string;
    name?: string;
    device_type?: string;
    model?: string;
  }>;
  let inverters: InverterInput[] = rawDevices
    .filter((d) => d.external_device_id && INVERTER_DEVICE_TYPES.has(d.device_type ?? ''))
    .map((d) => ({
      external_id: String(d.external_device_id),
      name: d.name,
      model: d.model,
    }));

  if (inverters.length === 0) {
    const count = Math.max(1, discovered.inverter_count ?? 1);
    inverters = Array.from({ length: count }, (_, i) => ({
      external_id: `${discovered.external_plant_id}-INV-${i + 1}`,
      name: `Inverter ${i + 1}`,
    }));
  }

  const nominalKw = Math.round(((capacityMw as number) * 1000) / inverters.length * 10) / 10;

  // 6. provides_metrics from the connection's confirmed field mappings
  //    (cloud connectors persist static mappings at discovery).
  const mappings = await prisma.fieldMapping.findMany({
    where: { connection_id: connectionId },
    distinct: ['mapped_field'],
    select: { mapped_field: true },
  });
  const providesMetrics =
    mappings.length > 0
      ? mappings.map((m) => String(m.mapped_field))
      : ['power_ac', 'energy_daily', 'temp_inverter'];

  // 7. Country: only pass through ISO alpha-2 (SolarEdge may return full names;
  //    getCompliancePack expects ISO codes).
  const country =
    location.country && /^[A-Za-z]{2}$/.test(location.country)
      ? location.country
      : undefined;

  // Day-1 array geometry from geography. The config generator has no lat-based
  // heuristic (it also defaults to 20/180), so derive it here: fixed tilt
  // approximates the latitude, capped for practicality; modules face the
  // equator (south in the northern hemisphere, north in the southern).
  const geoLat = latitude as number;
  const derivedTilt = Math.round(Math.min(Math.abs(geoLat), 35));
  const derivedAzimuth = geoLat >= 0 ? 180 : 0;

  const request: CreatePlantRequest = {
    name,
    latitude: latitude as number,
    longitude: longitude as number,
    capacity_mw: capacityMw as number,
    energy_capacity_mwh: energyCapacityMwh,
    storage:
      energyCapacityMwh != null
        ? { ...overrides.storage, energy_capacity_mwh: energyCapacityMwh }
        : undefined,
    timezone: overrides.timezone ?? discovered.timezone ?? undefined,
    commissioning_date: discovered.commissioning_date?.toISOString(),
    location_name: location.address,
    country,
    asset_type: discovered.asset_type,
    metadata: {
      promoted_from: {
        connection_id: connectionId,
        external_plant_id: discovered.external_plant_id,
      },
    },
    inverter_groups: [
      {
        // Tilt/azimuth derived from latitude (see above); gamma_pdc is a
        // typical crystalline-silicon temperature coefficient.
        name: 'Main array',
        tilt: derivedTilt,
        azimuth: derivedAzimuth,
        gamma_pdc: -0.004,
        inverter_model: discovered.inverter_types[0],
        inverter_nominal_power_kw: nominalKw,
        inverters,
      },
    ],
    data_sources: [
      {
        name: connection.name,
        source_type: 'SCADA',
        purpose: 'INVERTER_DATA',
        connection_id: connectionId,
        provides_metrics: providesMetrics,
        is_primary: true,
      },
    ],
  };

  const outcome = await createPlantForOrg(ctx.authOrgId, request);
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, body: outcome.body };
  }

  return {
    ok: true,
    created: true,
    plant: { id: outcome.plant.id, slug: outcome.plant.slug, name: outcome.plant.name },
  };
}
