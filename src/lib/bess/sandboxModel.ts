/**
 * Deterministic NMC degradation projector for the BESS Warranty Sandbox.
 *
 * Pure function — same inputs always produce the same trajectory. Fast
 * enough (<50 ms / 10-year scenario) for live slider updates.
 *
 * Physics intent:
 *  - Calendar fade: square-root-of-time, accelerated by high SoC dwell &
 *    cell temperature.
 *  - Cycle fade: linear in full-equivalent cycles, accelerated by DoD &
 *    aggressive C-rate.
 *  - Aggressiveness slider modulates "how hard we run" — picks the
 *    operating point on a Pareto curve between life and revenue.
 *
 * The numbers are calibrated to give a believable demo (10-year SoH lands
 * in the 65-85% band depending on settings) and to match the existing
 * Prisma `BessWarrantyTerms` semantics (70% warranty floor, 6,000 cycle
 * limit by default for NMC).
 */

export interface SandboxParams {
  /** Allowed lower SoC bound (%). */
  soc_min_pct: number;
  /** Allowed upper SoC bound (%). */
  soc_max_pct: number;
  /** Max daily cycles cap (full-equivalent cycles / day). */
  max_daily_cycles: number;
  /** Cell temperature ceiling (°C) — proxied via HVAC capability. */
  temp_ceiling_c: number;
  /** Cycling DoD target (%). */
  dod_target_pct: number;
  /** Aggressiveness — 0 = life-max, 100 = revenue-max. */
  aggressiveness: number;
}

export const SANDBOX_DEFAULTS: SandboxParams = {
  soc_min_pct: 15,
  soc_max_pct: 90,
  max_daily_cycles: 1.5,
  temp_ceiling_c: 32,
  dod_target_pct: 70,
  aggressiveness: 50,
};

export interface SandboxResult {
  /** SoH (%) at the end of each year, year 0 = today. */
  soh_trajectory: Array<{ year: number; soh_pct: number }>;
  /** SoH (%) under SANDBOX_DEFAULTS — for the baseline overlay. */
  baseline_trajectory: Array<{ year: number; soh_pct: number }>;
  /** Year (decimal) when SoH crosses 70 %. */
  projected_eol_years: number;
  /** Date string for projected EOL (rounded to month). */
  projected_eol_date: string;
  /** 10-year NPV breakdown (€). */
  npv: {
    revenue_eur: number;
    degradation_cost_eur: number;
    hvac_cost_eur: number;
    warranty_risk_premium_eur: number;
    net_eur: number;
  };
  /** Warranty risk score 0..100 (higher = worse). */
  warranty_risk_score: number;
  /** Level badge derived from the score. */
  warranty_risk_level: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
}

/**
 * Compute a single year-by-year SoH trajectory given the operating params.
 * Year 0 = today, year N = N years from now.
 */
function trajectory(
  params: SandboxParams,
  currentSohPct: number,
  years: number
): Array<{ year: number; soh_pct: number }> {
  // Calendar component (annual %) — heavier at high avg SoC and high temp.
  const avgSoc = (params.soc_min_pct + params.soc_max_pct) / 200; // 0..1
  const socStress = Math.max(0, avgSoc - 0.5) * 2; // 0..1 above 50%
  const tempStress = Math.max(0, params.temp_ceiling_c - 25) / 15; // 0..1 above 25°C
  const calendarRate = 1.2 + 1.5 * socStress + 1.5 * tempStress; // % / year @ baseline

  // Cycle component — linear in cumulative full-equivalent cycles, with
  // DoD penalty and aggressiveness multiplier.
  const dodPenalty = 0.5 + (params.dod_target_pct / 100) * 1.2; // 0.5..1.7
  const aggressMul = 0.5 + (params.aggressiveness / 100) * 1.4; // 0.5..1.9
  const annualCycles = params.max_daily_cycles * 365 * (0.7 + 0.3 * (params.aggressiveness / 100));
  const cycleFadePerCycle = 0.0032 * dodPenalty * aggressMul; // % per cycle (very small)
  const cyclesPerYear = annualCycles;

  const out: Array<{ year: number; soh_pct: number }> = [];
  let soh = currentSohPct;
  out.push({ year: 0, soh_pct: Math.round(soh * 10) / 10 });

  for (let y = 1; y <= years; y++) {
    // Calendar fade: square-root-of-time approximation
    const calendarFade = calendarRate * (Math.sqrt(y) - Math.sqrt(y - 1));
    const cycleFade = cyclesPerYear * cycleFadePerCycle;
    soh -= calendarFade + cycleFade;
    // Soft floor — degradation slows below 60% as Coulombic efficiency
    // changes hide further capacity loss in early life. Useful safeguard
    // so the curve doesn't run negative.
    if (soh < 50) soh = 50 + (soh - 50) * 0.3;
    out.push({ year: y, soh_pct: Math.round(soh * 10) / 10 });
  }
  return out;
}

/** Linearly interpolate the year when SoH crosses the warranty floor. */
function eolYear(traj: Array<{ year: number; soh_pct: number }>, floor = 70): number {
  for (let i = 1; i < traj.length; i++) {
    if (traj[i].soh_pct <= floor) {
      const y0 = traj[i - 1].year;
      const y1 = traj[i].year;
      const s0 = traj[i - 1].soh_pct;
      const s1 = traj[i].soh_pct;
      if (s0 === s1) return y1;
      return y0 + ((s0 - floor) / (s0 - s1)) * (y1 - y0);
    }
  }
  return traj[traj.length - 1].year; // never reaches floor in horizon
}

function eolDate(yearsFromToday: number): string {
  const ms = yearsFromToday * 365.25 * 24 * 3600 * 1000;
  const d = new Date(Date.now() + ms);
  return d.toLocaleDateString('en-IE', { year: 'numeric', month: 'short' });
}

export function runSandbox(
  params: SandboxParams,
  opts: { currentSohPct?: number; horizonYears?: number; warrantyYears?: number; nominalEnergyKwh?: number } = {}
): SandboxResult {
  const currentSohPct = opts.currentSohPct ?? 94;
  const horizon = opts.horizonYears ?? 10;
  const warrantyYears = opts.warrantyYears ?? 10;
  const nominalEnergyKwh = opts.nominalEnergyKwh ?? 3200;

  const scenario = trajectory(params, currentSohPct, horizon);
  const baseline = trajectory(SANDBOX_DEFAULTS, currentSohPct, horizon);

  const eol = eolYear(scenario, 70);

  // Revenue model: more cycles + more aggressive dispatch → more revenue,
  // but with a degradation cost dragging it down. Calibrated so a typical
  // 1.6 MW / 3.2 MWh BESS earns ~€80/day mid-scenario.
  const annualThroughputMwh = params.max_daily_cycles * 365 * (nominalEnergyKwh / 1000) * (params.dod_target_pct / 100);
  const avgSpread = 25 + 0.4 * params.aggressiveness; // €/MWh between charge & discharge
  const revenuePerYear = annualThroughputMwh * avgSpread * 0.7; // capture fraction

  // Aggressive use → more degradation cost: replacement cells priced at €120/kWh.
  const sohDropPct = currentSohPct - scenario[scenario.length - 1].soh_pct;
  const replacementCost = (sohDropPct / 100) * nominalEnergyKwh * 120;

  // HVAC scales with temperature setpoint. Lower ceiling → more cooling demand.
  const hvacAnnual = 8000 * (1 + (35 - params.temp_ceiling_c) * 0.06);

  // Warranty risk: hits if scenario EOL < warranty term — risk premium = expected liability.
  const warrantyShortfallYears = Math.max(0, warrantyYears - eol);
  const warrantyRiskPremium = warrantyShortfallYears * 18_000;

  const revenue10y = revenuePerYear * horizon;
  const net = revenue10y - replacementCost - hvacAnnual * horizon - warrantyRiskPremium;

  const riskScore = Math.min(
    100,
    Math.round(
      warrantyShortfallYears * 10 +
        (params.soc_max_pct - 80) * 1.5 +
        (params.temp_ceiling_c - 30) * 4 +
        (params.max_daily_cycles - 1.5) * 15 +
        (params.aggressiveness - 50) * 0.4
    )
  );

  const level: SandboxResult['warranty_risk_level'] =
    riskScore >= 75 ? 'CRITICAL' :
    riskScore >= 50 ? 'HIGH' :
    riskScore >= 25 ? 'MODERATE' : 'LOW';

  return {
    soh_trajectory: scenario,
    baseline_trajectory: baseline,
    projected_eol_years: Math.round(eol * 10) / 10,
    projected_eol_date: eolDate(eol),
    npv: {
      revenue_eur: Math.round(revenue10y),
      degradation_cost_eur: Math.round(replacementCost),
      hvac_cost_eur: Math.round(hvacAnnual * horizon),
      warranty_risk_premium_eur: Math.round(warrantyRiskPremium),
      net_eur: Math.round(net),
    },
    warranty_risk_score: Math.max(0, riskScore),
    warranty_risk_level: level,
  };
}
