import type {
  Cause,
  Classification,
  RecommendedAction,
  Signals,
} from './types';
import { NORMAL_FALLBACK } from './types';

/**
 * Deterministic decision tree for inverter maintenance classification.
 *
 * Reads the fused `Signals` bundle gathered upstream and emits a single
 * `Classification`. Branches are ordered by safety urgency (fire risk first,
 * then thermal, then performance-only causes) — the first matching branch
 * wins, the rest are ignored.
 *
 * Confidence is the sum of weights for evidence items that were actually
 * measured (never for missing signals), hard-capped at MAX_CONFIDENCE — a
 * rule engine without labelled ground truth doesn't claim certainty.
 *
 * Degradation vs soiling separation rests on the voltage signature:
 * soiling cuts current (and therefore power) roughly uniformly while the
 * DC operating voltage stays on-twin; string/module degradation shifts the
 * voltage operating point. `voltageDevPct` is peer-relative, so the twin's
 * systematic bias cancels out.
 */

const MAX_CONFIDENCE = 0.9;
/** Peer-relative voltage deviation beyond this (in % of V_dc) = degradation signature. */
const VOLTAGE_DEGRADATION_PCT = 2.0;
/** Below this the inverter counts as voltage-neutral (soiling-compatible). */
const VOLTAGE_NEUTRAL_PCT = 1.0;

export function classify(s: Signals): Classification {
  const evidence: string[] = [];
  let confidence = 0;
  let cause: Cause = 'NORMAL';
  let action: RecommendedAction = 'MONITOR';
  let etaDays: number | null = null;
  let projectedKwh: number | null = null;
  let ruleId = 'normal-default';

  const baseSnapshot: Pick<
    Classification,
    'inverterId' | 'plantId' | 'group' | 'tier' | 'pds' | 'generatedAt'
  > = {
    inverterId: s.inverterId,
    plantId: s.plantId,
    group: s.group,
    tier: s.pdsTier,
    pds: Math.round(s.latestPds * 100) / 100,
    generatedAt: new Date().toISOString(),
  };

  const voltageNeutral = Math.abs(s.voltageDevPct) < VOLTAGE_NEUTRAL_PCT;

  // ──────────────────────────────────────────────────────────────────────
  // NORMAL guard — in-line with peers (or only marginally chronic) and the
  // absolute loss is small, with no urgent RUL: short-circuit to NORMAL.
  // Negative loss = producing MORE than the twin predicts (twin bias), which
  // is never actionable, so only the upper bound is checked.
  // ──────────────────────────────────────────────────────────────────────
  const tierBenign =
    s.pdsTier === 'NORMAL' || (s.pdsTier === 'CHRONIC' && s.lossPct < 1);
  if (tierBenign && s.lossPct < 3 && !hasUrgentRul(s)) {
    return {
      ...baseSnapshot,
      ...NORMAL_FALLBACK,
      tier: s.pdsTier,
      ruleId: 'normal',
      evidence: [
        s.pdsTier === 'CHRONIC'
          ? 'Persistently slightly below peers, but loss is negligible'
          : 'PDS tier is NORMAL',
        `trailing loss ${s.lossPct.toFixed(1)}%`,
      ],
      confidence: 0.85,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // BYPASS_DIODE — fire risk, surface even at NORMAL tier when ETA ≤ 14d.
  // ──────────────────────────────────────────────────────────────────────
  const diode = s.rulDays.bypass_diode;
  if (diode && diode.days <= 14) {
    cause = 'BYPASS_DIODE';
    action = 'REPLACEMENT';
    etaDays = diode.days;
    projectedKwh = diode.projectedEnergyLossKwh ?? null;
    confidence = 0.55 + 0.35 * diode.confidence;
    evidence.push(
      `Bypass-diode RUL: ${diode.days} days (model confidence ${(diode.confidence * 100).toFixed(0)}%)`,
      'High hotspot count → fire risk per RUL model',
    );
    if (s.tempDeviation > 6) {
      evidence.push(`Temperature residual ${s.tempDeviation.toFixed(1)} °C above twin`);
      confidence += 0.1;
    }
    ruleId = 'bypass-diode-rul';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // THERMAL — elevated temperature residual + inverter_thermal RUL.
  // ──────────────────────────────────────────────────────────────────────
  const thermal = s.rulDays.inverter_thermal;
  if (s.tempDeviation > 8) {
    cause = 'THERMAL';
    action = 'INSPECTION';
    etaDays = thermal?.days ?? null;
    projectedKwh = thermal?.projectedEnergyLossKwh ?? null;
    confidence = 0.4;
    evidence.push(`Temperature residual ${s.tempDeviation.toFixed(1)} °C above twin`);
    if (thermal) {
      confidence += 0.25;
      evidence.push(
        `Inverter-thermal RUL: ${thermal.days} days (model confidence ${(thermal.confidence * 100).toFixed(0)}%)`,
      );
    }
    if (s.pdsTier === 'ACUTE' || s.pdsTier === 'DEGRADED') {
      confidence += 0.15;
      evidence.push(`Peer-deviation tier ${s.pdsTier} corroborates`);
    }
    ruleId = 'thermal-residual';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // STRING_DEGRADATION — material peer-relative DC-voltage shift together
  // with underperformance. Soiling cannot produce this signature: light
  // loss reduces current at a near-unchanged operating voltage, while a
  // degraded/failed string drags the inverter's DC voltage off its peers.
  // ──────────────────────────────────────────────────────────────────────
  const stringRul = s.rulDays.string_degradation ?? s.rulDays.module_degradation;
  if (Math.abs(s.voltageDevPct) > VOLTAGE_DEGRADATION_PCT && s.pdsTier !== 'NORMAL') {
    cause = 'STRING_DEGRADATION';
    action = 'INSPECTION';
    etaDays = stringRul?.days ?? null;
    projectedKwh = stringRul?.projectedEnergyLossKwh ?? null;
    confidence = 0.45;
    evidence.push(
      `DC voltage ${s.voltageDevPct > 0 ? '+' : ''}${s.voltageDevPct.toFixed(1)}% vs peer group (soiling is voltage-neutral)`,
      `Peer-deviation tier ${s.pdsTier}`,
    );
    if (stringRul) {
      confidence += 0.25;
      evidence.push(
        `Degradation RUL: ${stringRul.days} days (model confidence ${(stringRul.confidence * 100).toFixed(0)}%)`,
      );
    }
    if (s.recentRainStep) {
      // Loss persisted through rain — rules out soiling explicitly.
      confidence += 0.1;
      evidence.push('Underperformance persisted through recent rain (not soiling)');
    }
    ruleId = 'degradation-voltage';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // SHADING — diurnal pattern signal from the multi-signal twin. Dormant
  // until `diurnalPatternPct` is wired up (currently null from both routes).
  // ──────────────────────────────────────────────────────────────────────
  if (
    s.diurnalPatternPct !== null &&
    s.diurnalPatternPct > 2 &&
    voltageNeutral &&
    s.pdsTier !== 'NORMAL'
  ) {
    cause = 'SHADING';
    action = 'INSPECTION';
    etaDays = null; // shading is structural — fix on next site visit
    confidence = 0.65;
    evidence.push(
      `Diurnal pattern ${s.diurnalPatternPct.toFixed(1)}% (morning/evening dip)`,
      `Voltage on-twin (${s.voltageDevPct.toFixed(1)}% vs peers) rules out string fault`,
      `Peer-deviation tier ${s.pdsTier}`,
    );
    ruleId = 'shading-diurnal';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // INVERTER_DERATE — sudden PDS step with no thermal / voltage / soiling
  // signature. Firmware derate, grid-side issue, or a step-change in
  // inverter health. Evaluated BEFORE soiling because a sudden step is
  // mutually exclusive with the gradual soiling pattern.
  // ──────────────────────────────────────────────────────────────────────
  if (
    Math.abs(s.pdsSlope14d) > 1.5 &&
    s.tempDeviation < 5 &&
    voltageNeutral &&
    !s.recentRainStep
  ) {
    cause = 'INVERTER_DERATE';
    action = 'INSPECTION';
    etaDays = null;
    confidence = 0.55;
    evidence.push(
      `Sudden PDS step (slope ${s.pdsSlope14d.toFixed(2)} σ/day in last 14 days)`,
      `No thermal signature (temp residual ${s.tempDeviation.toFixed(1)} °C)`,
      `Voltage on-twin (${s.voltageDevPct.toFixed(1)}% vs peers) rules out string fault`,
    );
    ruleId = 'inverter-derate-step';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // SOILING (peer-deviating) — persistent PDS, gradual drift, voltage-
  // neutral. Light cuts across every panel and MPPT operating point
  // equally, so power drops while voltage stays on-twin.
  // ──────────────────────────────────────────────────────────────────────
  const soiling = s.soilingForecast;
  const expected = soiling?.peakLossPct ?? null;
  if (s.pdsTier !== 'NORMAL' && voltageNeutral) {
    cause = 'SOILING';
    action = 'CLEANING';

    if (soiling) {
      if (soiling.cleaningPriority != null && soiling.cleaningPriority > 0) {
        etaDays = Math.max(0, soiling.cleaningPriority);
      } else if (soiling.peakDate) {
        etaDays = daysUntil(soiling.peakDate);
      }
    }

    evidence.push(
      s.pdsTier === 'CHRONIC'
        ? `PDS > 0.5 on ${s.pdsAbove05d30}/30 days — slow persistent drift below peers`
        : `PDS > 1 on ${s.pdsAbove1d14}/14 of last 14 days`,
      `Voltage on-twin (${s.voltageDevPct.toFixed(1)}% vs peers) — soiling signature`,
    );
    confidence = 0.4;
    if (Math.abs(s.pdsSlope14d) < 0.5) {
      evidence.push(`Drift is gradual (PDS slope ${s.pdsSlope14d.toFixed(2)} σ/day)`);
      confidence += 0.1;
    }
    if (expected !== null && Math.abs(s.lossPct - expected) < 3) {
      confidence += 0.2;
      evidence.push(
        `Soiling forecast aligns: ${expected.toFixed(1)}% predicted vs ${s.lossPct.toFixed(1)}% observed`,
      );
    }
    if (!s.rainForecast7d && !s.recentRainStep) {
      confidence += 0.1;
      evidence.push('No recent rain step, none forecast — loss should persist until cleaned');
    }
    ruleId = 'soiling-persistent';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // SOILING (common-mode) — the whole peer group is down vs its digital
  // twin, so the peer-relative tier reads NORMAL even though every panel
  // is dirty. Peer statistics are structurally blind to this case; the
  // absolute twin residual + group median catch it.
  // ──────────────────────────────────────────────────────────────────────
  if (
    s.pdsTier === 'NORMAL' &&
    s.lossPct >= 3 &&
    s.groupMedianLossPct >= 3 &&
    voltageNeutral &&
    !s.recentRainStep
  ) {
    cause = 'SOILING';
    action = 'CLEANING';
    confidence = 0.35;
    evidence.push(
      `Whole group underperforms its twin (group median −${s.groupMedianLossPct.toFixed(1)}%, this inverter −${s.lossPct.toFixed(1)}%)`,
      'In-line with peers — common-mode loss, not a single-inverter fault',
      `Voltage on-twin (${s.voltageDevPct.toFixed(1)}% vs peers) — soiling signature`,
    );
    if (expected !== null && Math.abs(s.groupMedianLossPct - expected) < 3) {
      confidence += 0.25;
      evidence.push(
        `Soiling forecast aligns: ${expected.toFixed(1)}% predicted vs ${s.groupMedianLossPct.toFixed(1)}% group median`,
      );
    }
    if (!s.rainForecast7d) confidence += 0.05;
    if (soiling) {
      if (soiling.cleaningPriority != null && soiling.cleaningPriority > 0) {
        etaDays = Math.max(0, soiling.cleaningPriority);
      } else if (soiling.peakDate) {
        etaDays = daysUntil(soiling.peakDate);
      }
    }
    ruleId = 'soiling-common-mode';
    return finalize(baseSnapshot, cause, confidence, etaDays, projectedKwh, evidence, action, ruleId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // No rule matched: tier signalled something but the physics doesn't add
  // up cleanly to any specific cause. Fall through to MONITOR with low
  // confidence — the LLM can take it from here.
  // ──────────────────────────────────────────────────────────────────────
  return {
    ...baseSnapshot,
    ...NORMAL_FALLBACK,
    tier: s.pdsTier,
    evidence: [
      `Peer-deviation tier ${s.pdsTier}, no diagnostic rule fired`,
      `loss ${s.lossPct.toFixed(1)}%, temp Δ ${s.tempDeviation.toFixed(1)} °C, voltage Δ ${s.voltageDevPct.toFixed(1)}% vs peers`,
    ],
    confidence: 0.3,
    ruleId: 'fallback',
  };
}

function finalize(
  base: Pick<Classification, 'inverterId' | 'plantId' | 'group' | 'tier' | 'pds' | 'generatedAt'>,
  cause: Cause,
  confidence: number,
  etaDays: number | null,
  projectedKwh: number | null,
  evidence: string[],
  action: RecommendedAction,
  ruleId: string,
): Classification {
  return {
    ...base,
    likelyCause: cause,
    confidence: Math.round(Math.min(MAX_CONFIDENCE, confidence) * 100) / 100,
    etaDays,
    projectedEnergyLossKwhPerDay: projectedKwh,
    evidence,
    recommendedAction: action,
    ruleId,
  };
}

function hasUrgentRul(s: Signals): boolean {
  const d = s.rulDays.bypass_diode;
  if (d && d.days <= 14) return true;
  const t = s.rulDays.inverter_thermal;
  if (t && t.days <= 7) return true;
  return false;
}

function daysUntil(isoDate: string): number {
  const d = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(0, Math.round((d - now) / (24 * 60 * 60 * 1000)));
}
