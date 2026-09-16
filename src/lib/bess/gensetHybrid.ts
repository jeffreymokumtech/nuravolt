/**
 * Genset (diesel generator) lane for the hybrid PV+BESS cockpit.
 *
 * Extends the deterministic hourly PV+BESS timeline from `joinPvBess.ts`
 * with a weak-grid C&I story: an on-site factory load, synthetic grid
 * outage windows (1 to 3 per week), and a diesel genset that starts only
 * when PV plus BESS cannot carry the site load during an outage.
 *
 * Physical grounding (demo-grade, real J1939 telemetry is out of scope):
 *   - Fuel curve is linear in output with an idle intercept, using the
 *     classic HOMER coefficients: fuel_lph = 0.08145 l/h per kW rated
 *     + 0.246 l/kWh delivered.
 *   - Spinning reserve: the genset never runs below ~30% of its rating;
 *     surplus above the residual load recharges the BESS.
 *   - During an outage the BESS bridges first (down to its 15% SoC floor);
 *     the genset takes over when the bridge cannot cover the residual.
 *
 * Deterministic given (plantSlug, series window): outage windows are seeded
 * per absolute calendar week, so the same screenshot reproduces and the
 * same hours are outages regardless of the range selected.
 */

import type { HybridSeriesPoint, PlantConstants } from './joinPvBess';

export const DEFAULT_DIESEL_USD_PER_L = 1.1;

export interface GensetConfig {
  /** Genset nameplate rating in kW. */
  rating_kw: number;
  /** Minimum stable load fraction (spinning reserve floor), 0..1. */
  min_load_fraction: number;
  /** Fuel curve intercept: litres per hour per kW of rating (idle burn). */
  fuel_intercept_l_per_h_per_kw: number;
  /** Fuel curve slope: litres per kWh delivered. */
  fuel_slope_l_per_kwh: number;
  /** Factory base (overnight) load in kW. */
  site_load_base_kw: number;
  /** Factory peak (working hours) load in kW. */
  site_load_peak_kw: number;
  /** Assumed levelised cost of on-site PV energy, USD/kWh. */
  pv_lcoe_usd_per_kwh: number;
  /** Assumed levelised cost of storage cycling, USD/kWh discharged. */
  bess_lcos_usd_per_kwh: number;
}

/**
 * Derive a plausible genset + factory-load configuration from the plant's
 * BESS rating so every demo plant gets a coherent weak-grid story without
 * hand-tuning each one.
 */
export function gensetConfigFor(constants: PlantConstants): GensetConfig {
  const bp = constants.bess_power_kw > 0 ? constants.bess_power_kw : 1_000;
  return {
    rating_kw: Math.round((bp * 1.5) / 100) * 100,
    min_load_fraction: 0.3,
    fuel_intercept_l_per_h_per_kw: 0.08145,
    fuel_slope_l_per_kwh: 0.246,
    site_load_base_kw: Math.round((bp * 0.9) / 50) * 50,
    site_load_peak_kw: Math.round((bp * 1.8) / 50) * 50,
    pv_lcoe_usd_per_kwh: 0.045,
    bess_lcos_usd_per_kwh: 0.08,
  };
}

export interface GensetSeriesPoint extends HybridSeriesPoint {
  /** Factory / site load in kW for this hour. */
  site_load_kw: number;
  /** False during a synthetic grid outage window. */
  grid_available: boolean;
  /** Genset output in kW (0 when off; >= min stable load when running). */
  genset_power_kw: number;
  /** Fuel burn rate in litres per hour (0 when off). */
  fuel_lph: number;
  /** Cumulative litres burned so far within this calendar day. */
  fuel_cum_day_l: number;
  /** BESS discharge serving the site load during an outage, kW. */
  bess_to_load_kw: number;
  /** Load that could not be served this hour (rare), kW. */
  unserved_kw: number;
}

export interface GensetEvent {
  time: string;
  type: 'start' | 'stop';
  reason: string;
}

export interface GensetDailyFuel {
  date: string;
  litres: number;
  usd: number;
}

export interface GensetPostmortem {
  start: string;
  end: string;
  duration_min: number;
  load_kwh: number;
  pv_kwh: number;
  bess_kwh: number;
  genset_kwh: number;
  unserved_kwh: number;
  unserved_min: number;
  fuel_l: number;
  fuel_usd: number;
  bigger_battery: {
    factor: number;
    energy_kwh: number;
    fuel_saved_l: number;
    fuel_saved_usd: number;
  };
}

export interface GensetSummary {
  config: {
    rating_kw: number;
    min_load_fraction: number;
    diesel_usd_per_l: number;
    site_load_base_kw: number;
    site_load_peak_kw: number;
  };
  runtime_h: number;
  starts: number;
  fuel_l: number;
  fuel_usd: number;
  genset_kwh: number;
  outages: { count: number; total_min: number };
  unserved_min: number;
  economics: {
    fuel_l: number;
    fuel_usd: number;
    /** Fuel USD a genset-only site would have burned, minus actual burn. */
    avoided_usd: number;
    genset_usd_per_kwh: number | null;
    pv_bess_usd_per_kwh: number;
  };
  daily_fuel: GensetDailyFuel[];
  events: GensetEvent[];
  postmortem: GensetPostmortem | null;
}

/* ------------------------------------------------------------------ */
/* Deterministic pseudo-randomness                                     */
/* ------------------------------------------------------------------ */

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grid outage hours (absolute epoch-hour set) for the calendar weeks
 * overlapping [firstHour, lastHour]. 1 to 3 outages per week, each lasting
 * 2 to 6 hours, deterministically seeded per (plantSlug, week index).
 *
 * Start times are biased toward the evening peak and overnight hours
 * (17:00 to 04:00), which is when weak grids actually collapse and when
 * PV cannot carry the load alone, so the BESS bridge and genset takeover
 * both get exercised.
 */
function outageHoursFor(plantSlug: string, firstHour: number, lastHour: number): Set<number> {
  const out = new Set<number>();
  const firstWeek = Math.floor(firstHour / 168) - 1;
  const lastWeek = Math.floor(lastHour / 168) + 1;
  for (let w = firstWeek; w <= lastWeek; w++) {
    const rng = mulberry32(hashStr(`${plantSlug}:outages:${w}`));
    const n = 1 + Math.floor(rng() * 3); // 1..3 outages this week
    for (let k = 0; k < n; k++) {
      const day = Math.floor(rng() * 7);
      const hourOfDay = (17 + Math.floor(rng() * 12)) % 24; // 17:00 .. 04:00
      const start = w * 168 + day * 24 + hourOfDay;
      const dur = 2 + Math.floor(rng() * 5); // 2..6 hours
      for (let h = start; h < start + dur; h++) out.add(h);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Site load model                                                     */
/* ------------------------------------------------------------------ */

function siteLoadKw(d: Date, cfg: GensetConfig): number {
  const h = d.getUTCHours();
  const dow = d.getUTCDay();
  const weekend = dow === 0 || dow === 6;
  // Working-hours shape: ramp 06-08, plateau 08-18, ramp down 18-21.
  let shape = 0;
  if (h >= 6 && h < 8) shape = (h - 6) / 2;
  else if (h >= 8 && h < 18) shape = 1;
  else if (h >= 18 && h < 21) shape = (21 - h) / 3;
  const weekendFactor = weekend ? 0.55 : 1;
  const span = cfg.site_load_peak_kw - cfg.site_load_base_kw;
  return Math.round(cfg.site_load_base_kw + span * shape * weekendFactor);
}

/* ------------------------------------------------------------------ */
/* Fuel + dispatch primitives                                          */
/* ------------------------------------------------------------------ */

function fuelLphAt(outputKw: number, cfg: GensetConfig): number {
  if (outputKw <= 0) return 0;
  return cfg.fuel_intercept_l_per_h_per_kw * cfg.rating_kw + cfg.fuel_slope_l_per_kwh * outputKw;
}

interface OutageStepResult {
  gensetKw: number;
  bessToLoadKw: number;
  bessChargeKw: number;
  pvToLoadKw: number;
  unservedKw: number;
  newSocKwh: number;
}

/**
 * One islanded hour: PV serves load first, BESS bridges, genset takes over
 * (at >= min stable load, surplus recharging the BESS), anything beyond
 * genset + BESS capability is unserved.
 */
function outageStep(
  loadKw: number,
  pvAvailKw: number,
  socKwh: number,
  energyKwh: number,
  powerKw: number,
  rte: number,
  cfg: GensetConfig
): OutageStepResult {
  const sqrtRte = Math.sqrt(rte);
  const floorKwh = energyKwh * 0.15;
  const ceilKwh = energyKwh * 0.95;
  const maxDischargeKw = Math.max(0, Math.min(powerKw, (socKwh - floorKwh) * sqrtRte));
  const maxChargeKw = Math.max(0, Math.min(powerKw, (ceilKwh - socKwh) / sqrtRte));

  const pvToLoadKw = Math.min(pvAvailKw, loadKw);
  const residual = loadKw - pvToLoadKw;

  let gensetKw = 0;
  let bessToLoadKw = 0;
  let bessChargeKw = 0;
  let unservedKw = 0;

  if (residual <= 0) {
    // PV alone covers the load; absorb PV surplus into the BESS.
    bessChargeKw = Math.min(pvAvailKw - loadKw, maxChargeKw);
  } else if (maxDischargeKw >= residual) {
    // BESS bridge covers the residual entirely.
    bessToLoadKw = residual;
  } else {
    // Genset takeover, at or above its minimum stable load.
    const minKw = cfg.rating_kw * cfg.min_load_fraction;
    gensetKw = Math.min(cfg.rating_kw, Math.max(minKw, residual));
    const short = residual - gensetKw;
    if (short > 0) {
      bessToLoadKw = Math.min(maxDischargeKw, short);
      unservedKw = Math.max(0, short - bessToLoadKw);
    } else if (gensetKw > residual) {
      // Spinning-reserve surplus recharges the BESS instead of being dumped.
      bessChargeKw = Math.min(gensetKw - residual, maxChargeKw);
    }
  }

  let newSocKwh = socKwh + bessChargeKw * sqrtRte - bessToLoadKw / sqrtRte;
  newSocKwh = Math.max(0, Math.min(energyKwh, newSocKwh));

  return { gensetKw, bessToLoadKw, bessChargeKw, pvToLoadKw, unservedKw, newSocKwh };
}

function quantile(arr: number[], q: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Main entrypoint                                                     */
/* ------------------------------------------------------------------ */

export interface ExtendWithGensetOptions {
  plantSlug: string;
  series: HybridSeriesPoint[];
  constants: PlantConstants;
  dieselUsdPerL?: number;
  config?: GensetConfig;
}

export function extendWithGenset({
  plantSlug,
  series,
  constants,
  dieselUsdPerL = DEFAULT_DIESEL_USD_PER_L,
  config,
}: ExtendWithGensetOptions): { series: GensetSeriesPoint[]; genset: GensetSummary } {
  const cfg = config ?? gensetConfigFor(constants);

  const emptySummary: GensetSummary = {
    config: {
      rating_kw: cfg.rating_kw,
      min_load_fraction: cfg.min_load_fraction,
      diesel_usd_per_l: dieselUsdPerL,
      site_load_base_kw: cfg.site_load_base_kw,
      site_load_peak_kw: cfg.site_load_peak_kw,
    },
    runtime_h: 0,
    starts: 0,
    fuel_l: 0,
    fuel_usd: 0,
    genset_kwh: 0,
    outages: { count: 0, total_min: 0 },
    unserved_min: 0,
    economics: {
      fuel_l: 0,
      fuel_usd: 0,
      avoided_usd: 0,
      genset_usd_per_kwh: null,
      pv_bess_usd_per_kwh: cfg.pv_lcoe_usd_per_kwh,
    },
    daily_fuel: [],
    events: [],
    postmortem: null,
  };
  if (!series.length) return { series: [], genset: emptySummary };

  const epochHours = series.map((p) => Math.floor(Date.parse(p.time + 'Z') / 3_600_000));
  const outageSet = outageHoursFor(plantSlug, epochHours[0], epochHours[epochHours.length - 1]);

  const prices = series.map((p) => p.price_eur_mwh);
  const lowQ = quantile(prices, 0.25);
  const highQ = quantile(prices, 0.75);

  const E = constants.bess_energy_kwh;
  const P = constants.bess_power_kw;
  const rte = constants.bess_rte;
  const sqrtRte = Math.sqrt(rte);

  // Unified re-dispatch: identical greedy arbitrage on grid hours, islanded
  // logic on outage hours, one continuous SoC trace.
  let socKwh = E * 0.4;
  const out: GensetSeriesPoint[] = [];
  const loads: number[] = [];
  const pvAvails: number[] = [];
  const socBefore: number[] = [];

  let fuelDayL = 0;
  let curDay = '';

  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    const d = new Date(p.time + 'Z');
    const day = p.time.slice(0, 10);
    if (day !== curDay) {
      curDay = day;
      fuelDayL = 0;
    }

    const gridAvailable = !outageSet.has(epochHours[i]);
    const loadKw = siteLoadKw(d, cfg);
    const pvAvailKw = p.pv_potential_kw; // islanded: no grid export cap
    loads.push(loadKw);
    pvAvails.push(pvAvailKw);
    socBefore.push(socKwh);

    let bessPowerKw = 0;
    let pvToBessKw = 0;
    let gensetKw = 0;
    let bessToLoadKw = 0;
    let unservedKw = 0;

    if (gridAvailable) {
      const headroomKwh = E * 0.95 - socKwh;
      const drawdownKwh = socKwh - E * 0.15;
      if (p.pv_curtailed_kw > 0 && headroomKwh > 0) {
        const charge = Math.min(p.pv_curtailed_kw, P, headroomKwh);
        bessPowerKw = charge;
        pvToBessKw = charge;
      } else if (p.price_eur_mwh < lowQ && headroomKwh > 0) {
        bessPowerKw = Math.min(P, headroomKwh);
      } else if (p.price_eur_mwh > highQ && drawdownKwh > 0) {
        bessPowerKw = -Math.min(P, drawdownKwh);
      }
      if (bessPowerKw > 0) socKwh += bessPowerKw * sqrtRte;
      else if (bessPowerKw < 0) socKwh += bessPowerKw / sqrtRte;
      socKwh = Math.max(0, Math.min(E, socKwh));
    } else {
      const step = outageStep(loadKw, pvAvailKw, socKwh, E, P, rte, cfg);
      gensetKw = step.gensetKw;
      bessToLoadKw = step.bessToLoadKw;
      unservedKw = step.unservedKw;
      bessPowerKw = step.bessChargeKw - step.bessToLoadKw;
      // Charge energy is PV surplus when PV fully covers the load (genset
      // off by construction); otherwise it is genset spinning-reserve surplus.
      pvToBessKw = step.pvToLoadKw >= loadKw ? step.bessChargeKw : 0;
      socKwh = step.newSocKwh;
    }

    const fuelLph = fuelLphAt(gensetKw, cfg);
    fuelDayL += fuelLph;

    out.push({
      ...p,
      pv_to_bess_kw: Math.round(pvToBessKw),
      bess_power_kw: Math.round(bessPowerKw),
      bess_soc: Math.round((socKwh / E) * 1000) / 1000,
      site_load_kw: loadKw,
      grid_available: gridAvailable,
      genset_power_kw: Math.round(gensetKw),
      fuel_lph: round1(fuelLph),
      fuel_cum_day_l: round1(fuelDayL),
      bess_to_load_kw: Math.round(bessToLoadKw),
      unserved_kw: Math.round(unservedKw),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Summary aggregation                                                 */
  /* ------------------------------------------------------------------ */

  let runtimeH = 0;
  let starts = 0;
  let fuelL = 0;
  let gensetKwh = 0;
  let unservedMin = 0;
  let counterfactualFuelL = 0; // genset-only serving of outage load
  let outagePvKwh = 0;
  let outageBessKwh = 0;
  const events: GensetEvent[] = [];
  const dailyMap = new Map<string, number>();

  let prevRunning = false;
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const running = p.genset_power_kw > 0;
    if (running) {
      runtimeH += 1;
      fuelL += p.fuel_lph;
      gensetKwh += p.genset_power_kw;
      dailyMap.set(p.time.slice(0, 10), (dailyMap.get(p.time.slice(0, 10)) ?? 0) + p.fuel_lph);
    }
    if (running && !prevRunning) {
      starts += 1;
      events.push({
        time: p.time,
        type: 'start',
        reason: 'Grid outage: PV and BESS bridge could not cover the site load',
      });
    }
    if (!running && prevRunning) {
      events.push({
        time: p.time,
        type: 'stop',
        reason: p.grid_available ? 'Grid restored' : 'PV and BESS resumed carrying the load',
      });
    }
    prevRunning = running;

    if (p.unserved_kw > 0) unservedMin += 60;
    if (!p.grid_available) {
      counterfactualFuelL += fuelLphAt(
        Math.min(cfg.rating_kw, Math.max(cfg.rating_kw * cfg.min_load_fraction, p.site_load_kw)),
        cfg
      );
      outagePvKwh += Math.min(pvAvails[i], loads[i]);
      outageBessKwh += p.bess_to_load_kw;
    }
  }

  const fuelUsd = fuelL * dieselUsdPerL;
  const avoidedUsd = Math.max(0, counterfactualFuelL - fuelL) * dieselUsdPerL;

  // Effective cost per kWh, computed over the outage-served energy so the
  // comparison is like-for-like (both are "keep the factory running" energy).
  const outageServedKwh = outagePvKwh + outageBessKwh;
  const pvBessUsdPerKwh =
    outageServedKwh > 0
      ? (outagePvKwh * cfg.pv_lcoe_usd_per_kwh +
          outageBessKwh * (cfg.pv_lcoe_usd_per_kwh + cfg.bess_lcos_usd_per_kwh)) /
        outageServedKwh
      : cfg.pv_lcoe_usd_per_kwh + cfg.bess_lcos_usd_per_kwh * 0.5;
  const gensetUsdPerKwh = gensetKwh > 0 ? fuelUsd / gensetKwh : null;

  // Outage windows (contiguous runs of grid_available === false).
  const windows: { start: number; end: number }[] = [];
  let winStart: number | null = null;
  for (let i = 0; i < out.length; i++) {
    if (!out[i].grid_available && winStart === null) winStart = i;
    if (out[i].grid_available && winStart !== null) {
      windows.push({ start: winStart, end: i - 1 });
      winStart = null;
    }
  }
  if (winStart !== null) windows.push({ start: winStart, end: out.length - 1 });
  const outageTotalMin = windows.reduce((s, w) => s + (w.end - w.start + 1) * 60, 0);

  /* ------------------------------------------------------------------ */
  /* Blackout post-mortem for the most recent outage window              */
  /* ------------------------------------------------------------------ */

  let postmortem: GensetPostmortem | null = null;
  if (windows.length) {
    const w = windows[windows.length - 1];
    let loadKwh = 0;
    let pvKwh = 0;
    let bessKwh = 0;
    let gKwh = 0;
    let unsKwh = 0;
    let unsMin = 0;
    let fL = 0;
    for (let i = w.start; i <= w.end; i++) {
      const p = out[i];
      loadKwh += p.site_load_kw;
      pvKwh += Math.min(pvAvails[i], loads[i]);
      bessKwh += p.bess_to_load_kw;
      gKwh += Math.min(p.genset_power_kw, Math.max(0, p.site_load_kw - Math.min(pvAvails[i], loads[i])));
      unsKwh += p.unserved_kw;
      if (p.unserved_kw > 0) unsMin += 60;
      fL += p.fuel_lph;
    }

    // Counterfactual: same outage with a battery `factor` times the energy
    // capacity (same power rating), starting at the same SoC fraction.
    const factor = 2;
    const bigE = E * factor;
    let bigSoc = (socBefore[w.start] / E) * bigE;
    let bigFuelL = 0;
    for (let i = w.start; i <= w.end; i++) {
      const step = outageStep(loads[i], pvAvails[i], bigSoc, bigE, P, rte, cfg);
      bigSoc = step.newSocKwh;
      bigFuelL += fuelLphAt(step.gensetKw, cfg);
    }
    const savedL = Math.max(0, fL - bigFuelL);

    postmortem = {
      start: out[w.start].time,
      end: out[w.end].time,
      duration_min: (w.end - w.start + 1) * 60,
      load_kwh: Math.round(loadKwh),
      pv_kwh: Math.round(pvKwh),
      bess_kwh: Math.round(bessKwh),
      genset_kwh: Math.round(gKwh),
      unserved_kwh: Math.round(unsKwh),
      unserved_min: unsMin,
      fuel_l: round1(fL),
      fuel_usd: Math.round(fL * dieselUsdPerL),
      bigger_battery: {
        factor,
        energy_kwh: bigE,
        fuel_saved_l: round1(savedL),
        fuel_saved_usd: Math.round(savedL * dieselUsdPerL),
      },
    };
  }

  const dailyFuel: GensetDailyFuel[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, litres]) => ({
      date,
      litres: round1(litres),
      usd: Math.round(litres * dieselUsdPerL),
    }));

  return {
    series: out,
    genset: {
      ...emptySummary,
      runtime_h: runtimeH,
      starts,
      fuel_l: round1(fuelL),
      fuel_usd: Math.round(fuelUsd),
      genset_kwh: Math.round(gensetKwh),
      outages: { count: windows.length, total_min: outageTotalMin },
      unserved_min: unservedMin,
      economics: {
        fuel_l: round1(fuelL),
        fuel_usd: Math.round(fuelUsd),
        avoided_usd: Math.round(avoidedUsd),
        genset_usd_per_kwh: gensetUsdPerKwh !== null ? Math.round(gensetUsdPerKwh * 1000) / 1000 : null,
        pv_bess_usd_per_kwh: Math.round(pvBessUsdPerKwh * 1000) / 1000,
      },
      daily_fuel: dailyFuel,
      events,
      postmortem,
    },
  };
}
