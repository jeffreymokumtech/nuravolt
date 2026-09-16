/**
 * Residual value model for BESS assets.
 *
 * Approach: tiered multiplier curve on top of an installed CAPEX baseline.
 * Each tier represents a band of useful-life vs install-day state, derived
 * from industry-published second-life market reference prices (LCO/NMC/LFP
 * aftermarket transactions, 2023-2025 ranges).
 *
 * Multipliers are conservative — at the high end of typical broker takes
 * but well below the install CAPEX, since stranded warranty + integration
 * cost reduces realisable value vs. a new install. Override the curve via
 * `customMultiplier` for sensitivity analysis.
 *
 * All values returned in EUR. SoH input is a fraction [0, 1].
 */

export type SecondLifeTier = 'used_good' | 'used_fair' | 'second_life' | 'scrap';

export interface ResidualValueResult {
  valueEur: number;
  tier: SecondLifeTier;
  multiplier: number;
  /** Why this tier was picked — one line. */
  explanation: string;
}

const TIER_CURVE: Array<{
  minSoh: number;
  tier: SecondLifeTier;
  multiplier: number;
  explanation: string;
}> = [
  {
    minSoh: 0.9,
    tier: 'used_good',
    multiplier: 0.65,
    explanation:
      'Used-good aftermarket — full warranty intact, low cycle count, prime fleet candidate.',
  },
  {
    minSoh: 0.8,
    tier: 'used_fair',
    multiplier: 0.4,
    explanation:
      'Used-fair aftermarket — within warranty floor, suitable for redeployment in a derated role.',
  },
  {
    minSoh: 0.7,
    tier: 'second_life',
    multiplier: 0.22,
    explanation:
      'Second-life market — below original warranty floor, repurposed for stationary stationary lower-cycle applications.',
  },
  {
    minSoh: 0,
    tier: 'scrap',
    multiplier: 0.08,
    explanation: 'Scrap / material recovery — economic ceiling = recycled cell mass.',
  },
];

/**
 * Compute today's residual value.
 *
 * @param soh — current SoH as a fraction [0, 1]
 * @param installValueEur — installed CAPEX in EUR
 * @param customMultiplier — optional override of the tier multiplier
 */
export function computeResidualValue(
  soh: number,
  installValueEur: number,
  customMultiplier?: number
): ResidualValueResult {
  const safeSoh = Math.max(0, Math.min(1, soh));
  const tier = TIER_CURVE.find((t) => safeSoh >= t.minSoh) ?? TIER_CURVE[TIER_CURVE.length - 1];
  const multiplier = customMultiplier ?? tier.multiplier;
  return {
    valueEur: Math.max(0, installValueEur * multiplier),
    tier: tier.tier,
    multiplier,
    explanation: tier.explanation,
  };
}

export interface ResidualProjection {
  todayValueEur: number;
  todayTier: SecondLifeTier;
  atBreachValueEur: number;
  atBreachTier: SecondLifeTier;
  atSecondLifeValueEur: number;
  atSecondLifeTier: SecondLifeTier;
  netImpactEur: number;
  netImpactPct: number;
}

/**
 * Project residual value at three operational milestones: today, the
 * warranty floor breach point, and the 2nd-life threshold (70% SoH).
 */
export function projectResidualValue(opts: {
  currentSoh: number;
  warrantyFloor: number;
  installValueEur: number;
  secondLifeFloor?: number;
}): ResidualProjection {
  const secondLifeFloor = opts.secondLifeFloor ?? 0.7;
  const today = computeResidualValue(opts.currentSoh, opts.installValueEur);
  const atBreach = computeResidualValue(opts.warrantyFloor, opts.installValueEur);
  const atSecondLife = computeResidualValue(secondLifeFloor, opts.installValueEur);

  return {
    todayValueEur: today.valueEur,
    todayTier: today.tier,
    atBreachValueEur: atBreach.valueEur,
    atBreachTier: atBreach.tier,
    atSecondLifeValueEur: atSecondLife.valueEur,
    atSecondLifeTier: atSecondLife.tier,
    netImpactEur: atBreach.valueEur - today.valueEur,
    netImpactPct:
      today.valueEur > 0 ? ((atBreach.valueEur - today.valueEur) / today.valueEur) * 100 : 0,
  };
}

export const RESIDUAL_VALUE_NOTES = `
Model assumptions:
- Tier multipliers derived from 2023-2025 BESS aftermarket reference prices
  (broker take, post-integration removal, before transport).
- "Used-good" = >90% SoH, warranty intact.
- "Used-fair" = 80-90% SoH, warranty still meets floor.
- "Second-life" = 70-80% SoH, redeployed in a low-cycle application.
- "Scrap" = <70% SoH, value = recycled cell mass + cobalt/nickel content.
- Not a market quote — confirm with broker before transacting.
`.trim();

export const TIER_LABEL: Record<SecondLifeTier, string> = {
  used_good: 'Used-good',
  used_fair: 'Used-fair',
  second_life: '2nd-life',
  scrap: 'Scrap',
};
