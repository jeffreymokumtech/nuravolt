/**
 * End-of-life decommissioning cost model for BESS assets.
 *
 * Components:
 *   disposal cost  = capacity_kWh × disposal rate per kWh (€/kWh)
 *   recycled value = capacity_kWh × material recovery rate (€/kWh) × SoH-based recovery factor
 *
 * Rates default to EU 2024-2025 industry medians; pass overrides for
 * sensitivity analysis or for chemistry-specific tuning.
 */

export type BessChemistry = 'LFP' | 'NMC' | 'LCO' | 'NCA' | 'LMO' | 'OTHER';

const DEFAULT_DISPOSAL_RATE_EUR_KWH = 80; // EU industry median 2024

/**
 * Per-chemistry recoverable material value (€/kWh) at full SoH. Multiplied
 * by an SoH-derived recovery factor below.
 */
const MATERIAL_VALUE_BY_CHEMISTRY: Record<BessChemistry, number> = {
  LFP: 12,
  NMC: 38,
  LCO: 42,
  NCA: 36,
  LMO: 22,
  OTHER: 18,
};

export interface DecommissioningResult {
  disposalCostEur: number;
  recycledMaterialValueEur: number;
  netCostEur: number;
  assumptions: {
    disposalRateEurPerKwh: number;
    materialValueEurPerKwh: number;
    recoveryFactor: number;
  };
}

/**
 * Compute end-of-life decommissioning cost.
 *
 * @param capacityKwh — installed capacity in kWh
 * @param soh — SoH at decommissioning [0, 1]
 * @param chemistry — battery chemistry (drives material value)
 * @param overrides — optional rate overrides
 */
export function computeDecommissioningCost(
  capacityKwh: number,
  soh: number,
  chemistry: BessChemistry = 'NMC',
  overrides?: {
    disposalRateEurPerKwh?: number;
    materialValueEurPerKwh?: number;
  }
): DecommissioningResult {
  const safeSoh = Math.max(0, Math.min(1, soh));
  const disposalRate = overrides?.disposalRateEurPerKwh ?? DEFAULT_DISPOSAL_RATE_EUR_KWH;
  const materialValue = overrides?.materialValueEurPerKwh ?? MATERIAL_VALUE_BY_CHEMISTRY[chemistry];
  // Recovery factor: cells with more remaining capacity yield more usable
  // material in the recycling stream (less degraded electrolyte, intact
  // electrodes). Linear floor at 0.4.
  const recoveryFactor = Math.max(0.4, 0.5 + safeSoh * 0.5);

  const disposalCostEur = capacityKwh * disposalRate;
  const recycledMaterialValueEur = capacityKwh * materialValue * recoveryFactor;
  const netCostEur = Math.max(0, disposalCostEur - recycledMaterialValueEur);

  return {
    disposalCostEur,
    recycledMaterialValueEur,
    netCostEur,
    assumptions: {
      disposalRateEurPerKwh: disposalRate,
      materialValueEurPerKwh: materialValue,
      recoveryFactor,
    },
  };
}

export const DECOMMISSIONING_NOTES = `
Model assumptions:
- Disposal rate €${DEFAULT_DISPOSAL_RATE_EUR_KWH}/kWh (EU industry median 2024).
- Material recovery value varies by chemistry — LFP at the low end, NCA/LCO at the high end.
- Recovery factor scales with SoH at decommissioning (less degradation → more material recovered).
- Excludes transport, dismantling labour, regulatory fees.
- Not a contractor quote — request a site-specific tender before budgeting.
`.trim();

export function normaliseChemistry(raw: string | null | undefined): BessChemistry {
  if (!raw) return 'OTHER';
  const upper = raw.toUpperCase();
  if (upper.includes('LFP') || upper.includes('LIFEPO')) return 'LFP';
  if (upper.includes('NMC')) return 'NMC';
  if (upper.includes('LCO')) return 'LCO';
  if (upper.includes('NCA')) return 'NCA';
  if (upper.includes('LMO')) return 'LMO';
  return 'OTHER';
}
