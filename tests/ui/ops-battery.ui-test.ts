/**
 * Battery console shaping.
 *
 * The regression this file exists for: a battery that was onboarded without a
 * supply contract serves `terms: null` from the warranty route, and the
 * Warranty tab dereferenced it unguarded. One tab click took the whole screen
 * into the error boundary. A panel with nothing to show must render an empty
 * state; it must never throw, and it must never fill the gap with an
 * industry-typical number under a heading that says "contractual".
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import {
  NO_VALUE,
  eur,
  fin,
  fmt,
  legacyWindow,
  normalizeWarrantyHealth,
  normalizeWarrantyTerms,
  sohProjectionGap,
  tierTone,
  utcWindow,
  warrantyBudgetRows,
} from '@/app/demo/_components/OpsBattery';

/** The warranty payload a freshly created asset actually gets served. */
const FRESH_ASSET_WARRANTY = {
  assetId: 'asset-1',
  status: {
    currentSoh: 0.9828,
    warrantyThreshold: 0.7,
    sohMargin: 0.2828,
    equivalentFullCycles: 101.59,
    yearsRemaining: 8.92,
    warrantyHealthScore: 75,
    riskLevel: 'MODERATE',
    activeViolations: 383,
  },
  healthScore: {
    score: 75,
    riskLevel: 'MODERATE',
    components: {
      sohScore: 98,
      cycleScore: 98,
      timeScore: 89,
      efficiencyScore: 100,
      violationsScore: 0,
    },
    metrics: {
      currentSoh: 0.9828,
      warrantyThreshold: 0.7,
      cyclesUsed: 101.59,
      cyclesRemaining: 936,
      yearsRemaining: 8.92,
    },
    recommendation: 'Monitor operating conditions.',
  },
  // No BessWarrantyTerms row: nobody has uploaded the supply contract.
  terms: null,
  history: [{ date: '2026-08-04', healthScore: 75, soh: 0.9828, cyclesUsed: 102 }],
};

describe('warranty terms normalisation', () => {
  it('returns null when the route serves no terms, rather than inventing clauses', () => {
    expect(normalizeWarrantyTerms(FRESH_ASSET_WARRANTY)).toBeNull();
    expect(normalizeWarrantyTerms({ terms: undefined })).toBeNull();
    expect(normalizeWarrantyTerms(null)).toBeNull();
  });

  it('does not substitute a default for an individually missing clause', () => {
    const terms = normalizeWarrantyTerms({
      terms: { capacityGuaranteePct: 0.7, warrantyYears: 10 },
    });
    expect(terms).not.toBeNull();
    expect(terms!.capacity_guarantee_pct).toBe(0.7);
    expect(terms!.warranty_years).toBe(10);
    // Absent in the contract, absent here. No 6000-cycle / 0.85-RTE stand-ins.
    expect(terms!.max_cycles).toBeNull();
    expect(terms!.min_rte).toBeNull();
    expect(terms!.max_throughput_mwh).toBeNull();
    expect(terms!.operating_temp_min_c).toBeNull();
    expect(terms!.operating_temp_max_c).toBeNull();
  });

  it('reads the legacy snake_case fixture spelling too', () => {
    const terms = normalizeWarrantyTerms({
      warranty_terms: { capacity_guarantee_pct: 0.8, max_cycles: 6000, min_rte: 0.9 },
    });
    expect(terms).toMatchObject({
      capacity_guarantee_pct: 0.8,
      max_cycles: 6000,
      min_rte: 0.9,
    });
  });
});

describe('warranty health normalisation', () => {
  it('shapes the live route payload', () => {
    const wh = normalizeWarrantyHealth(FRESH_ASSET_WARRANTY)!;
    expect(wh.score).toBe(75);
    expect(wh.risk_level).toBe('MODERATE');
    expect(wh.cycles_used).toBeCloseTo(101.59);
    expect(wh.recommendation).toBe('Monitor operating conditions.');
  });

  it('leaves a missing score null instead of zero, so it renders as no data', () => {
    const wh = normalizeWarrantyHealth({ healthScore: { riskLevel: 'LOW' } })!;
    expect(wh.score).toBeNull();
    expect(wh.years_remaining).toBeNull();
    expect(wh.cycles_used).toBeNull();
    expect(wh.recommendation).toBeNull();
    expect(wh.component_scores.soh).toBeNull();
  });

  it('does not claim LOW risk when the payload carries no risk level', () => {
    const wh = normalizeWarrantyHealth({ healthScore: { score: 40 } })!;
    expect(wh.risk_level).toBeNull();
    expect(tierTone(wh.risk_level)).toBe('muted');
  });
});

describe('risk tier tones', () => {
  it('uses the canonical four levels the API and the Prisma enum emit', () => {
    expect(tierTone('LOW')).toBe('ok');
    expect(tierTone('MODERATE')).toBe('warn');
    expect(tierTone('HIGH')).toBe('alarm');
    expect(tierTone('CRITICAL')).toBe('alarm');
  });

  it('keeps the legacy MEDIUM fixture spelling working', () => {
    expect(tierTone('MEDIUM')).toBe('warn');
  });

  it('reads an unknown level as muted, never as ok', () => {
    expect(tierTone('SOMETHING_NEW')).toBe('muted');
    expect(tierTone(null)).toBe('muted');
    expect(tierTone(undefined)).toBe('muted');
  });
});

describe('warranty budget rows', () => {
  it('drops every contract-bounded axis when there are no terms', () => {
    const wh = normalizeWarrantyHealth(FRESH_ASSET_WARRANTY);
    const rows = warrantyBudgetRows(wh, null);
    // Only efficiency survives: it is scored by the route, not capped by a clause.
    expect(rows.map((r) => r.label)).toEqual(['Efficiency']);
  });

  it('renders every axis once both the clause and the measurement exist', () => {
    const wh = normalizeWarrantyHealth(FRESH_ASSET_WARRANTY);
    const wt = normalizeWarrantyTerms({
      terms: { capacityGuaranteePct: 0.7, warrantyYears: 10, maxCycles: 5000 },
    });
    expect(warrantyBudgetRows(wh, wt).map((r) => r.label)).toEqual([
      'Capacity guarantee',
      'Cycle budget',
      'Calendar age',
      'Efficiency',
    ]);
  });

  it('never divides by a zero cycle cap', () => {
    const wh = normalizeWarrantyHealth(FRESH_ASSET_WARRANTY);
    const wt = normalizeWarrantyTerms({ terms: { maxCycles: 0 } });
    const rows = warrantyBudgetRows(wh, wt);
    expect(rows.every((r) => Number.isFinite(r.fraction))).toBe(true);
    expect(rows.some((r) => r.label === 'Cycle budget')).toBe(false);
  });

  it('is empty when there is neither health nor terms, so the caller shows the empty state', () => {
    expect(warrantyBudgetRows(null, null)).toEqual([]);
  });
});

describe('absent-value rendering', () => {
  it('treats null, undefined, NaN and Infinity alike as absent', () => {
    expect(fin(null)).toBeNull();
    expect(fin(undefined)).toBeNull();
    expect(fin(Number.NaN)).toBeNull();
    expect(fin(Number.POSITIVE_INFINITY)).toBeNull();
    expect(fin('')).toBeNull();
    expect(fin(0)).toBe(0);
  });

  it('marks an absent number rather than printing a zero', () => {
    expect(fmt(null, 1)).toBe(NO_VALUE);
    expect(fmt(undefined, 0)).toBe(NO_VALUE);
    expect(fmt(0, 1)).toBe('0.0');
    expect(fmt(98.276, 1, '%')).toBe('98.3%');
    expect(eur(null)).toBe(NO_VALUE);
    expect(eur(0)).toBe('€0');
    expect(eur(474.79)).toBe('€475');
  });
});

describe('arbitrage window rendering', () => {
  it('reads the window objects the dispatch route serves', () => {
    expect(
      utcWindow({
        start: '2026-08-04T11:00:00.000Z',
        end: '2026-08-04T12:00:00.000Z',
        avgPriceEurMwh: 36,
      }),
    ).toBe('11:00 to 12:00');
  });

  it('returns null for a row that carries no window, so the caller can fall back', () => {
    expect(utcWindow(null)).toBeNull();
    expect(utcWindow({})).toBeNull();
  });

  it('still reads the older flat fixture hours', () => {
    expect(legacyWindow({ startHour: 2, endHour: 5 })).toBe('2h to 5h');
    expect(legacyWindow({})).toBe(NO_VALUE);
  });
});

describe('state of health projection gap', () => {
  const point = { date: '2026-01-01', soh: 0.98, source: 'capacity_test', cumulative_cycles: 10 };

  it('names the missing input rather than saying unavailable', () => {
    expect(sohProjectionGap(null, 0.7, {})).toMatch(/no state of health measurements/);
    expect(sohProjectionGap([point], null, {})).toMatch(/no capacity guarantee on file/);
    expect(sohProjectionGap([point], 0.7, null)).toMatch(/no cycling record/);
    expect(sohProjectionGap([point], 0.7, {})).toMatch(/not enough state of health history/);
  });
});
