import prisma from '@/libs/prisma';
import { insertMeasurements, type MeasurementInsert } from '@/lib/db/timeseries';

/**
 * Synthetic "sample inverter feed" generator.
 *
 * Produces realistic per-inverter telemetry (power_ac / irradiance_poa /
 * temp_air) from a self-contained clear-sky diurnal model — no Open-Meteo or
 * pvlib dependency, so it runs instantly inside a Next.js route (Vercel-safe).
 * It's the sandbox counterpart to scripts/seed_e2e_demo_data.py::synthesize()
 * and uses the same shape (one slightly "dirty" inverter, ±2% noise, a flat
 * performance ratio) so the downstream analytics behave identically. Writes go
 * to the `measurements` hypertable + `LatestDeviceSnapshot`; the richer twin /
 * soiling / faults are produced afterwards by the onboarding pipeline reading
 * these measurements.
 *
 * Deterministic per plant so repeated provisioning is idempotent (upserts).
 */

const PR = 0.82; // flat performance ratio for the synthetic clean model
const BASE_SOILING_PER_DAY = 0.0015;
const DIRTY_SOILING_PER_DAY = 0.0038; // the outlier inverter
const POA_CLEAR_PEAK = 950; // W/m2 clear-sky peak POA
const MEAS_CHUNK = 5000; // rows per INSERT (< 65535/8 param ceiling)

export interface SampleDevice {
  externalId: string;
  nominalPowerKw: number;
}

export interface SampleFeedInput {
  /** Canonical plant UUID. */
  plantId: string;
  /** The sample DataConnection id (owner of the device snapshots). */
  connectionId: string;
  /** Plant slug, used as plant_ext_id on snapshots. */
  plantSlug: string;
  latitude: number;
  longitude: number;
  timezone?: string | null;
  devices: SampleDevice[];
  /** Days of history to generate (default 30). */
  days?: number;
}

export interface SampleFeedResult {
  devices: string[];
  measurementRows: number;
  snapshots: number;
  days: number;
}

// Small deterministic PRNG (mulberry32) so a given plant always gets the same
// feed — no Math.random (which is also unavailable in some runtimes).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// UTC offset (hours) for an IANA zone at a given instant. Ignores DST drift
// across the window — fine for a sample feed.
function tzOffsetHours(tz: string, at: Date): number {
  try {
    const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(at.toLocaleString('en-US', { timeZone: tz }));
    return (local.getTime() - utc.getTime()) / 3_600_000;
  } catch {
    return 0;
  }
}

// Day-length + solar geometry from latitude & day-of-year → sunrise/sunset in
// local solar hours and a seasonal amplitude.
function solarDay(latDeg: number, dayOfYear: number) {
  const lat = (latDeg * Math.PI) / 180;
  const decl = ((23.45 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  let cosH = -Math.tan(lat) * Math.tan(decl);
  cosH = Math.max(-1, Math.min(1, cosH));
  const H = Math.acos(cosH); // radians
  const daylightHours = (2 * H * 12) / Math.PI;
  const sunrise = 12 - daylightHours / 2;
  const sunset = 12 + daylightHours / 2;
  // Peak solar elevation drives clear-sky amplitude (higher sun → more POA).
  const noonElevation = Math.max(0.1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl));
  return { sunrise, sunset, daylightHours, amplitude: 0.55 + 0.45 * noonElevation };
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86_400_000);
}

/**
 * Generate + persist the sample feed. Returns the row counts written.
 */
export async function generateSampleFeed(input: SampleFeedInput): Promise<SampleFeedResult> {
  const days = input.days ?? 30;
  const devices = input.devices;
  if (devices.length === 0) {
    return { devices: [], measurementRows: 0, snapshots: 0, days };
  }

  const rng = mulberry32(hashSeed(input.plantId));
  const offset = tzOffsetHours(input.timezone || 'UTC', new Date());
  const dirtyIdx = Math.min(2, devices.length - 1); // third inverter is the dirty one

  const now = new Date();
  const nowMs = now.getTime();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startMs = end.getTime() - days * 86_400_000;

  const records: MeasurementInsert[] = [];
  // Track the latest reading per device for the snapshot rows.
  const latest = new Map<string, { ts: Date; powerKw: number }>();

  for (let dayOffset = 0; dayOffset <= days; dayOffset++) {
    const dayStart = new Date(startMs + dayOffset * 86_400_000);
    const doy = dayOfYear(dayStart);
    const { sunrise, sunset, daylightHours, amplitude } = solarDay(input.latitude, doy);
    // Deterministic per-day cloud factor (occasional overcast day).
    const cloud = 0.65 + 0.35 * rng();

    for (let hUtc = 0; hUtc < 24; hUtc++) {
      const localHour = (((hUtc + offset) % 24) + 24) % 24;
      if (localHour <= sunrise || localHour >= sunset) continue; // night → no rows

      const frac = (localHour - sunrise) / daylightHours; // 0..1 across daylight
      const solar = Math.sin(Math.PI * frac); // bell curve, 0 at edges, 1 at noon
      const poa = POA_CLEAR_PEAK * amplitude * cloud * Math.max(0, solar);
      if (poa <= 5) continue; // daylight-only measurements, matches the seeder

      const ts = new Date(dayStart.getTime() + hUtc * 3_600_000);
      if (ts.getTime() > nowMs) continue; // never emit readings in the future

      const temp = 14 + 12 * solar + 4 * (amplitude - 0.75) + (rng() - 0.5) * 2;

      devices.forEach((dev, i) => {
        const rating = dev.nominalPowerKw || 200;
        const rate = i === dirtyIdx ? DIRTY_SOILING_PER_DAY : BASE_SOILING_PER_DAY;
        const sr = Math.max(0.82, 0.99 - rate * dayOffset);
        const pred = Math.min(rating, (poa / 1000) * rating * PR);
        const noise = 1 + (rng() - 0.5) * 0.04; // ±2%
        const actual = Math.min(rating, pred * sr * noise);

        records.push(
          { time: ts, plant_id: input.plantId, device_id: dev.externalId, metric: 'power_ac', value: round(actual, 3), unit: 'kW', quality: 100 },
          { time: ts, plant_id: input.plantId, device_id: dev.externalId, metric: 'irradiance_poa', value: round(poa, 1), unit: 'W/m2', quality: 100 },
          { time: ts, plant_id: input.plantId, device_id: dev.externalId, metric: 'temp_air', value: round(temp, 1), unit: 'C', quality: 100 },
        );

        const prev = latest.get(dev.externalId);
        if (!prev || ts > prev.ts) latest.set(dev.externalId, { ts, powerKw: actual });
      });
    }
  }

  // Bulk-upsert measurements in param-safe chunks.
  let measurementRows = 0;
  for (let i = 0; i < records.length; i += MEAS_CHUNK) {
    measurementRows += await insertMeasurements(records.slice(i, i + MEAS_CHUNK));
  }

  // One snapshot per device (latest reading), so the live tile + onboarding
  // "first data" step light up immediately.
  let snapshots = 0;
  for (const dev of devices) {
    const l = latest.get(dev.externalId);
    if (!l) continue;
    await prisma.latestDeviceSnapshot.upsert({
      where: { connection_id_device_ext_id: { connection_id: input.connectionId, device_ext_id: dev.externalId } },
      create: {
        connection_id: input.connectionId,
        plant_ext_id: input.plantSlug,
        device_ext_id: dev.externalId,
        device_type: 'inverter',
        ts: l.ts,
        active_power_kw: round(l.powerKw, 2),
        daily_energy_kwh: round(l.powerKw * 5.5, 1),
        extra: { sample: true },
      },
      update: {
        ts: l.ts,
        active_power_kw: round(l.powerKw, 2),
        daily_energy_kwh: round(l.powerKw * 5.5, 1),
        extra: { sample: true },
      },
    });
    snapshots++;
  }

  return { devices: devices.map((d) => d.externalId), measurementRows, snapshots, days };
}

export interface SampleInstantReading {
  deviceId: string;
  /** AC power in kW (0 at night). */
  powerKw: number;
  /** Plane-of-array irradiance in W/m2 (0 at night). */
  poaWm2: number;
  /** Ambient temperature in °C. */
  tempC: number;
}

/**
 * Same clear-sky physics as generateSampleFeed, evaluated at a single instant
 * — the realtime counterpart used by the pollable sample_api connector
 * (SampleApiService). Pure + deterministic: a given (seedKey, minute-bucket)
 * always yields the same values, and night hours yield explicit zeros so a
 * poll always produces rows.
 */
export function sampleInstantReadings(
  ctx: {
    seedKey: string;
    latitude: number;
    timezone?: string | null;
    devices: SampleDevice[];
  },
  at: Date = new Date(),
): SampleInstantReading[] {
  const { devices } = ctx;
  if (devices.length === 0) return [];

  const doy = dayOfYear(at);
  const { sunrise, sunset, daylightHours, amplitude } = solarDay(ctx.latitude, doy);
  const offset = tzOffsetHours(ctx.timezone || 'UTC', at);
  const localHour = ((((at.getUTCHours() + at.getUTCMinutes() / 60 + offset) % 24) + 24) % 24);

  // Deterministic per-day cloud factor (same distribution as the history feed).
  const dayKey = `${ctx.seedKey}:${at.getUTCFullYear()}-${doy}`;
  const cloud = 0.65 + 0.35 * mulberry32(hashSeed(dayKey))();

  const daylight = localHour > sunrise && localHour < sunset;
  const solar = daylight ? Math.sin((Math.PI * (localHour - sunrise)) / daylightHours) : 0;
  const poa = POA_CLEAR_PEAK * amplitude * cloud * Math.max(0, solar);
  const temp = 14 + 12 * solar + 4 * (amplitude - 0.75);

  // Soiling: linear decay since a synthetic "last cleaning" every 45 days, so
  // the dirty outlier inverter stays visibly dirtier — mirrors the history feed.
  const daysSinceClean = doy % 45;
  const dirtyIdx = Math.min(2, devices.length - 1);

  // ±2% noise seeded per device per minute bucket (stable across retries).
  const minuteBucket = Math.floor(at.getTime() / 60_000);

  return devices.map((dev, i) => {
    const rating = dev.nominalPowerKw || 200;
    const rate = i === dirtyIdx ? DIRTY_SOILING_PER_DAY : BASE_SOILING_PER_DAY;
    const sr = Math.max(0.82, 0.99 - rate * daysSinceClean);
    const noise = 1 + (mulberry32(hashSeed(`${ctx.seedKey}:${dev.externalId}:${minuteBucket}`))() - 0.5) * 0.04;
    const pred = Math.min(rating, (poa / 1000) * rating * PR);
    const actual = poa > 5 ? Math.min(rating, pred * sr * noise) : 0;
    return {
      deviceId: dev.externalId,
      powerKw: round(actual, 3),
      poaWm2: round(poa > 5 ? poa : 0, 1),
      tempC: round(temp, 1),
    };
  });
}

/**
 * Build a plausible default inverter fleet for a plant that has no configured
 * inverters (the equipment step can be skipped). ~250 kW inverters, count
 * derived from capacity, clamped to 2..12.
 */
export function defaultFleet(capacityMw: number | null | undefined): SampleDevice[] {
  const capKw = Math.max(0.5, capacityMw ?? 1) * 1000;
  const count = Math.min(12, Math.max(2, Math.round(capKw / 250)));
  const nominal = round(capKw / count, 1);
  return Array.from({ length: count }, (_, i) => ({
    externalId: `SAMPLE-INV-${String(i + 1).padStart(2, '0')}`,
    nominalPowerKw: nominal,
  }));
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
