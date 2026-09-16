/**
 * BESS availability and obligation assurance (Arc I).
 *
 * Pure-function coverage of the availability definition and every reading
 * variant, plus a mocked end-to-end pass through evaluatePlantContracts to
 * exercise the obligation alert lifecycle and prove the category breakdown
 * survives into the artifact the Contracts tab reads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory stand-ins for the two data planes the evaluator touches
// ---------------------------------------------------------------------------

const { db, prismaMock } = vi.hoisted(() => {
  const store = {
    contracts: [] as any[],
    assets: [] as any[],
    cycleRecords: [] as any[],
    analysisRows: [] as any[],
    alerts: [] as any[],
    artifacts: [] as any[],
    alertSeq: 0,
  };

  const matches = (alert: any, where: any): boolean => {
    if (where.plant_id && alert.plant_id !== where.plant_id) return false;
    if (where.kind && alert.kind !== where.kind) return false;
    if (where.dedup_key && alert.dedup_key !== where.dedup_key) return false;
    if (where.status && alert.status !== where.status) return false;
    if (where.resolved_at?.gte) {
      if (!alert.resolved_at || alert.resolved_at < where.resolved_at.gte) return false;
    }
    return true;
  };

  const client = {
    contract: { findMany: async () => store.contracts },
    ticket: { findMany: async (): Promise<any[]> => [] },
    bessAsset: { findMany: async () => store.assets },
    bessCycleRecord: { findMany: async () => store.cycleRecords },
    bessWarrantyStatus: { findFirst: async (): Promise<any> => null },
    bessWarrantyViolation: { count: async () => 0 },
    plantAlert: {
      findFirst: async ({ where }: any) => store.alerts.find((a) => matches(a, where)) ?? null,
      findMany: async ({ where }: any) => store.alerts.filter((a) => matches(a, where)),
      create: async ({ data }: any) => {
        const alert = {
          id: `alert-${++store.alertSeq}`,
          status: 'ACTIVE',
          resolved_at: null,
          ...data,
        };
        store.alerts.push(alert);
        return alert;
      },
      update: async ({ where, data }: any) => {
        const alert = store.alerts.find((a) => a.id === where.id)!;
        Object.assign(alert, data);
        return alert;
      },
    },
    analysisArtifact: {
      upsert: async (args: any) => {
        store.artifacts.push(args);
        return {};
      },
    },
  };

  return { db: store, prismaMock: client };
});

vi.mock('@/libs/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/db/timeseries', () => ({
  queryAnalysisResults: async (q: any) => (q.domain === 'bess' ? db.analysisRows : []),
}));

import {
  annualCycleCapReading,
  availabilityMetricRows,
  availabilitySamplingCaveat,
  bessAvailabilityReading,
  classifyAvailabilityPeriod,
  evaluatePlantContracts,
  rteFloorReading,
  satisfactoryPerformanceReading,
  summarizeAvailability,
  UNAVAILABILITY_CATEGORIES,
  BESS_AVAILABILITY_METRICS,
  type AvailabilityPeriodSample,
} from '@/lib/contracts/evaluate';
import { CONTRACT_TERM_FIELDS, termFieldDef } from '@/lib/contracts/term-fields';
import { bessTermsUpdateFromContract } from '@/lib/contracts/bess-sync';

// ---------------------------------------------------------------------------
// Period samples
// ---------------------------------------------------------------------------

const DECLARED_MW = 20;
const DECLARED_DURATION_H = 2;

function period(overrides: Partial<AvailabilityPeriodSample> = {}): AvailabilityPeriodSample {
  return {
    telemetry_present: true,
    grid_connected: true,
    blocking_alarm: false,
    deliverable_mw: DECLARED_MW,
    usable_energy_mwh: DECLARED_MW * DECLARED_DURATION_H,
    declared_mw: DECLARED_MW,
    declared_duration_h: DECLARED_DURATION_H,
    ...overrides,
  };
}

describe('classifyAvailabilityPeriod', () => {
  it('counts a fully capable, connected, alarm-free period as available', () => {
    const v = classifyAvailabilityPeriod(period());
    expect(v.available).toBe(true);
    expect(v.category).toBeNull();
    expect(v.effective_mw).toBe(DECLARED_MW);
  });

  it('a missing sample is no_telemetry, never a silent pass', () => {
    const v = classifyAvailabilityPeriod(period({ telemetry_present: false, deliverable_mw: null }));
    expect(v.category).toBe('no_telemetry');
    expect(v.effective_mw).toBe(0);
  });

  it('not grid-connected and blocking alarm both read as offline', () => {
    expect(classifyAvailabilityPeriod(period({ grid_connected: false })).category).toBe('offline');
    expect(classifyAvailabilityPeriod(period({ blocking_alarm: true })).category).toBe('offline');
  });

  it('racks short of the declared MW is derated', () => {
    const v = classifyAvailabilityPeriod(period({ deliverable_mw: 12 }));
    expect(v.category).toBe('derated');
    expect(v.effective_mw).toBe(12);
  });

  it('full power but not enough energy for the declared duration is soc_unable', () => {
    const v = classifyAvailabilityPeriod(period({ usable_energy_mwh: 20 }));
    expect(v.category).toBe('soc_unable');
    // 20 MWh over a 2h declared duration is only 10 MW of sustained capability
    expect(v.effective_mw).toBe(10);
  });

  it('an operator-declared curtailment is excluded, whatever the asset state says', () => {
    const v = classifyAvailabilityPeriod(
      period({ operator_curtailed: true, grid_connected: false, deliverable_mw: 0 }),
    );
    expect(v.category).toBe('operator_curtailed');
  });

  it('tolerates telemetry noise just under the declared MW', () => {
    expect(classifyAvailabilityPeriod(period({ deliverable_mw: 19.9 })).available).toBe(true);
    expect(classifyAvailabilityPeriod(period({ deliverable_mw: 19.5 })).available).toBe(false);
  });
});

describe('summarizeAvailability', () => {
  /**
   * One 24-hour fixture day at half-hourly settlement periods (48 periods):
   *   4 periods no telemetry
   *   6 periods offline (2 tripped on a blocking alarm)
   *   8 periods derated to half power
   *   2 periods with the power but not the energy
   *   4 periods the customer curtailed itself
   *  24 periods fully available
   */
  const fixtureDay: AvailabilityPeriodSample[] = [
    ...Array.from({ length: 4 }, () => period({ telemetry_present: false, deliverable_mw: null })),
    ...Array.from({ length: 4 }, () => period({ grid_connected: false, deliverable_mw: 0 })),
    ...Array.from({ length: 2 }, () => period({ blocking_alarm: true, deliverable_mw: 0 })),
    ...Array.from({ length: 8 }, () => period({ deliverable_mw: DECLARED_MW / 2 })),
    ...Array.from({ length: 2 }, () => period({ usable_energy_mwh: 20 })),
    ...Array.from({ length: 4 }, () => period({ operator_curtailed: true })),
    ...Array.from({ length: 24 }, () => period()),
  ];

  const summary = summarizeAvailability(fixtureDay, { periodMinutes: 30 });

  it('splits unavailability by category rather than reporting one useless total', () => {
    expect(summary.unavailable_periods_by_category).toEqual({
      no_telemetry: 4,
      offline: 6,
      derated: 8,
      soc_unable: 2,
      operator_curtailed: 4,
    });
  });

  it('excludes operator-declared curtailment from the measurement entirely', () => {
    expect(summary.total_periods).toBe(48);
    expect(summary.excluded_periods).toBe(4);
    expect(summary.counted_periods).toBe(44);
    // 44 counted, 24 available
    expect(summary.availability_pct).toBeCloseTo((24 / 44) * 100, 6);
  });

  it('energy weights the shortfall so a derate is not scored as an outage', () => {
    // declared: 44 periods * 20 MW * 0.5 h = 440 MWh
    // available: 24 full (240) + 8 half power (40) + 2 soc-limited to 10 MW (10) = 290 MWh
    expect(summary.declared_mwh).toBeCloseTo(440, 6);
    expect(summary.available_mwh).toBeCloseTo(290, 6);
    expect(summary.energy_weighted_availability_pct).toBeCloseTo((290 / 440) * 100, 6);
    // period counting alone would have said 54.5%, understating what was delivered
    expect(summary.availability_pct).toBeCloseTo((24 / 44) * 100, 6);
    expect(summary.availability_pct).toBeLessThan(summary.energy_weighted_availability_pct!);
  });

  it('reports lost MW.h per category, and curtailment as excluded rather than lost', () => {
    const lost = summary.shortfall_mwh_by_category;
    expect(lost.no_telemetry).toBeCloseTo(40, 6); // 4 * 20 MW * 0.5 h
    expect(lost.offline).toBeCloseTo(60, 6);
    expect(lost.derated).toBeCloseTo(40, 6); // 8 periods * 10 MW shortfall * 0.5 h
    expect(lost.soc_unable).toBeCloseTo(10, 6);
    const counted = lost.no_telemetry + lost.offline + lost.derated + lost.soc_unable;
    expect(summary.declared_mwh - summary.available_mwh).toBeCloseTo(counted, 6);
    // excluded energy is tracked but never subtracted from either metric
    expect(lost.operator_curtailed).toBeCloseTo(40, 6);
  });

  it('the two metrics disagree exactly where period counting is blind', () => {
    // A full day at half capability versus half a day fully out. Same lost
    // energy, opposite period counts. This is why the energy-weighted figure is
    // the one tolling and capacity market contracts settle on.
    const halfDerated = summarizeAvailability(
      Array.from({ length: 48 }, () => period({ deliverable_mw: DECLARED_MW / 2 })),
    );
    const halfOut = summarizeAvailability([
      ...Array.from({ length: 24 }, () => period({ grid_connected: false, deliverable_mw: 0 })),
      ...Array.from({ length: 24 }, () => period()),
    ]);
    expect(halfDerated.energy_weighted_availability_pct).toBeCloseTo(50, 6);
    expect(halfOut.energy_weighted_availability_pct).toBeCloseTo(50, 6);
    expect(halfDerated.availability_pct).toBeCloseTo(0, 6);
    expect(halfOut.availability_pct).toBeCloseTo(50, 6);
  });

  it('returns null metrics rather than 100% when there are no periods', () => {
    const empty = summarizeAvailability([]);
    expect(empty.availability_pct).toBeNull();
    expect(empty.energy_weighted_availability_pct).toBeNull();
  });

  it('publishes both metrics and every category under the canonical metric names', () => {
    const rows = availabilityMetricRows(summary);
    const names = rows.map((r) => r.metric);
    expect(names).toContain(BESS_AVAILABILITY_METRICS.energyWeighted);
    expect(names).toContain(BESS_AVAILABILITY_METRICS.periodCount);
    for (const category of UNAVAILABILITY_CATEGORIES) {
      expect(names).toContain(BESS_AVAILABILITY_METRICS.unavailability[category]);
    }
    const derated = rows.find(
      (r) => r.metric === BESS_AVAILABILITY_METRICS.unavailability.derated,
    )!;
    expect(derated.value).toBeCloseTo((40 / 440) * 100, 6);
  });
});

// ---------------------------------------------------------------------------
// Honesty about resolution
// ---------------------------------------------------------------------------

describe('availabilitySamplingCaveat', () => {
  it('names the interval and the outage length it cannot see', () => {
    const text = availabilitySamplingCaveat(15);
    expect(text).toContain('15-minute resolution');
    expect(text).toContain('not a settlement-grade measurement');
    expect(text).toContain('shorter than 15 minutes');
  });

  it('says the interval is unknown instead of guessing one', () => {
    const text = availabilitySamplingCaveat(null);
    expect(text).toContain('not a settlement-grade measurement');
    expect(text).toContain('unknown');
    expect(text).not.toMatch(/\d+-minute/);
  });
});

describe('bessAvailabilityReading', () => {
  const base = { thresholdPct: 97, sampleIntervalMinutes: 15, basis: 'tolling' as const };

  it('refuses a verdict on a thin window', () => {
    const r = bessAvailabilityReading({ ...base, observedPct: 99, measuredDays: 10 });
    expect(r.status).toBe('no_data');
    expect(r.detail).toContain('not a settlement-grade measurement');
  });

  it('applies the same 1pp at-risk band as the PV availability guarantee', () => {
    expect(bessAvailabilityReading({ ...base, observedPct: 99, measuredDays: 28 }).status).toBe('ok');
    expect(bessAvailabilityReading({ ...base, observedPct: 97.5, measuredDays: 28 }).status).toBe(
      'at_risk',
    );
    expect(bessAvailabilityReading({ ...base, observedPct: 96.2, measuredDays: 28 }).status).toBe(
      'breach',
    );
  });

  it('names the categories behind the number', () => {
    const r = bessAvailabilityReading({
      ...base,
      observedPct: 96.2,
      measuredDays: 28,
      byCategoryPp: { derated: 2.4, offline: 1.2, no_telemetry: 0.2, soc_unable: 0.01 },
    });
    expect(r.detail).toContain('derated 2.4pp');
    expect(r.detail).toContain('offline 1.2pp');
    // ordered by size, and noise below 0.05pp is dropped rather than listed
    expect(r.detail.indexOf('derated')).toBeLessThan(r.detail.indexOf('offline'));
    expect(r.detail).not.toContain('state of charge unable');
  });

  it('every figure carries the sampling caveat, whatever the verdict', () => {
    for (const observedPct of [99, 97.5, 96.2]) {
      const r = bessAvailabilityReading({ ...base, observedPct, measuredDays: 28 });
      expect(r.detail).toContain('Sampled availability at 15-minute resolution');
    }
  });

  it('ancillary readings refuse to claim verified response delivery', () => {
    const r = bessAvailabilityReading({
      ...base,
      basis: 'ancillary',
      observedPct: 99,
      measuredDays: 28,
    });
    expect(r.detail).toContain('Availability to respond');
    expect(r.detail).toContain('Response delivery is not verified here');
    expect(r.detail).toContain('1-second data');
    expect(r.detail).toContain('does not receive');
  });

  it('discloses when several devices were folded into one number', () => {
    const r = bessAvailabilityReading({ ...base, observedPct: 99, measuredDays: 28, deviceCount: 3 });
    expect(r.detail).toContain('Averaged across 3 BESS devices');
    expect(
      bessAvailabilityReading({ ...base, observedPct: 99, measuredDays: 28, deviceCount: 1 }).detail,
    ).not.toContain('Averaged across');
  });
});

describe('satisfactoryPerformanceReading', () => {
  const base = { windowDays: 300, requiredDays: 250, sampleIntervalMinutes: 15 };

  it('never certifies: a shortfall is at_risk, never a breach', () => {
    const short = satisfactoryPerformanceReading({ ...base, observedDays: 120 });
    expect(short.status).toBe('at_risk');
    const met = satisfactoryPerformanceReading({ ...base, observedDays: 260 });
    expect(met.status).toBe('ok');
    for (const r of [short, met]) {
      expect(r.detail).toContain('Indicative only');
      expect(r.detail).toContain('does not receive');
      expect(r.status).not.toBe('breach');
    }
  });

  it('will not offer even an indicative view off a thin window', () => {
    const r = satisfactoryPerformanceReading({ ...base, windowDays: 12, observedDays: 12 });
    expect(r.status).toBe('no_data');
  });
});

describe('annualCycleCapReading', () => {
  const base = { windowDays: 365, capPerYear: 400, modelledFraction: 0 };

  it('calls an exceeded cap a breach even on a short record history', () => {
    const r = annualCycleCapReading({ ...base, efcUsed: 420, recordDays: 20 });
    expect(r.status).toBe('breach');
  });

  it('will not issue a reassuring verdict off a short record history', () => {
    expect(annualCycleCapReading({ ...base, efcUsed: 100, recordDays: 20 }).status).toBe('no_data');
    expect(annualCycleCapReading({ ...base, efcUsed: 100, recordDays: 200 }).status).toBe('ok');
    expect(annualCycleCapReading({ ...base, efcUsed: 340, recordDays: 200 }).status).toBe('at_risk');
  });

  it('says when the cycles are modelled dispatch rather than metered throughput', () => {
    const modelled = annualCycleCapReading({
      ...base,
      efcUsed: 100,
      recordDays: 200,
      modelledFraction: 1,
    });
    expect(modelled.detail).toContain('dispatch model output, not metered throughput');
    const measured = annualCycleCapReading({ ...base, efcUsed: 100, recordDays: 200 });
    expect(measured.detail).not.toContain('dispatch model output');
  });

  it('reports no_data instead of zero when no cycle records exist', () => {
    expect(annualCycleCapReading({ ...base, efcUsed: null, recordDays: 0 }).status).toBe('no_data');
  });
});

describe('rteFloorReading', () => {
  const base = { windowDays: 90, floorPct: 86, modelledFraction: 0 };

  it('bands the floor with a 1pp at-risk margin', () => {
    expect(rteFloorReading({ ...base, rtePct: 88, recordDays: 60 }).status).toBe('ok');
    expect(rteFloorReading({ ...base, rtePct: 86.5, recordDays: 60 }).status).toBe('at_risk');
    expect(rteFloorReading({ ...base, rtePct: 84, recordDays: 60 }).status).toBe('breach');
  });

  it('needs a fortnight of records before it says anything', () => {
    expect(rteFloorReading({ ...base, rtePct: 84, recordDays: 5 }).status).toBe('no_data');
    expect(rteFloorReading({ ...base, rtePct: null, recordDays: 60 }).status).toBe('no_data');
  });
});

// ---------------------------------------------------------------------------
// Term vocabulary
// ---------------------------------------------------------------------------

describe('BESS market contract vocabulary', () => {
  it('defines bounds on every numeric field of the three new types', () => {
    for (const type of ['BESS_TOLLING', 'BESS_CAPACITY_MARKET', 'BESS_ANCILLARY'] as const) {
      const defs = CONTRACT_TERM_FIELDS[type];
      expect(defs.length).toBeGreaterThan(0);
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

  it('marks exactly the fields the evaluator can read as monitorable', () => {
    const monitorable = (type: 'BESS_TOLLING' | 'BESS_CAPACITY_MARKET' | 'BESS_ANCILLARY') =>
      CONTRACT_TERM_FIELDS[type].filter((d) => d.monitorable).map((d) => d.field).sort();
    expect(monitorable('BESS_TOLLING')).toEqual([
      'guaranteed_availability_pct',
      'max_cycles_per_year',
      'min_rte_pct',
    ]);
    expect(monitorable('BESS_CAPACITY_MARKET')).toEqual(['satisfactory_performance_days']);
    expect(monitorable('BESS_ANCILLARY')).toEqual(['response_availability_pct']);
  });

  it('keeps the availability measurement basis as text we quote, not a number we compute', () => {
    const def = termFieldDef('BESS_TOLLING', 'availability_measurement_basis')!;
    expect(def.kind).toBe('text');
    expect(def.monitorable).toBeUndefined();
  });
});

describe('bessTermsUpdateFromContract with tolling operating terms', () => {
  it('flows min_rte_pct into the fraction-unit column from any contract type', () => {
    const { update, applied } = bessTermsUpdateFromContract([
      { field: 'min_rte_pct', value_numeric: 88, status: 'CONFIRMED' },
    ]);
    expect(update.min_rte).toBeCloseTo(0.88, 6);
    expect(applied).toContain('min_rte_pct');
  });

  it('converts a per-year cycle cap into the lifetime budget column using agreement years', () => {
    const { update, applied } = bessTermsUpdateFromContract([
      { field: 'max_cycles_per_year', value_numeric: 400, status: 'CONFIRMED' },
      { field: 'agreement_years', value_numeric: 7, status: 'CONFIRMED' },
    ]);
    expect(update.max_cycles).toBe(2800);
    expect(applied).toContain('max_cycles_per_year');
  });

  it('skips the per-year cap honestly when nothing gives it a term length', () => {
    const { update, skipped } = bessTermsUpdateFromContract([
      { field: 'max_cycles_per_year', value_numeric: 400, status: 'CONFIRMED' },
    ]);
    expect(update.max_cycles).toBeUndefined();
    expect(skipped.some((s) => s.startsWith('max_cycles_per_year'))).toBe(true);
  });

  it('never overwrites a warranted lifetime budget with an operating cap', () => {
    const fromExistingRow = bessTermsUpdateFromContract(
      [
        { field: 'max_cycles_per_year', value_numeric: 400, status: 'CONFIRMED' },
        { field: 'agreement_years', value_numeric: 7, status: 'CONFIRMED' },
      ],
      { existingMaxCycles: 6000 },
    );
    expect(fromExistingRow.update.max_cycles).toBeUndefined();
    expect(fromExistingRow.skipped.some((s) => s.startsWith('max_cycles_per_year'))).toBe(true);

    const fromSameContract = bessTermsUpdateFromContract([
      { field: 'cycle_count_warranty', value_numeric: 6000, status: 'CONFIRMED' },
      { field: 'warranty_years', value_numeric: 10, status: 'CONFIRMED' },
      { field: 'max_cycles_per_year', value_numeric: 400, status: 'CONFIRMED' },
    ]);
    expect(fromSameContract.update.max_cycles).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// Obligation alert lifecycle through the real evaluator
// ---------------------------------------------------------------------------

const PLANT = { id: 'plant-uuid', slug: 'gb-bess-one' } as any;
const CONTRACT_ID = 'contract-tolling-1';
const ASSET_ID = 'asset-1';

function availabilityRows(
  days: number,
  energyWeightedPct: number,
  byCategoryPp: Partial<Record<string, number>> = {},
) {
  const rows: any[] = [];
  for (let i = 0; i < days; i += 1) {
    const time = new Date(Date.now() - i * 86_400_000);
    rows.push({
      time,
      device_id: 'BESS athi-1',
      metric: BESS_AVAILABILITY_METRICS.energyWeighted,
      value: energyWeightedPct,
      metadata: { sample_interval_minutes: 15 },
    });
    for (const [category, pp] of Object.entries(byCategoryPp)) {
      rows.push({
        time,
        device_id: 'BESS athi-1',
        metric: BESS_AVAILABILITY_METRICS.unavailability[category as never],
        value: pp,
        metadata: { sample_interval_minutes: 15 },
      });
    }
  }
  return rows;
}

function tollingContract(overrides: any = {}) {
  return {
    id: CONTRACT_ID,
    contract_type: 'BESS_TOLLING',
    bess_asset_id: ASSET_ID,
    terms: [
      {
        field: 'guaranteed_availability_pct',
        value_numeric: 97,
        unit: '%',
        status: 'CONFIRMED',
        monitored: true,
      },
    ],
    ...overrides,
  };
}

describe('evaluatePlantContracts: BESS availability obligations', () => {
  beforeEach(() => {
    db.contracts = [];
    db.assets = [{ id: ASSET_ID, name: 'athi-1', external_asset_id: 'ATHI-1' }];
    db.cycleRecords = [];
    db.analysisRows = [];
    db.alerts = [];
    db.artifacts = [];
    db.alertSeq = 0;
  });

  it('opens one alert on a breach, keeps it through at_risk, resolves only on ok', async () => {
    db.contracts = [tollingContract()];
    db.analysisRows = availabilityRows(30, 95.2, { derated: 3.1, offline: 1.4, no_telemetry: 0.3 });

    const first = await evaluatePlantContracts(PLANT, 'org-1');
    expect(first!.opened).toBe(1);
    const reading = first!.obligations.find((o) => o.field === 'guaranteed_availability_pct')!;
    expect(reading.status).toBe('breach');
    expect(reading.observed_value).toBeCloseTo(95.2, 2);
    expect(reading.detail).toContain('derated 3.1pp');
    expect(reading.detail).toContain('Sampled availability at 15-minute resolution');
    expect(db.alerts[0].dedup_key).toBe(`${CONTRACT_ID}:guaranteed_availability_pct`);

    // Same breach again: updated in place, not duplicated.
    const second = await evaluatePlantContracts(PLANT, 'org-1');
    expect(second!.opened).toBe(0);
    expect(db.alerts.filter((a) => a.status === 'ACTIVE')).toHaveLength(1);

    // Recovery into the at-risk band must not clear the alert.
    db.analysisRows = availabilityRows(30, 97.4);
    const third = await evaluatePlantContracts(PLANT, 'org-1');
    expect(third!.obligations[0].status).toBe('at_risk');
    expect(third!.resolved).toBe(0);
    expect(db.alerts.filter((a) => a.status === 'ACTIVE')).toHaveLength(1);

    // Clean recovery resolves it.
    db.analysisRows = availabilityRows(30, 99.1);
    const fourth = await evaluatePlantContracts(PLANT, 'org-1');
    expect(fourth!.obligations[0].status).toBe('ok');
    expect(fourth!.resolved).toBe(1);
    expect(db.alerts.filter((a) => a.status === 'ACTIVE')).toHaveLength(0);
  });

  it('writes the breakdown into the contract_obligations artifact', async () => {
    db.contracts = [tollingContract()];
    db.analysisRows = availabilityRows(30, 95.2, { derated: 3.1, soc_unable: 1.5 });
    await evaluatePlantContracts(PLANT, 'org-1');
    const payload = db.artifacts.at(-1)!.create.payload;
    expect(db.artifacts.at(-1)!.where.plant_id_kind.kind).toBe('contract_obligations');
    expect(payload.obligations[0].detail).toContain('state of charge unable 1.5pp');
  });

  it('returns no_data, and opens nothing, on a window too thin to judge', async () => {
    db.contracts = [tollingContract()];
    db.analysisRows = availabilityRows(10, 80);
    const result = await evaluatePlantContracts(PLANT, 'org-1');
    expect(result!.obligations[0].status).toBe('no_data');
    expect(result!.opened).toBe(0);
    expect(db.alerts).toHaveLength(0);
  });

  it('never opens an alert for capacity market satisfactory performance', async () => {
    db.contracts = [
      {
        id: 'contract-cm-1',
        contract_type: 'BESS_CAPACITY_MARKET',
        bess_asset_id: ASSET_ID,
        terms: [
          {
            field: 'satisfactory_performance_days',
            value_numeric: 300,
            unit: 'days',
            status: 'CONFIRMED',
            monitored: true,
          },
        ],
      },
    ];
    // 120 days of results, all with a shortfall against the declared capability.
    db.analysisRows = availabilityRows(120, 92);
    const result = await evaluatePlantContracts(PLANT, 'org-1');
    const reading = result!.obligations[0];
    expect(reading.status).toBe('at_risk');
    expect(reading.observed_value).toBe(0);
    expect(reading.detail).toContain('never a certification');
    expect(result!.opened).toBe(0);
    expect(db.alerts).toHaveLength(0);
  });

  it('reads the annual cycle cap off the asset cycle records', async () => {
    db.contracts = [
      tollingContract({
        terms: [
          {
            field: 'max_cycles_per_year',
            value_numeric: 400,
            unit: 'cycles/year',
            status: 'CONFIRMED',
            monitored: true,
          },
        ],
      }),
    ];
    db.cycleRecords = Array.from({ length: 200 }, (_, i) => ({
      cycle_date: new Date(Date.now() - i * 86_400_000),
      equivalent_cycles: 1.7,
      energy_in_kwh: 1000,
      energy_out_kwh: 880,
      provenance: 'modelled',
    }));
    const result = await evaluatePlantContracts(PLANT, 'org-1');
    const reading = result!.obligations[0];
    expect(reading.observed_value).toBe(340);
    expect(reading.status).toBe('at_risk');
    expect(reading.detail).toContain('dispatch model output');
  });

  it('an O&M availability guarantee still uses the PV energy proxy, not the BESS lane', async () => {
    db.contracts = [
      {
        id: 'contract-om-1',
        contract_type: 'OM_SLA',
        bess_asset_id: null,
        terms: [
          {
            field: 'guaranteed_availability_pct',
            value_numeric: 98,
            unit: '%',
            status: 'CONFIRMED',
            monitored: true,
          },
        ],
      },
    ];
    db.analysisRows = availabilityRows(30, 95);
    const result = await evaluatePlantContracts(PLANT, 'org-1');
    // The BESS rows in analysis_results are ignored: an O&M guarantee is scored
    // off the PV twin, which has no history here, so it says so.
    expect(result!.obligations[0].window).toBe('30d');
    expect(result!.obligations[0].detail).toContain('measured days in the last 30');
    expect(result!.obligations[0].detail).not.toContain('Sampled availability');
  });
});
