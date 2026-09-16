import { describe, expect, it } from 'vitest';
import { bessTermsUpdateFromContract } from '@/lib/contracts/bess-sync';
import { CONTRACT_TERM_FIELDS, isWithinBounds, termFieldDef } from '@/lib/contracts/term-fields';
import { percentile, slaMetrics } from '@/lib/contracts/sla';
import { availabilityReading, degradationReading, slaReading } from '@/lib/contracts/evaluate';
import { shapeContractsOutput, shapeWarrantyPositionOutput } from '@/lib/ai/tool-shapes';
import { buildContractsThread } from '@/fixtures/demo-conversations/contractsThread';

describe('bessTermsUpdateFromContract', () => {
  it('maps percent-unit contract terms to fraction-unit warranty columns', () => {
    const { update, applied, skipped } = bessTermsUpdateFromContract([
      { field: 'soh_eol_threshold_pct', value_numeric: 70, status: 'CONFIRMED' },
      { field: 'warranty_years', value_numeric: 10, status: 'CONFIRMED' },
      { field: 'cycle_count_warranty', value_numeric: 6000, status: 'CONFIRMED' },
      { field: 'min_rte_pct', value_numeric: 86, status: 'CONFIRMED' },
      { field: 'max_temp_dwell_c', value_numeric: 45, status: 'CONFIRMED' },
      { field: 'max_c_rate_charge', value_numeric: 0.5, status: 'CONFIRMED' },
      { field: 'max_c_rate_discharge', value_numeric: 0.75, status: 'CONFIRMED' },
    ]);
    expect(update).toEqual({
      capacity_guarantee_pct: 0.7,
      warranty_years: 10,
      max_cycles: 6000,
      min_rte: 0.86,
      operating_temp_max_c: 45,
      max_c_rate_continuous: 0.5,
      max_c_rate_peak: 0.75,
    });
    expect(applied).toHaveLength(7);
    expect(skipped).toHaveLength(0);
  });

  it('ignores non-CONFIRMED and null-valued terms', () => {
    const { update, applied } = bessTermsUpdateFromContract([
      { field: 'soh_eol_threshold_pct', value_numeric: 70, status: 'EXTRACTED' },
      { field: 'warranty_years', value_numeric: null, status: 'CONFIRMED' },
    ]);
    expect(update).toEqual({});
    expect(applied).toHaveLength(0);
  });

  it('converts per-year throughput using warranty years from the same contract', () => {
    const { update } = bessTermsUpdateFromContract([
      { field: 'warranty_years', value_numeric: 10, status: 'CONFIRMED' },
      { field: 'max_throughput_mwh_per_year', value_numeric: 1200, status: 'CONFIRMED' },
    ]);
    expect(update.max_throughput_mwh).toBe(12000);
  });

  it('falls back to the existing row warranty years for throughput conversion', () => {
    const { update } = bessTermsUpdateFromContract(
      [{ field: 'max_throughput_mwh_per_year', value_numeric: 1200, status: 'CONFIRMED' }],
      { existingWarrantyYears: 15 },
    );
    expect(update.max_throughput_mwh).toBe(18000);
  });

  it('skips per-year throughput honestly when no warranty years are known', () => {
    const { update, skipped } = bessTermsUpdateFromContract([
      { field: 'max_throughput_mwh_per_year', value_numeric: 1200, status: 'CONFIRMED' },
    ]);
    expect(update.max_throughput_mwh).toBeUndefined();
    expect(skipped.some((s) => s.startsWith('max_throughput_mwh_per_year'))).toBe(true);
  });

  it('reports unmapped fields as skipped instead of dropping them silently', () => {
    const { skipped } = bessTermsUpdateFromContract([
      { field: 'soc_low_dwell_hours', value_numeric: 100, status: 'CONFIRMED' },
    ]);
    expect(skipped.some((s) => s.startsWith('soc_low_dwell_hours'))).toBe(true);
  });
});

describe('contract tool shapers', () => {
  const wire = (id: string, type: string, status = 'ACTIVE') =>
    ({
      id,
      contractType: type,
      title: 't',
      counterparty: null,
      status,
      effectiveFrom: null,
      effectiveTo: null,
      hasSourceDocument: false,
      terms: [],
    }) as never;

  it('obligation_status precedence: breach beats at_risk beats ok', () => {
    const out = shapeContractsOutput({
      plantId: 'p',
      contracts: [wire('c1', 'PPA')],
      obligations: {
        obligations: [
          { contract_id: 'c1', field: 'a', status: 'ok', observed_value: 1, threshold: 1 },
          { contract_id: 'c1', field: 'b', status: 'breach', observed_value: 1, threshold: 1 },
        ] as never,
      },
    });
    expect(out.contracts[0].obligation_status).toBe('breach');
  });

  it('DRAFT contracts always show awaiting_review', () => {
    const out = shapeContractsOutput({
      plantId: 'p',
      contracts: [wire('c1', 'PPA', 'DRAFT')],
      obligations: null,
    });
    expect(out.contracts[0].obligation_status).toBe('awaiting_review');
  });

  it('warranty position converts fractions to percent and keeps the provisional flag', () => {
    const out = shapeWarrantyPositionOutput({
      health_score: { score: 90, current_soh: 0.983, soh_margin: 0.283 },
      warranty_terms: { capacity_guarantee_pct: 0.7, max_cycles: 6000 },
      violations: [],
      provenance: { provisional: true },
    });
    expect(out.current_soh_pct).toBe(98.3);
    expect(out.capacity_floor_pct).toBe(70);
    expect(out.soh_margin_pp).toBe(28.3);
    expect(out.provisional).toBe(true);
    expect(out.note).toContain('never as measured hardware behaviour');
  });
});

describe('contracts demo thread', () => {
  const plant = { slug: 'ribera', name: 'Ribera Solar Park' } as never;
  const thread = buildContractsThread({ plant, surface: 'demo' });

  it('builds and carries no internal plant names', () => {
    const json = JSON.stringify(thread).toLowerCase();
    for (const forbidden of ['redacted_donor_plant', 'redacted_legacy_code']) {
      expect(json).not.toContain(forbidden);
    }
    expect(thread.messages.length).toBe(2);
  });

  it('never presents unreviewed terms as agreed', () => {
    const json = JSON.stringify(thread);
    // Every term in the scripted session is CONFIRMED — the thread must not
    // showcase EXTRACTED values as bound terms.
    expect(json).not.toContain('"EXTRACTED"');
  });
});

describe('contract term vocabulary', () => {
  it('every numeric field defines bounds and every field a label', () => {
    for (const defs of Object.values(CONTRACT_TERM_FIELDS)) {
      for (const def of defs) {
        expect(def.label.length).toBeGreaterThan(0);
        if (def.kind === 'numeric') {
          expect(def.min).toBeDefined();
          expect(def.max).toBeDefined();
          expect(def.min!).toBeLessThan(def.max!);
        }
      }
    }
  });

  it('enforces bounds', () => {
    const def = termFieldDef('PPA', 'price_eur_mwh')!;
    expect(isWithinBounds(def, 52)).toBe(true);
    expect(isWithinBounds(def, -1)).toBe(false);
    expect(isWithinBounds(def, 900)).toBe(false);
    expect(isWithinBounds(def, NaN)).toBe(false);
  });

  it('SLA percentile math interpolates and handles empties', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 5);
  });

  it('slaMetrics buckets response and resolution by priority', () => {
    const base = new Date('2026-07-01T00:00:00Z');
    const h = (n: number) => new Date(base.getTime() + n * 3_600_000);
    const m = slaMetrics([
      { created_at: base, assigned_at: h(2), closed_at: h(30), priority: 'CRITICAL' },
      { created_at: base, assigned_at: h(6), closed_at: h(50), priority: 'CRITICAL' },
      { created_at: base, assigned_at: null, closed_at: null, priority: 'HIGH' },
      // assigned before created (clock skew) must be excluded, not negative
      { created_at: h(5), assigned_at: h(1), closed_at: null, priority: 'LOW' },
    ]);
    expect(m.response.CRITICAL.count).toBe(2);
    expect(m.response.CRITICAL.p90Hours).toBeCloseTo(5.6, 5);
    expect(m.resolution.CRITICAL.count).toBe(2);
    expect(m.response.HIGH).toBeUndefined();
    expect(m.response.LOW).toBeUndefined();
  });

  it('availabilityReading needs 24 measured days and applies the 1pp at-risk band', () => {
    expect(availabilityReading({ prPct: 99, measuredDays: 10, thresholdPct: 97 }).status).toBe('no_data');
    expect(availabilityReading({ prPct: 99, measuredDays: 28, thresholdPct: 97 }).status).toBe('ok');
    expect(availabilityReading({ prPct: 97.5, measuredDays: 28, thresholdPct: 97 }).status).toBe('at_risk');
    expect(availabilityReading({ prPct: 96.2, measuredDays: 28, thresholdPct: 97 }).status).toBe('breach');
  });

  it('degradationReading compares observed decline to the warranted curve with a 1pp margin', () => {
    const base = { baselineDays: 90, currentDays: 90, spanYears: 2, annualDegradationPct: 0.55 };
    // 1.0% decline over 2y vs 1.1% warranted → ok
    expect(degradationReading({ ...base, baselinePr: 100, currentPr: 99 }).status).toBe('ok');
    // 1.5% decline vs 1.1% warranted (within +1pp margin) → at_risk
    expect(degradationReading({ ...base, baselinePr: 100, currentPr: 98.5 }).status).toBe('at_risk');
    // 2.5% decline vs 1.1% warranted (> margin) → breach
    expect(degradationReading({ ...base, baselinePr: 100, currentPr: 97.5 }).status).toBe('breach');
    // short history → no_data, never a verdict
    expect(
      degradationReading({ ...base, spanYears: 0.3, baselinePr: 100, currentPr: 90 }).status,
    ).toBe('no_data');
    expect(degradationReading({ ...base, baselineDays: 10, baselinePr: 100, currentPr: 90 }).status).toBe('no_data');
  });

  it('slaReading requires 3 tickets and flags at 80% of the agreed hours', () => {
    expect(slaReading({ p90Hours: 3, count: 2, termHours: 4, label: 'x' }).status).toBe('no_data');
    expect(slaReading({ p90Hours: 3, count: 5, termHours: 4, label: 'x' }).status).toBe('ok');
    expect(slaReading({ p90Hours: 3.5, count: 5, termHours: 4, label: 'x' }).status).toBe('at_risk');
    expect(slaReading({ p90Hours: 4.5, count: 5, termHours: 4, label: 'x' }).status).toBe('breach');
  });

  it('BESS vocabulary mirrors the Python extractor field names', () => {
    const fields = CONTRACT_TERM_FIELDS.BESS_WARRANTY.map((d) => d.field);
    for (const f of [
      'soh_eol_threshold_pct',
      'cycle_count_warranty',
      'warranty_years',
      'min_rte_pct',
      'max_temp_dwell_c',
      'max_c_rate_charge',
      'max_c_rate_discharge',
      'max_throughput_mwh_per_year',
    ]) {
      expect(fields).toContain(f);
    }
  });
});
