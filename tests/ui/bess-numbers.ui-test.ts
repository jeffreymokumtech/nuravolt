/**
 * Every number the battery console renders has to be either derivable from the
 * payload or absent. These are the regressions this file pins, all of them
 * caught on the live `ribera` asset (5 MW / 10 MWh LFP, modelled dispatch twin,
 * chemistry-default warranty terms):
 *
 *   1. The residual panel drew "At warranty breach SoH 70% €616k" and "At
 *      2nd-life threshold SoH 70% €616k" as two rows. Both thresholds are 70%,
 *      so the same milestone was printed twice with the same euro figure.
 *   2. The value-drop strip printed "€-1204000" beside rows reading "€1.82M",
 *      because the magnitude branches in the formatter were `v >= 1_000_000`
 *      and `v >= 1_000`, which no negative number satisfies.
 *   3. "Today €1.82M" sat against a stated basis of 10,000 kWh × €280/kWh, or
 *      €2.80M new, with the 0.65 multiplier nowhere on screen.
 *   4. The decommissioning panel labelled its end-of-life state of health
 *      "contractual capacity guarantee" whenever a floor existed, including on
 *      this asset, whose warranty route reports capacity_guarantee_pct in
 *      `termsProvenance.defaultedFields`.
 *   5. The risk banner painted an unmeasured indicator green and let it pull
 *      the overall tier to NOMINAL.
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import {
  FLOOR_LABEL,
  formatEur,
  formatPct,
  residualMilestones,
} from '@/app/demo/_components/bess/BatteryResidualValue';
import { bannerTone, type RiskIndicator } from '@/app/demo/_components/bess/RiskHeroBanner';
import {
  floorProvenance,
  normalizeWarrantyTerms,
} from '@/app/demo/_components/OpsBattery';

/** The asset the console actually renders: 10 MWh LFP at €280/kWh installed. */
const INSTALL_EUR = 10_000 * 280;
const CURRENT_SOH = 0.9828;

/** Verbatim from GET /api/bess/plants/ribera/assets/{id}/warranty. */
const RIBERA_TERMS_PROVENANCE = {
  source: 'chemistry_default',
  isContractDerived: false,
  declaredFields: [],
  defaultedFields: [
    'capacity_guarantee_pct',
    'warranty_years',
    'max_cycles',
    'min_rte',
    'max_c_rate_continuous',
  ],
  basis: 'nuravolt/bess/config.py WarrantyTermsConfig, LFP baseline',
};

describe('euro formatting', () => {
  it('formats a negative amount at its magnitude instead of printing it raw', () => {
    // The exact number the panel rendered: 616_000 - 1_820_000.
    expect(formatEur(-1_204_000)).toBe('−€1.20M');
    expect(formatEur(-616_000)).toBe('−€616k');
    expect(formatEur(-1_500)).toBe('−€1.5k');
    expect(formatEur(-250)).toBe('−€250');
    expect(formatEur(-1_204_000)).not.toMatch(/\d{6}/);
  });

  it('keeps the positive renders it already produced', () => {
    expect(formatEur(1_820_000)).toBe('€1.82M');
    expect(formatEur(616_000)).toBe('€616k');
    expect(formatEur(698_000)).toBe('€698k');
    expect(formatEur(800_000)).toBe('€800k');
    expect(formatEur(0)).toBe('€0');
  });

  it('does not round a four-figure amount to a misleading whole k', () => {
    // The old formatter turned €1,500 into "€2k".
    expect(formatEur(1_500)).toBe('€1.5k');
  });

  it('marks a non-finite amount absent rather than printing NaN', () => {
    expect(formatEur(Number.NaN)).toBe('n/a');
    expect(formatEur(Number.POSITIVE_INFINITY)).toBe('n/a');
  });

  it('signs a percentage the same way it signs a euro amount', () => {
    expect(formatPct(-66.15)).toBe('−66%');
    expect(formatPct(12.4)).toBe('12%');
    expect(formatPct(Number.NaN)).toBe('n/a');
  });
});

describe('residual value milestones', () => {
  const base = {
    currentSoh: CURRENT_SOH,
    secondLifeFloor: 0.7,
    installValueEur: INSTALL_EUR,
  };

  it('merges the warranty floor and the second-life threshold when they coincide', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: 0.7,
      warrantyFloorSource: 'default',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('Today');
    expect(rows[1].label).toBe('At capacity floor and second-life threshold');
    // The duplicate that started this: no two rows may share a state of health.
    expect(new Set(rows.map((r) => r.soh)).size).toBe(rows.length);
  });

  it('keeps them as separate rows when the contract floor is not 70%', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: 0.8,
      warrantyFloorSource: 'contract',
    });
    expect(rows.map((r) => r.label)).toEqual([
      'Today',
      'At capacity floor',
      'At second-life threshold',
    ]);
    // Ordered as a trajectory: state of health only ever falls down the list.
    expect(rows.map((r) => r.soh)).toEqual([...rows.map((r) => r.soh)].sort((a, b) => b - a));
  });

  it('makes every euro figure derivable from the basis and the multiplier', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: 0.7,
      warrantyFloorSource: 'default',
    });
    for (const row of rows) {
      expect(row.valueEur).toBeCloseTo(INSTALL_EUR * row.multiplier, 6);
    }
    // The two figures on screen today, and the gap between the basis and the
    // headline that has to be explained by the multiplier.
    expect(rows[0].valueEur).toBeCloseTo(1_820_000);
    expect(rows[0].multiplier).toBeCloseTo(0.65);
    expect(rows[1].valueEur).toBeCloseTo(616_000);
    expect(rows[1].multiplier).toBeCloseTo(0.22);
  });

  it('never claims a contractual floor when the floor is a chemistry default', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: 0.7,
      warrantyFloorSource: 'default',
    });
    expect(rows[1].note).toContain('chemistry default');
    expect(rows[1].note).not.toContain('contractual');
  });

  it('says the source is unrecorded rather than guessing when provenance is absent', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: 0.7,
      warrantyFloorSource: 'unknown',
    });
    expect(rows[1].note).toContain('source not recorded');
    expect(rows[1].note).not.toContain('contractual');
  });

  it('drops the floor milestone entirely when no terms exist', () => {
    const rows = residualMilestones({
      ...base,
      warrantyFloor: null,
      warrantyFloorSource: 'unknown',
    });
    expect(rows.map((r) => r.label)).toEqual(['Today', 'At second-life threshold']);
  });
});

describe('capacity floor provenance', () => {
  it('reads the chemistry-default payload the ribera asset actually serves', () => {
    expect(floorProvenance(RIBERA_TERMS_PROVENANCE)).toBe('default');
    expect(FLOOR_LABEL.default).toContain('no contract on file');
  });

  it('only says contractual when the route says the clause came off a contract', () => {
    expect(
      floorProvenance({ isContractDerived: true, declaredFields: [], defaultedFields: [] }),
    ).toBe('contract');
    expect(FLOOR_LABEL.contract).toBe('contractual capacity guarantee');
  });

  it('judges the capacity clause on its own, not on the row as a whole', () => {
    // Some clauses declared, but the capacity floor still defaulted.
    expect(
      floorProvenance({
        source: 'operator_declared',
        isContractDerived: false,
        declaredFields: ['warranty_years'],
        defaultedFields: ['capacity_guarantee_pct'],
      }),
    ).toBe('default');
    expect(
      floorProvenance({
        source: 'operator_declared',
        isContractDerived: false,
        declaredFields: ['capacity_guarantee_pct'],
        defaultedFields: ['min_rte'],
      }),
    ).toBe('declared');
  });

  it('returns unknown for a payload with no provenance block, never contract', () => {
    expect(floorProvenance(null)).toBe('unknown');
    expect(floorProvenance(undefined)).toBe('unknown');
    expect(floorProvenance({})).toBe('unknown');
  });
});

describe('warranty terms normalisation', () => {
  it('carries the rated continuous C-rate through, so the observed peak is not used as a limit', () => {
    const wt = normalizeWarrantyTerms({
      terms: { capacityGuaranteePct: 0.7, maxCRateContinuous: 1 },
    })!;
    expect(wt.max_c_rate_continuous).toBe(1);
  });

  it('leaves the rated C-rate null when the contract carries no such clause', () => {
    const wt = normalizeWarrantyTerms({ terms: { capacityGuaranteePct: 0.7 } })!;
    expect(wt.max_c_rate_continuous).toBeNull();
  });
});

describe('risk banner tier', () => {
  const ind = (tone: RiskIndicator['tone']): RiskIndicator => ({ label: 'X', value: 'v', tone });

  it('takes the worst measured indicator', () => {
    expect(bannerTone([ind('ok'), ind('warn')]).tier).toBe('WATCH');
    expect(bannerTone([ind('ok'), ind('warn'), ind('alarm')]).tier).toBe('ALERT');
    expect(bannerTone([ind('ok'), ind('ok')]).tier).toBe('NOMINAL');
  });

  it('lets an unmeasured indicator sit beside a measured one without changing the tier', () => {
    expect(bannerTone([ind('ok'), ind('muted')]).tier).toBe('NOMINAL');
    expect(bannerTone([ind('alarm'), ind('muted')]).tier).toBe('ALERT');
  });

  it('does not call an asset with nothing measured NOMINAL', () => {
    const t = bannerTone([ind('muted'), ind('muted')]);
    expect(t.tier).toBe('NOT SCORED');
    expect(t.tone).not.toBe('ok');
  });
});
