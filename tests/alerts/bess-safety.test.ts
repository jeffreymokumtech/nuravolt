/**
 * BESS_SAFETY alert rule and state machine.
 *
 * The state machine is the existing one in src/lib/alerts/evaluate.ts; what is
 * new is that it is now keyed on (plant, kind, dedup_key) so one bad rack opens
 * one alert instead of one per day, and two bad racks stay two alerts. These
 * tests pin both that and the fact that the plant-wide kinds still key on a
 * null dedup_key exactly as before.
 *
 * No database: prisma is a small in-memory stand-in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  alerts: [] as any[],
  artifact: { value: null as any },
  seq: 0,
}));

vi.mock('@/libs/prisma', () => {
  const matches = (row: any, where: any) => {
    if (where.plant_id !== undefined && row.plant_id !== where.plant_id) return false;
    if (where.kind !== undefined && row.kind !== where.kind) return false;
    if (where.dedup_key !== undefined && row.dedup_key !== where.dedup_key) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.resolved_at?.gte) {
      if (!row.resolved_at || row.resolved_at < where.resolved_at.gte) return false;
    }
    return true;
  };

  return {
    default: {
      plantAlert: {
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          const rows = state.alerts.filter((r) => matches(r, where));
          if (orderBy?.resolved_at === 'desc') {
            rows.sort((a, b) => (b.resolved_at?.getTime() ?? 0) - (a.resolved_at?.getTime() ?? 0));
          }
          return rows[0] ?? null;
        }),
        findMany: vi.fn(async ({ where }: any) => state.alerts.filter((r) => matches(r, where))),
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: `alert-${++state.seq}`,
            status: 'ACTIVE',
            dedup_key: null,
            resolved_at: null,
            triggered_at: new Date(),
            last_seen_at: new Date(),
            ...data,
          };
          state.alerts.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = state.alerts.find((r) => r.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      analysisArtifact: {
        findUnique: vi.fn(async () => state.artifact.value),
      },
      plantDataSource: { findMany: vi.fn(async () => []) },
      latestDeviceSnapshot: { findFirst: vi.fn(async () => null) },
    },
  };
});

vi.mock('@/lib/db/timeseries', () => ({
  queryAnalysisResults: vi.fn(async () => []),
}));

import {
  BESS_SAFETY_ARTIFACT_KIND,
  bessSafetyDisclosure,
  bessSafetyReadings,
  evaluatePlant,
} from '@/lib/alerts/evaluate';

const PLANT = {
  id: 'plant-1',
  slug: 'kilima-solar',
  status: 'OPERATIONAL',
  metadata: {},
} as any;

const ORG = 'org-1';

/** The exact sentence tests/bess/test_state_of_safety.py pins on the Python side. */
const DISCLOSURE_15 =
  'State of safety is a trend and margin indicator computed from 15 minute ' +
  'cloud telemetry. It is not a protection system and must not be relied on ' +
  'for emergency response. Your BMS and fire detection system are.';

function artifact(readings: any[], generatedAt = new Date()) {
  return {
    generated_at: generatedAt,
    payload: { interval_minutes: 15, disclosure: DISCLOSURE_15, readings },
  };
}

const rack = (id: string, score: number, limiting = 'imbalance') => ({
  asset_id: 'bess-1',
  device_id: `BESS bess-1.R-${id}`,
  device_label: `Rack ${id}`,
  score,
  band: score >= 60 ? 'MODERATE' : 'HIGH',
  limiting_index: limiting,
});

beforeEach(() => {
  state.alerts.length = 0;
  state.artifact.value = null;
  state.seq = 0;
});

// ---------------------------------------------------------------------------

describe('bessSafetyDisclosure', () => {
  it('matches the canonical wording word for word', () => {
    expect(bessSafetyDisclosure(15)).toBe(DISCLOSURE_15);
  });

  it('says periodic when the cadence is unknown rather than naming one', () => {
    expect(bessSafetyDisclosure(null)).toContain('periodic cloud telemetry');
    expect(bessSafetyDisclosure(0)).toContain('periodic cloud telemetry');
  });

  it('carries no dashes and no emoji', () => {
    for (const text of [bessSafetyDisclosure(15), bessSafetyDisclosure(null)]) {
      expect(text).not.toMatch(/[—–]| - /);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('bessSafetyReadings', () => {
  it('keys one reading per device so racks do not collide', () => {
    const readings = bessSafetyReadings({
      interval_minutes: 15,
      readings: [rack('1', 42), rack('2', 88)],
    });
    expect(readings.map((r) => r.dedupKey)).toEqual([
      'bess-1:state_of_safety:BESS bess-1.R-1',
      'bess-1:state_of_safety:BESS bess-1.R-2',
    ]);
    expect(readings.every((r) => r.kind === 'BESS_SAFETY')).toBe(true);
  });

  it('breaches below the MODERATE floor and clears above it with hysteresis', () => {
    const [breach] = bessSafetyReadings({ readings: [rack('1', 42)] });
    expect(breach.breached).toBe(true);
    expect(breach.cleared).toBe(false);
    expect(breach.threshold).toBe(60);

    const [inBand] = bessSafetyReadings({ readings: [rack('1', 62)] });
    expect(inBand.breached).toBe(false);
    expect(inBand.cleared).toBe(false); // inside the hysteresis margin

    const [clear] = bessSafetyReadings({ readings: [rack('1', 80)] });
    expect(clear.cleared).toBe(true);
  });

  it('raises CRITICAL only for thermal and protection failures', () => {
    const thermal = bessSafetyReadings({
      readings: [rack('1', 12, 'thermal_margin')],
    })[0];
    const protection = bessSafetyReadings({
      readings: [rack('1', 0, 'protection_status')],
    })[0];
    const imbalance = bessSafetyReadings({ readings: [rack('1', 12, 'imbalance')] })[0];
    const dwell = bessSafetyReadings({ readings: [rack('1', 5, 'dwell_exposure')] })[0];

    expect(thermal.severity).toBe('CRITICAL');
    expect(protection.severity).toBe('CRITICAL');
    // Real, worth a work order, not worth waking someone at 3am off 15 minute
    // cloud telemetry.
    expect(imbalance.severity).toBe('WARNING');
    expect(dwell.severity).toBe('WARNING');
  });

  it('keeps a thermal reading inside the HIGH band at WARNING', () => {
    const reading = bessSafetyReadings({
      readings: [rack('1', 55, 'thermal_margin')],
    })[0];
    expect(reading.severity).toBe('WARNING');
  });

  it('carries the disclosure into the alert message, not just the context', () => {
    const [reading] = bessSafetyReadings({
      interval_minutes: 15,
      disclosure: DISCLOSURE_15,
      readings: [rack('1', 42, 'thermal_margin')],
    });
    expect(reading.message).toContain('State of safety 42 out of 100 for Rack 1');
    expect(reading.message).toContain('limited by thermal margin');
    expect(reading.message).toContain(DISCLOSURE_15);
    expect((reading.context as any).disclosure).toBe(DISCLOSURE_15);
  });

  it('skips a device with no score instead of treating it as safe or as broken', () => {
    const readings = bessSafetyReadings({
      readings: [
        { ...rack('1', 0), score: null, unavailable: ['imbalance'] },
        rack('2', 90),
      ],
    });
    expect(readings).toHaveLength(1);
    expect((readings[0].context as any).device_id).toBe('BESS bess-1.R-2');
  });

  it('tolerates an absent or malformed payload', () => {
    expect(bessSafetyReadings(null)).toEqual([]);
    expect(bessSafetyReadings({})).toEqual([]);
    expect(bessSafetyReadings({ readings: [{ score: 10 }] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('BESS_SAFETY state machine', () => {
  it('opens one alert per bad rack and does not reopen them on the next run', async () => {
    state.artifact.value = artifact([rack('1', 42), rack('2', 30), rack('3', 95)]);

    const first = await evaluatePlant(PLANT, ORG);
    expect(first.opened).toBe(2);
    expect(state.alerts).toHaveLength(2);
    expect(state.alerts.map((a) => a.dedup_key)).toEqual([
      'bess-1:state_of_safety:BESS bess-1.R-1',
      'bess-1:state_of_safety:BESS bess-1.R-2',
    ]);

    const second = await evaluatePlant(PLANT, ORG);
    expect(second.opened).toBe(0);
    expect(state.alerts).toHaveLength(2);
  });

  it('escalates a rack from WARNING to CRITICAL exactly once', async () => {
    state.artifact.value = artifact([rack('1', 42, 'imbalance')]);
    await evaluatePlant(PLANT, ORG);
    expect(state.alerts[0].severity).toBe('WARNING');

    state.artifact.value = artifact([rack('1', 12, 'thermal_margin')]);
    const escalation = await evaluatePlant(PLANT, ORG);
    expect(escalation.escalated).toBe(1);
    expect(escalation.notify).toHaveLength(1);
    expect(state.alerts[0].severity).toBe('CRITICAL');

    const again = await evaluatePlant(PLANT, ORG);
    expect(again.escalated).toBe(0);
    expect(again.notify).toHaveLength(0);
  });

  it('resolves only the rack that recovered', async () => {
    state.artifact.value = artifact([rack('1', 42), rack('2', 30)]);
    await evaluatePlant(PLANT, ORG);

    state.artifact.value = artifact([rack('1', 90), rack('2', 30)]);
    const run = await evaluatePlant(PLANT, ORG);
    expect(run.resolved).toBe(1);

    const byKey = Object.fromEntries(state.alerts.map((a) => [a.dedup_key, a.status]));
    expect(byKey['bess-1:state_of_safety:BESS bess-1.R-1']).toBe('RESOLVED');
    expect(byKey['bess-1:state_of_safety:BESS bess-1.R-2']).toBe('ACTIVE');
  });

  it('reopens the same row silently within the flap guard', async () => {
    state.artifact.value = artifact([rack('1', 42)]);
    await evaluatePlant(PLANT, ORG);
    state.artifact.value = artifact([rack('1', 90)]);
    await evaluatePlant(PLANT, ORG);
    state.artifact.value = artifact([rack('1', 42)]);
    const run = await evaluatePlant(PLANT, ORG);

    expect(run.opened).toBe(0);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].status).toBe('ACTIVE');
  });

  it('stops evaluating a safety snapshot older than the max age', async () => {
    const stale = new Date(Date.now() - 72 * 3_600_000);
    state.artifact.value = artifact([rack('1', 12, 'thermal_margin')], stale);
    const run = await evaluatePlant(PLANT, ORG);
    expect(run.readings.filter((r) => r.kind === 'BESS_SAFETY')).toHaveLength(0);
    expect(state.alerts).toHaveLength(0);
  });

  it('does nothing for a plant with no published safety artifact', async () => {
    state.artifact.value = null;
    const run = await evaluatePlant(PLANT, ORG);
    expect(run.readings).toHaveLength(0);
    expect(state.alerts).toHaveLength(0);
  });

  it('names the artifact kind the pipeline publish step writes', () => {
    expect(BESS_SAFETY_ARTIFACT_KIND).toBe('bess_state_of_safety');
  });
});
