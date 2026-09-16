/**
 * Hybrid PV+BESS hourly timeline.
 *
 * The fixtures we have are partial: PV `plant_daily_power.json` covers only
 * ~10 days at 3-hourly cadence; BESS `dispatch_schedule.json` covers a
 * single 24h day. To support the year-spanning hybrid cockpit / curtailment
 * / sandbox demos we generate a deterministic, physics-grounded hourly
 * timeline that combines:
 *
 *   - Real OMIE day-ahead prices (already in `getPriceCurve()`).
 *   - A clear-sky PV model (cosine-of-solar-zenith × plant nameplate ×
 *     soiling × seasonal modulation).
 *   - A grid-export cap that produces realistic midday curtailment.
 *   - A greedy price- and curtailment-aware BESS dispatch using the asset's
 *     real nominal power / capacity / round-trip efficiency.
 *
 * Deterministic given (plantSlug, from, to) so the same screenshot
 * reproduces. No randomness; all stochasticity comes from real prices.
 */

import { getPriceCurve, type PricePoint } from '@/lib/prices/omiePrices';

export interface HybridSeriesPoint {
  /** ISO 8601 wall-clock (Iberia local). */
  time: string;
  /** Theoretical PV at the plane-of-array — what we'd produce without limits. */
  pv_potential_kw: number;
  /** PV actually delivered (potential minus what got curtailed by grid cap). */
  pv_actual_kw: number;
  /** PV that was clipped (grid limit) — the recovery opportunity. */
  pv_curtailed_kw: number;
  /** PV redirected to BESS instead of being clipped (subset of curtailed). */
  pv_to_bess_kw: number;
  /** BESS charge (>0) or discharge (<0) power in kW. */
  bess_power_kw: number;
  /** BESS state-of-charge fraction 0..1 after this hour. */
  bess_soc: number;
  /** Day-ahead price in €/MWh for this hour. */
  price_eur_mwh: number;
}

export interface PlantConstants {
  /** PV DC nameplate in kW (assumed approximation; calibrated for demo). */
  pv_nameplate_kw: number;
  /** Inverter+grid AC clip (kW) — sets the curtailment ceiling. */
  pv_grid_cap_kw: number;
  /** BESS rated power in kW. */
  bess_power_kw: number;
  /** BESS usable energy in kWh. */
  bess_energy_kwh: number;
  /** Round-trip AC→AC efficiency 0..1. */
  bess_rte: number;
  /** Latitude (°N) used by the clear-sky model. */
  latitude_deg: number;
  /** Longitude (°E) — used for solar time. */
  longitude_deg: number;
  /** Soiling factor (post-cleaning baseline), 0..1. Ribera = 0.93. */
  baseline_soiling: number;
}

/**
 * Per-plant constants. Numbers picked to match the publicly visible plant
 * size + the existing BESS `asset_info.json` rated power/capacity, so the
 * joined timeline is consistent with the rest of the dashboard.
 */
export const PLANT_CONSTANTS: Record<string, PlantConstants> = {
  ribera: {
    pv_nameplate_kw: 30_000,
    pv_grid_cap_kw: 22_000, // ~73% of nameplate — produces visible midday clip
    bess_power_kw: 1_600,
    bess_energy_kwh: 3_200,
    bess_rte: 0.88,
    latitude_deg: 38.0,
    longitude_deg: -1.0,
    baseline_soiling: 0.93,
  },
  alpha: {
    pv_nameplate_kw: 50_000,
    pv_grid_cap_kw: 38_000,
    bess_power_kw: 1_600,
    bess_energy_kwh: 3_200,
    bess_rte: 0.88,
    latitude_deg: 38.0,
    longitude_deg: -3.5,
    baseline_soiling: 0.94,
  },
  helios: {
    pv_nameplate_kw: 45_000,
    pv_grid_cap_kw: 35_000,
    bess_power_kw: 2_000,
    bess_energy_kwh: 4_000,
    bess_rte: 0.89,
    latitude_deg: 38.5,
    longitude_deg: -3.5,
    baseline_soiling: 0.95,
  },
  nimbus: {
    pv_nameplate_kw: 25_000,
    pv_grid_cap_kw: 18_000,
    bess_power_kw: 1_600,
    bess_energy_kwh: 3_200,
    bess_rte: 0.83, // degraded — Nimbus is the stressed scenario plant
    latitude_deg: 51.5,
    longitude_deg: -1.3,
    baseline_soiling: 0.96,
  },
  boreas: {
    // Standalone merchant BESS — no co-located PV. Sentinel value 0 lets the
    // hybrid / curtailment APIs detect "no PV" and return a friendly empty
    // payload instead of synthesising spurious sunshine numbers.
    pv_nameplate_kw: 0,
    pv_grid_cap_kw: 0,
    bess_power_kw: 50_000,
    bess_energy_kwh: 100_000,
    bess_rte: 0.89,
    latitude_deg: 54,
    longitude_deg: -1.5,
    baseline_soiling: 1.0,
  },
};

/** Day-of-year (1-365). */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86_400_000) + 1;
}

/**
 * Cosine of solar zenith angle for given lat/long/time.
 * Returns 0 at night, ~1 at solar noon on equator at equinox.
 * Coarse but good enough for a deterministic demo curve.
 */
function solarCosZenith(date: Date, lat: number, lon: number): number {
  const doy = dayOfYear(date);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  // Solar declination (radians) — Spencer's formula simplified
  const decl = 0.4093 * Math.sin((2 * Math.PI * (doy - 81)) / 365);
  // Solar hour angle: local solar noon ≈ 12 - lon/15 (UTC)
  const solarNoonUtc = 12 - lon / 15;
  const ha = ((hour - solarNoonUtc) * 15 * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  return Math.max(0, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha));
}

/**
 * Greedy BESS dispatch given a price-time series and a curtailment series.
 *
 * Heuristic:
 *  - If PV is being clipped this hour AND BESS has headroom → charge with the
 *    surplus first (up to rated power). This is the curtailment-recovery wedge.
 *  - Otherwise: if price below 25th-percentile threshold AND SoC < 95% →
 *    charge from grid.
 *  - If price above 75th-percentile threshold AND SoC > 15% → discharge to
 *    grid.
 *  - Else hold.
 *
 * Returns per-hour power (>0 charge, <0 discharge) and the rolling SoC.
 */
function dispatchBess(
  prices: number[],
  curtailedKw: number[],
  constants: PlantConstants
): { powerKw: number[]; soc: number[]; pvToBessKw: number[] } {
  const lowQ = quantile(prices, 0.25);
  const highQ = quantile(prices, 0.75);
  const power: number[] = [];
  const soc: number[] = [];
  const pvToBess: number[] = [];
  let socKwh = constants.bess_energy_kwh * 0.4; // start at 40%
  for (let i = 0; i < prices.length; i++) {
    const headroomKwh = constants.bess_energy_kwh * 0.95 - socKwh;
    const drawdownKwh = socKwh - constants.bess_energy_kwh * 0.15;
    let p = 0;
    let pvToBessThisHour = 0;

    // First priority: absorb curtailed PV if any (free energy).
    if (curtailedKw[i] > 0 && headroomKwh > 0) {
      const charge = Math.min(curtailedKw[i], constants.bess_power_kw, headroomKwh);
      p = charge;
      pvToBessThisHour = charge;
    } else if (prices[i] < lowQ && headroomKwh > 0) {
      const charge = Math.min(constants.bess_power_kw, headroomKwh);
      p = charge;
    } else if (prices[i] > highQ && drawdownKwh > 0) {
      const discharge = Math.min(constants.bess_power_kw, drawdownKwh);
      p = -discharge;
    }

    // Apply RTE on the way IN (charging losses).
    if (p > 0) socKwh += p * Math.sqrt(constants.bess_rte);
    else if (p < 0) socKwh += p / Math.sqrt(constants.bess_rte);

    socKwh = Math.max(0, Math.min(constants.bess_energy_kwh, socKwh));
    power.push(p);
    soc.push(socKwh / constants.bess_energy_kwh);
    pvToBess.push(pvToBessThisHour);
  }
  return { powerKw: power, soc, pvToBessKw: pvToBess };
}

function quantile(arr: number[], q: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export interface JoinOptions {
  plantSlug: string;
  /** ISO date or datetime (inclusive). */
  from: string;
  /** ISO date or datetime (exclusive). */
  to: string;
}

/**
 * Main entrypoint. Returns one hourly point per hour in [from, to).
 * Falls back gracefully when the price series doesn't fully cover the
 * window — points without a price are skipped rather than synthesised.
 */
export function joinHourly({ plantSlug, from, to }: JoinOptions): HybridSeriesPoint[] {
  const constants = PLANT_CONSTANTS[plantSlug];
  if (!constants) {
    throw new Error(`No plant constants defined for "${plantSlug}".`);
  }

  const prices: PricePoint[] = getPriceCurve(from, to);
  if (!prices.length) return [];

  // 1. PV potential + curtailed for every hour using the clear-sky model.
  const pvPotential: number[] = [];
  const pvCurtailed: number[] = [];
  const pvActual: number[] = [];
  for (const p of prices) {
    const d = new Date(p.time + 'Z'); // tolerate naive ISO as UTC for math
    const cz = solarCosZenith(d, constants.latitude_deg, constants.longitude_deg);
    // Clear-sky DC at nameplate × cz × soiling × seasonal modulation (winter haze)
    const doy = dayOfYear(d);
    const seasonal = 0.85 + 0.15 * Math.cos((2 * Math.PI * (doy - 172)) / 365); // peak in summer
    const dcKw = constants.pv_nameplate_kw * cz * constants.baseline_soiling * seasonal;
    pvPotential.push(dcKw);
    const clipped = Math.max(0, dcKw - constants.pv_grid_cap_kw);
    pvCurtailed.push(clipped);
    pvActual.push(Math.min(dcKw, constants.pv_grid_cap_kw));
  }

  // 2. BESS dispatch using greedy strategy.
  const { powerKw, soc, pvToBessKw } = dispatchBess(
    prices.map((p) => p.eur_per_mwh),
    pvCurtailed,
    constants
  );

  // 3. Assemble.
  const out: HybridSeriesPoint[] = [];
  for (let i = 0; i < prices.length; i++) {
    out.push({
      time: prices[i].time,
      pv_potential_kw: Math.round(pvPotential[i]),
      pv_actual_kw: Math.round(pvActual[i]),
      pv_curtailed_kw: Math.round(pvCurtailed[i]),
      pv_to_bess_kw: Math.round(pvToBessKw[i]),
      bess_power_kw: Math.round(powerKw[i]),
      bess_soc: Math.round(soc[i] * 1000) / 1000,
      price_eur_mwh: prices[i].eur_per_mwh,
    });
  }
  return out;
}

/**
 * Convenience: revenue attribution per source for a joined window.
 * Numbers in €, computed at hourly resolution (kW × 1 h × €/MWh / 1000).
 */
export interface RevenueBreakdown {
  pv_baseline_eur: number;
  bess_arbitrage_eur: number;
  curtailment_recovery_eur: number;
  total_eur: number;
  pv_only_eur: number;
  uplift_vs_pv_only_eur: number;
}

export function attributeRevenue(series: HybridSeriesPoint[]): RevenueBreakdown {
  let pvBaseline = 0;
  let arbitrage = 0;
  let recovery = 0;
  for (const p of series) {
    const price = p.price_eur_mwh / 1000; // €/kWh
    // PV that was actually delivered to grid is exported at the spot price.
    pvBaseline += p.pv_actual_kw * price;
    // BESS contribution: discharge sells at spot; charge from grid buys at spot.
    // Charging from curtailed PV has zero opportunity cost (would've been clipped).
    if (p.bess_power_kw < 0) {
      arbitrage += -p.bess_power_kw * price;
    } else if (p.bess_power_kw > 0) {
      if (p.pv_to_bess_kw > 0) {
        // Recovered energy: would otherwise have been clipped (revenue = 0).
        // Booked when it's later sold via discharge — track as recovery on
        // the discharge side by tagging pv-sourced fraction of charges, but
        // for simplicity treat 100% of pv_to_bess as recovery proxy here.
        recovery += p.pv_to_bess_kw * price; // opportunity-cost-free energy stored
      } else {
        // Pure grid arbitrage charge: net cost.
        arbitrage -= p.bess_power_kw * price;
      }
    }
  }
  const total = pvBaseline + arbitrage + recovery;
  // PV-only counterfactual: no BESS, so curtailed energy is lost and no
  // arbitrage. The baseline already captures pv_actual revenue.
  const pvOnly = pvBaseline;
  return {
    pv_baseline_eur: Math.round(pvBaseline),
    bess_arbitrage_eur: Math.round(arbitrage),
    curtailment_recovery_eur: Math.round(recovery),
    total_eur: Math.round(total),
    pv_only_eur: Math.round(pvOnly),
    uplift_vs_pv_only_eur: Math.round(total - pvOnly),
  };
}
