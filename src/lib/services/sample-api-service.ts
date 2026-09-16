import type {
  CloudVendorConnector,
  NormalizedDevice,
  NormalizedPlant,
  NormalizedReading,
  StaticFieldMapping,
} from './cloud-connector';
import {
  defaultFleet,
  sampleInstantReadings,
  type SampleDevice,
} from '@/lib/sample/inverter-feed';

/**
 * Synthetic "vendor cloud" connector — the pollable counterpart of the
 * one-shot sample feed (src/lib/sample/inverter-feed.ts).
 *
 * Implements the same CloudVendorConnector contract as Huawei FusionSolar /
 * SolarEdge but generates deterministic clear-sky telemetry instead of calling
 * a vendor API, so the entire polling pipeline (cron scheduler → PollingJob →
 * Parquet lake landing → LatestDeviceSnapshot) can be exercised end-to-end
 * without vendor credentials. Zero external dependencies; never throws for
 * vendor-side reasons.
 *
 * Plant context (which plants/fleets to synthesize) is injected by
 * PollingService from the connection's linked PlantDataSource rows via
 * setPlantContexts(); connections with no linked plant fall back to a single
 * default ~1 MW plant so a bare sample connection still polls.
 */

export interface SamplePlantContext {
  /** Used as plant_ext_id on readings (the Plant.slug when linked). */
  plant_ext_id: string;
  name?: string;
  latitude: number;
  longitude?: number;
  timezone?: string | null;
  capacity_mw?: number;
  /** Deterministic seed (the Plant.id when linked, else the connection id). */
  seedKey: string;
  devices: SampleDevice[];
}

const DEFAULT_CONTEXT: Omit<SamplePlantContext, 'seedKey'> = {
  plant_ext_id: 'SAMPLE-PLANT-1',
  name: 'Sample plant',
  latitude: 39.5,
  longitude: -3.0,
  timezone: 'Europe/Madrid',
  capacity_mw: 1,
  devices: defaultFleet(1),
};

export class SampleApiService implements CloudVendorConnector {
  private contexts: SamplePlantContext[] = [];
  private connectionId = 'sample';

  /** Mirrors the vendor services' connect(connection) shape. No auth needed. */
  async connect(connection: { id?: string }): Promise<void> {
    this.connectionId = connection?.id ?? 'sample';
    if (this.contexts.length === 0) {
      this.contexts = [{ ...DEFAULT_CONTEXT, seedKey: this.connectionId }];
    }
  }

  /** Inject plant/fleet context resolved from PlantDataSource rows. */
  setPlantContexts(contexts: SamplePlantContext[]): void {
    if (contexts.length > 0) this.contexts = contexts;
  }

  async authenticate(): Promise<void> {
    // No-op: the sample cloud has no auth.
  }

  async discoverPlants(): Promise<NormalizedPlant[]> {
    return this.contexts.map((ctx) => ({
      external_plant_id: ctx.plant_ext_id,
      name: ctx.name ?? ctx.plant_ext_id,
      location: { lat: ctx.latitude, lng: ctx.longitude },
      capacity_mw: ctx.capacity_mw,
      timezone: ctx.timezone ?? 'UTC',
      metadata: { sample: true },
    }));
  }

  async discoverDevices(plantIds: string[]): Promise<NormalizedDevice[]> {
    const wanted = plantIds.length > 0 ? new Set(plantIds) : null;
    return this.contexts
      .filter((ctx) => !wanted || wanted.has(ctx.plant_ext_id))
      .flatMap((ctx) =>
        ctx.devices.map((dev) => ({
          external_device_id: dev.externalId,
          external_plant_id: ctx.plant_ext_id,
          name: dev.externalId,
          device_type: 'string_inverter',
          metadata: { sample: true, nominal_power_kw: dev.nominalPowerKw },
        })),
      );
  }

  async backfill(deviceIds: string[], day: Date): Promise<NormalizedReading[]> {
    // Hourly instants across the requested calendar day (UTC).
    const readings: NormalizedReading[] = [];
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    for (let h = 0; h < 24; h++) {
      readings.push(...this.readingsAt(new Date(dayStart + h * 3_600_000), deviceIds));
    }
    return readings;
  }

  async pollRealtime(deviceIds?: string[]): Promise<NormalizedReading[]> {
    return this.readingsAt(new Date(), deviceIds);
  }

  staticFieldMappings(): StaticFieldMapping[] {
    return [
      { original_field: 'inverter.active_power', mapped_field: 'power_ac', unit: 'kW' },
      { original_field: 'inverter.poa_irradiance', mapped_field: 'irradiance_poa', unit: 'W/m2' },
      { original_field: 'inverter.ambient_temperature', mapped_field: 'temp_air', unit: 'C' },
    ];
  }

  async close(): Promise<void> {
    // No-op: nothing to release.
  }

  private readingsAt(at: Date, deviceIds?: string[]): NormalizedReading[] {
    const wanted = deviceIds && deviceIds.length > 0 ? new Set(deviceIds) : null;
    const ts = at.getTime();
    const readings: NormalizedReading[] = [];

    for (const ctx of this.contexts) {
      const instants = sampleInstantReadings(
        { seedKey: ctx.seedKey, latitude: ctx.latitude, timezone: ctx.timezone, devices: ctx.devices },
        at,
      );
      for (const r of instants) {
        if (wanted && !wanted.has(r.deviceId)) continue;
        const base = {
          ts,
          plant_ext_id: ctx.plant_ext_id,
          device_ext_id: r.deviceId,
          device_type: 'string_inverter',
        };
        readings.push(
          { ...base, metric: 'power_ac', value: r.powerKw, unit: 'kW' },
          { ...base, metric: 'irradiance_poa', value: r.poaWm2, unit: 'W/m2' },
          { ...base, metric: 'temp_air', value: r.tempC, unit: 'C' },
        );
      }
    }
    return readings;
  }
}
