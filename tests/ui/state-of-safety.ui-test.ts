/**
 * State of safety panel logic.
 *
 * The point of these tests is that the UI cannot quietly turn worst-of back
 * into an average. A single critical sub index has to drive the displayed band
 * even when the other three are perfect, and a sub index with no data has to
 * stay out of the composite rather than propping it up at 100.
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import {
  SUB_ASSET_UNAVAILABLE,
  bandForScore,
  bandTone,
  isSafetyPayload,
  resolveReading,
  safetyDisclosure,
  safetyView,
  subIndexLabel,
  unavailableMessage,
  worstOf,
  type SafetyArtifactPayload,
  type SafetySubIndexPayload,
} from '@/app/demo/_components/bess/StateOfSafety';

const sub = (
  name: string,
  score: number | null,
  extra: Partial<SafetySubIndexPayload> = {},
): SafetySubIndexPayload => ({
  name,
  score,
  available: score != null,
  method: `${name} method`,
  ...extra,
});

/** The exact sentence tests/bess/test_state_of_safety.py pins on the Python side. */
const DISCLOSURE_15 =
  'State of safety is a trend and margin indicator computed from 15 minute ' +
  'cloud telemetry. It is not a protection system and must not be relied on ' +
  'for emergency response. Your BMS and fire detection system are.';

describe('bandForScore', () => {
  it('uses the same floors as nuravolt.bess.thermal_monitor.SAFETY_BANDS', () => {
    expect(bandForScore(100)).toBe('LOW');
    expect(bandForScore(80)).toBe('LOW');
    expect(bandForScore(79)).toBe('MODERATE');
    expect(bandForScore(60)).toBe('MODERATE');
    expect(bandForScore(59)).toBe('HIGH');
    expect(bandForScore(40)).toBe('HIGH');
    expect(bandForScore(39)).toBe('CRITICAL');
  });

  it('does not mistake a measured zero for missing data', () => {
    expect(bandForScore(0)).toBe('CRITICAL');
    expect(bandForScore(null)).toBe('UNKNOWN');
    expect(bandForScore(undefined)).toBe('UNKNOWN');
  });

  it('renders CRITICAL and HIGH on the alarm tone, never a reassuring one', () => {
    expect(bandTone('CRITICAL')).toBe('alarm');
    expect(bandTone('HIGH')).toBe('alarm');
    expect(bandTone('MODERATE')).toBe('warn');
    expect(bandTone('LOW')).toBe('ok');
    expect(bandTone('UNKNOWN')).toBe('muted');
  });
});

describe('worstOf', () => {
  it('lets one critical sub index drive the composite past three healthy ones', () => {
    const w = worstOf([
      sub('thermal_margin', 12),
      sub('imbalance', 98),
      sub('dwell_exposure', 100),
      sub('protection_status', 100),
    ]);

    // A weighted sum of these four would land near 78, a comfortable MODERATE.
    expect(w.score).toBe(12);
    expect(w.band).toBe('CRITICAL');
    expect(w.limitingIndex).toBe('thermal_margin');
  });

  it('excludes an unavailable sub index instead of scoring it 100', () => {
    const w = worstOf([
      sub('thermal_margin', 45),
      sub('imbalance', null, { available: false, reason: SUB_ASSET_UNAVAILABLE }),
      sub('protection_status', null, { available: false, reason: 'No HVAC channel' }),
    ]);

    expect(w.score).toBe(45);
    expect(w.band).toBe('HIGH');
    expect(w.limitingIndex).toBe('thermal_margin');
    expect(w.scored).toHaveLength(1);
    expect(w.unavailable.map((s) => s.name)).toEqual(['imbalance', 'protection_status']);
  });

  it('returns no composite at all when nothing had data', () => {
    const w = worstOf([
      sub('imbalance', null, { available: false }),
      sub('protection_status', null, { available: false }),
    ]);

    expect(w.score).toBeNull();
    expect(w.band).toBe('UNKNOWN');
    expect(w.limitingIndex).toBeNull();
  });

  it('keeps a measured zero as the answer rather than dropping it', () => {
    const w = worstOf([sub('protection_status', 0), sub('thermal_margin', 90)]);
    expect(w.score).toBe(0);
    expect(w.band).toBe('CRITICAL');
    expect(w.limitingIndex).toBe('protection_status');
  });
});

describe('unavailableMessage', () => {
  it('prefers the publisher reason', () => {
    expect(
      unavailableMessage(sub('thermal_margin', null, { available: false, reason: 'No temperature channel on this asset' })),
    ).toBe('No temperature channel on this asset');
  });

  it('falls back to the canonical rack wording for a sub asset index', () => {
    expect(unavailableMessage({ name: 'imbalance', available: false })).toBe(
      'Requires rack level telemetry, connect your BMS to enable',
    );
  });

  it('never invents an explanation for an unknown index', () => {
    expect(unavailableMessage({ name: 'dwell_exposure', available: false })).toBe(
      'No input channel connected for this sub index',
    );
  });
});

describe('safetyDisclosure', () => {
  it('matches the Python wording word for word', () => {
    expect(safetyDisclosure(15)).toBe(DISCLOSURE_15);
  });

  it('says periodic rather than naming a cadence it cannot evidence', () => {
    expect(safetyDisclosure(null)).toContain('from periodic cloud telemetry');
    expect(safetyDisclosure(0)).toContain('from periodic cloud telemetry');
    expect(safetyDisclosure(undefined)).toContain('from periodic cloud telemetry');
  });
});

describe('subIndexLabel', () => {
  it('renders sentence case, not shouting', () => {
    expect(subIndexLabel('thermal_margin')).toBe('Thermal margin');
    expect(subIndexLabel('protection_status')).toBe('Protection status');
  });
});

describe('resolveReading', () => {
  const payload: SafetyArtifactPayload = {
    interval_minutes: 15,
    readings: [
      { asset_id: 'a1', device_id: 'BESS athi-1', score: 71, limiting_index: 'dwell_exposure' },
      { asset_id: 'a1', device_id: 'BESS athi-1.U-1.R-1', score: 34, limiting_index: 'imbalance' },
      { asset_id: 'a2', device_id: 'BESS kilima-1', score: 12, limiting_index: 'thermal_margin' },
    ],
  };

  it('headlines the asset grain row when the publisher wrote one', () => {
    const r = resolveReading(payload, { assetId: 'a1' });
    expect(r?.basis).toBe('asset');
    expect(r?.reading.device_id).toBe('BESS athi-1');
    expect(r?.deviceCount).toBe(2);
  });

  it('falls back to the worst device, and says so, when there is no asset row', () => {
    const r = resolveReading(
      {
        readings: [
          { asset_id: 'a1', device_id: 'BESS athi-1.U-1.R-1', score: 88 },
          { asset_id: 'a1', device_id: 'BESS athi-1.U-1.R-2', score: 41 },
        ],
      },
      { assetId: 'a1' },
    );
    expect(r?.basis).toBe('worst-of-devices');
    expect(r?.reading.device_id).toBe('BESS athi-1.U-1.R-2');
  });

  it('matches on the asset token when the reading carries no asset id', () => {
    const r = resolveReading(
      { readings: [{ device_id: 'BESS athi-1.U-1.R-3', score: 55 }] },
      { assetId: 'a9', assetToken: 'athi-1' },
    );
    expect(r?.reading.device_id).toBe('BESS athi-1.U-1.R-3');
  });

  it('returns nothing for an asset with no published rows', () => {
    expect(resolveReading(payload, { assetId: 'a3' })).toBeNull();
    expect(resolveReading(null, { assetId: 'a1' })).toBeNull();
  });
});

describe('safetyView', () => {
  it('derives the headline from the published breakdown so the two cannot disagree', () => {
    const payload: SafetyArtifactPayload = {
      interval_minutes: 15,
      readings: [
        {
          asset_id: 'a1',
          device_id: 'BESS athi-1',
          // A stale composite from an earlier publish. The breakdown wins.
          score: 91,
          limiting_index: 'dwell_exposure',
          sub_indices: [
            sub('thermal_margin', 18),
            sub('imbalance', null, { available: false, reason: SUB_ASSET_UNAVAILABLE }),
            sub('dwell_exposure', 96),
            sub('protection_status', 100),
          ],
        },
      ],
    };

    const view = safetyView(resolveReading(payload, { assetId: 'a1' }), payload)!;
    expect(view.derived).toBe(true);
    expect(view.score).toBe(18);
    expect(view.band).toBe('CRITICAL');
    expect(view.limitingIndex).toBe('thermal_margin');
    expect(view.scoredCount).toBe(3);
    expect(view.unavailable.map((s) => s.name)).toEqual(['imbalance']);
    expect(view.disclosure).toBe(DISCLOSURE_15);
  });

  it('orders the sub indices the way the pipeline lists them', () => {
    const payload: SafetyArtifactPayload = {
      readings: [
        {
          asset_id: 'a1',
          device_id: 'BESS athi-1',
          sub_indices: [
            sub('protection_status', 100),
            sub('dwell_exposure', 90),
            sub('thermal_margin', 80),
            sub('imbalance', 70),
          ],
        },
      ],
    };
    const view = safetyView(resolveReading(payload, { assetId: 'a1' }), payload)!;
    expect(view.subIndices.map((s) => s.name)).toEqual([
      'thermal_margin',
      'imbalance',
      'dwell_exposure',
      'protection_status',
    ]);
  });

  it('uses the published score only when no breakdown was sent', () => {
    const payload: SafetyArtifactPayload = {
      interval_minutes: 15,
      disclosure: DISCLOSURE_15,
      readings: [
        {
          asset_id: 'a1',
          device_id: 'BESS athi-1',
          score: 47,
          band: 'HIGH',
          limiting_index: 'imbalance',
          unavailable: ['protection_status'],
        },
      ],
    };
    const view = safetyView(resolveReading(payload, { assetId: 'a1' }), payload)!;
    expect(view.derived).toBe(false);
    expect(view.score).toBe(47);
    expect(view.band).toBe('HIGH');
    expect(view.unavailable.map((s) => s.name)).toEqual(['protection_status']);
  });

  it('reports no composite when every sub index is unavailable', () => {
    const payload: SafetyArtifactPayload = {
      readings: [
        {
          asset_id: 'a1',
          device_id: 'BESS athi-1',
          sub_indices: [
            sub('thermal_margin', null, { available: false, reason: 'No temperature channel on this asset' }),
            sub('imbalance', null, { available: false, reason: SUB_ASSET_UNAVAILABLE }),
          ],
        },
      ],
    };
    const view = safetyView(resolveReading(payload, { assetId: 'a1' }), payload)!;
    expect(view.score).toBeNull();
    expect(view.band).toBe('UNKNOWN');
    expect(view.scoredCount).toBe(0);
    // The disclosure is never dropped, even with nothing to score.
    expect(view.disclosure).toContain('It is not a protection system');
  });
});

describe('isSafetyPayload', () => {
  it('accepts a published artifact', () => {
    expect(isSafetyPayload({ readings: [] })).toBe(true);
  });

  it('rejects an error body, so a missing route reads as not published', () => {
    expect(isSafetyPayload({ error: 'invalid_file', allowed: ['optimizer', 'dossier'] })).toBe(false);
    expect(isSafetyPayload(null)).toBe(false);
    expect(isSafetyPayload('nope')).toBe(false);
  });
});
