/**
 * Shared types for the maintenance classifier.
 *
 * The classifier fuses several existing signal streams (peer-deviation score,
 * twin residuals, soiling forecast, fault-detection RUL) into a single
 * deterministic verdict per inverter: what's the most likely cause of the
 * underperformance, how confident are we, when does it need attention, and
 * what kind of intervention.
 *
 * Surfaced both directly (Maintenance Horizon tile / plant page) and as
 * context to the LLM-powered inverter diagnosis.
 */

export type Tier = 'ACUTE' | 'DEGRADED' | 'CHRONIC' | 'NORMAL';

export type Cause =
  | 'SOILING'
  | 'SHADING'
  | 'THERMAL'
  | 'STRING_DEGRADATION'
  | 'BYPASS_DIODE'
  | 'INVERTER_DERATE'
  | 'NORMAL';

export type RecommendedAction =
  | 'CLEANING'
  | 'INSPECTION'
  | 'REPLACEMENT'
  | 'MONITOR';

/**
 * Input bundle the decision tree consumes. All fields are read-only — the
 * upstream API gathers these from the existing data sources in one round
 * trip before calling `classify(signals)`.
 */
export interface Signals {
  inverterId: string;
  plantId: string;
  group: string;

  // Peer deviation score signals from inverter-rank-history.
  pdsTier: Tier;
  latestPds: number;
  /**
   * Slope of PDS over the trailing 14 days, in σ/day. A positive slope means
   * the inverter is drifting away from peers; > 1.5 implies a sudden step.
   */
  pdsSlope14d: number;
  /** Number of days in the last 14 where PDS > 1. Used for soiling evidence. */
  pdsAbove1d14: number;
  /** Number of days in the last 30 where PDS > 0.5 (the CHRONIC criterion). */
  pdsAbove05d30: number;

  // Twin residual / loss signals (rolling 14-day means from analysis_daily).
  lossPct: number;
  /** Median loss% across the inverter's peer group over the same window.
   *  Detects common-mode underperformance (e.g. group-wide soiling) that a
   *  peer-relative PDS is structurally blind to. */
  groupMedianLossPct: number;
  /** Inverter temperature residual: actual − predicted (°C). */
  tempDeviation: number;
  /**
   * Peer-relative DC-voltage deviation in % of operating voltage:
   * (own 14d mean voltage residual − group median residual) / voltage.
   * Soiling is voltage-neutral (light loss cuts current, not voltage), so a
   * material voltage shift points at string/module degradation instead.
   */
  voltageDevPct: number;
  /**
   * Strength of diurnal underperformance — % loss attributable to morning/
   * evening dips. Comes from the multi-signal twin / fleet-fault detector.
   * Optional: when null, the SHADING branch can't fire.
   */
  diurnalPatternPct: number | null;

  // Soiling forecast — peak loss% expected over the next 30 days of the
  // plant's ML forecast (ml_forecast_365d.json), anchored on the analysis
  // window end. Recovery point is the first forecasted date where the
  // soiling loss drops back ≤ 1% (a rain event in the model).
  soilingForecast: {
    peakLossPct: number;
    peakDate: string | null;
    recoveryDate: string | null;
    confidence: number;
    cleaningPriority: number | null;
  } | null;

  // Per-failure-mode RUL predictions from fault_detection_enhanced.json /
  // CatBoost. Missing keys mean "no RUL available for this mode".
  rulDays: Partial<
    Record<
      | 'bypass_diode'
      | 'inverter_thermal'
      | 'string_degradation'
      | 'module_degradation',
      { days: number; confidence: number; projectedEnergyLossKwh?: number }
    >
  >;

  /** Rain expected within the next 7 days (any non-trivial event). */
  rainForecast7d: boolean;
  /**
   * Did rainfall recently knock loss% back? Detector for soiling/no-soiling
   * disambiguation: if a rain step is already in the trailing data, current
   * underperformance is unlikely to be soiling.
   */
  recentRainStep: boolean;
}

export interface Classification {
  inverterId: string;
  plantId: string;
  group: string;
  tier: Tier;
  pds: number;

  likelyCause: Cause;
  /**
   * 0–0.9. Sum of independently-measured evidence weights. Hard-capped at
   * 0.9: a rule engine without labelled ground truth never claims certainty.
   */
  confidence: number;
  /** Days until intervention is recommended. null for SHADING / monitor-only. */
  etaDays: number | null;
  /** Estimated kWh/day at risk if untreated. null when unknown. */
  projectedEnergyLossKwhPerDay: number | null;

  /** Short evidence strings shown verbatim in the UI tile and LLM context. */
  evidence: string[];

  recommendedAction: RecommendedAction;
  /** Stable id of the rule branch that fired. Used in telemetry. */
  ruleId: string;
  generatedAt: string;
}

/** Default to no-cause when classification cannot be computed. */
export const NORMAL_FALLBACK: Omit<
  Classification,
  'inverterId' | 'plantId' | 'group' | 'tier' | 'pds' | 'generatedAt'
> = {
  likelyCause: 'NORMAL',
  confidence: 0.3,
  etaDays: null,
  projectedEnergyLossKwhPerDay: null,
  evidence: ['insufficient signal to classify'],
  recommendedAction: 'MONITOR',
  ruleId: 'fallback',
};
