/**
 * Meteo-prior forward simulation for the soiling baseline.
 *
 * Anchors the trajectory at today's observed SR (DustIQ where present, else the
 * ML forecast) and walks it forward using climate-zone monthly soiling rates,
 * an optional typical-year rain curve, and an optional AOD anomaly boost.
 *
 * This is intentionally an "honest priors" baseline — when zone priors are
 * missing we return a flat line at observedSr with wide bands, not a fabricated
 * decay. The caller is expected to load /data/soiling/_climate_priors.json via
 * loadClimatePriors() and pass the result in.
 */

const DEFAULT_P25_MULTIPLIER = 0.75;
const DEFAULT_P75_MULTIPLIER = 1.25;
const DEFAULT_CLIMATE_FLOOR = 0.8;
const RAIN_RECOVERY_THRESHOLD_MM = 5;
const RAIN_RECOVERY_FULL_MM = 25; // 25mm of rain → 0.8 recovery toward 1.0
const RAIN_RECOVERY_CAP = 0.8;
const AOD_ANOMALY_THRESHOLD = 0.5;
const AOD_ANOMALY_BOOST = 1.25;
const PESSIMISTIC_FLOOR_OFFSET = 0.05;
const PESSIMISTIC_RAIN_FACTOR = 0.7;

export interface MeteoPriorBaseline {
  dates: string[];
  sr_central: number[];
  sr_p25: number[];
  sr_p75: number[];
  rain_days: string[];
  climate_zone: string;
  source: string;
}

export interface MeteoPriorInput {
  observedSr: number;
  climateZone: string;
  startDate: Date;
  daysAhead: number;
  rainHistory?: Array<{ date: string; mm: number }>;
  aodHistory?: Array<{ date: string; aod: number }>;
  climatePriors: any;
}

interface ZonePrior {
  annual_mean_pct_per_day: number;
  monthly_multipliers: number[];
  climate_floor?: number;
  p25_multiplier?: number;
  p75_multiplier?: number;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(start: Date, days: number): Date {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function sameDayOfYear(isoDate: string, target: Date): boolean {
  // ISO date is YYYY-MM-DD; compare month + day only (ignore year).
  const parts = isoDate.slice(0, 10).split('-');
  if (parts.length < 3) return false;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return (
    month === target.getUTCMonth() + 1 &&
    day === target.getUTCDate()
  );
}

function flatBaseline(input: MeteoPriorInput, reason: string): MeteoPriorBaseline {
  // Honest "no priors available" fallback: flat at observedSr, wide bands.
  const dates: string[] = [];
  const sr_central: number[] = [];
  const sr_p25: number[] = [];
  const sr_p75: number[] = [];
  for (let d = 0; d <= input.daysAhead; d++) {
    const date = addDays(input.startDate, d);
    dates.push(toISODate(date));
    sr_central.push(input.observedSr);
    sr_p25.push(Math.max(input.observedSr - 0.1, 0));
    sr_p75.push(Math.min(input.observedSr + 0.05, 1));
  }
  return {
    dates,
    sr_central,
    sr_p25,
    sr_p75,
    rain_days: [],
    climate_zone: input.climateZone,
    source: reason,
  };
}

export function computeMeteoPriorBaseline(input: MeteoPriorInput): MeteoPriorBaseline {
  const zones = input.climatePriors?.zones ?? input.climatePriors;
  const zone: ZonePrior | undefined = zones?.[input.climateZone];

  if (!zone || !Array.isArray(zone.monthly_multipliers) || zone.monthly_multipliers.length !== 12) {
    return flatBaseline(
      input,
      `No climate priors available for ${input.climateZone} — flat baseline at observed SR`,
    );
  }

  const p25Mult = zone.p25_multiplier ?? DEFAULT_P25_MULTIPLIER;
  const p75Mult = zone.p75_multiplier ?? DEFAULT_P75_MULTIPLIER;
  const floor = zone.climate_floor ?? DEFAULT_CLIMATE_FLOOR;
  const annualMean = zone.annual_mean_pct_per_day;

  const dates: string[] = [toISODate(input.startDate)];
  const sr_central: number[] = [input.observedSr];
  const sr_p25: number[] = [input.observedSr];
  const sr_p75: number[] = [input.observedSr];
  const rain_days: string[] = [];

  for (let d = 1; d <= input.daysAhead; d++) {
    const date = addDays(input.startDate, d);
    const month = date.getUTCMonth(); // 0..11

    let rate = zone.monthly_multipliers[month] * annualMean;
    let rateP25 = rate * p25Mult;
    let rateP75 = rate * p75Mult;

    // AOD anomaly boost — same day-of-year lookup against historical AOD.
    if (input.aodHistory && input.aodHistory.length > 0) {
      const sameDay = input.aodHistory.find((a) => sameDayOfYear(a.date, date));
      if (sameDay && sameDay.aod > AOD_ANOMALY_THRESHOLD) {
        rate *= AOD_ANOMALY_BOOST;
        rateP25 *= AOD_ANOMALY_BOOST;
        rateP75 *= AOD_ANOMALY_BOOST;
      }
    }

    // Forward step. Pessimistic band uses the faster (p75) decay; optimistic
    // band uses the slower (p25) decay — this is the conventional confidence
    // interval inversion when the quantity is "remaining performance".
    let nextCentral = sr_central[d - 1] - rate / 100;
    let nextP25 = sr_p25[d - 1] - rateP75 / 100;
    let nextP75 = sr_p75[d - 1] - rateP25 / 100;

    // Rain cleaning from typical-year curve.
    if (input.rainHistory && input.rainHistory.length > 0) {
      const sameDayRain = input.rainHistory.find((r) => sameDayOfYear(r.date, date));
      const expectedRain = sameDayRain?.mm ?? 0;
      if (expectedRain > RAIN_RECOVERY_THRESHOLD_MM) {
        const recoveryFactor = Math.min(RAIN_RECOVERY_CAP, expectedRain / RAIN_RECOVERY_FULL_MM);
        nextCentral = nextCentral + (1.0 - nextCentral) * recoveryFactor;
        nextP25 = nextP25 + (1.0 - nextP25) * (recoveryFactor * PESSIMISTIC_RAIN_FACTOR);
        nextP75 = nextP75 + (1.0 - nextP75) * recoveryFactor;
        rain_days.push(date.toISOString());
      }
    }

    // Floor the trajectory — physical lower bound for routine soiling.
    nextCentral = Math.max(nextCentral, floor);
    nextP25 = Math.max(nextP25, floor - PESSIMISTIC_FLOOR_OFFSET);
    nextP75 = Math.max(nextP75, floor);

    dates.push(toISODate(date));
    sr_central.push(nextCentral);
    sr_p25.push(nextP25);
    sr_p75.push(nextP75);
  }

  const sourceParts = [`${input.climateZone} priors`];
  if (input.rainHistory && input.rainHistory.length > 0) {
    sourceParts.push('ERA5 rain climatology');
  }
  if (input.aodHistory && input.aodHistory.length > 0) {
    sourceParts.push('CAMS AOD anomalies');
  }

  return {
    dates,
    sr_central,
    sr_p25,
    sr_p75,
    rain_days,
    climate_zone: input.climateZone,
    source: sourceParts.join(' + '),
  };
}

/**
 * Browser-side loader for the climate priors JSON. Returns the `zones` object
 * directly so callers can pass it straight into `computeMeteoPriorBaseline` as
 * `climatePriors`, or wrap it as `{ zones }` — both shapes are accepted by the
 * compute function.
 */
export async function loadClimatePriors(): Promise<any> {
  const res = await fetch('/data/soiling/_climate_priors.json');
  if (!res.ok) {
    throw new Error('Climate priors not available');
  }
  const payload = await res.json();
  return payload.zones;
}
