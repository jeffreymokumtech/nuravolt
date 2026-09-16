import type { Contract, ContractTerm, Plant, PlantAlert } from '@prisma/client';
import prisma from '@/libs/prisma';
import { queryAnalysisResults } from '@/lib/db/timeseries';
import { buildBessDeviceId, sanitizeBessAssetToken } from '@/lib/services/cloud-connector';
import { slaMetrics, SLA_TERM_MAP, type SlaTicket } from './sla';

/**
 * Contract-obligation evaluation, called from /api/cron/evaluate-alerts
 * after the threshold alerts. For every ACTIVE contract's monitored terms it
 * computes an honest status from data the platform actually has:
 *
 *   availability / PR guarantees   trailing-30d Σactual/Σpredicted from the
 *                                  digital twin's daily aggregate (energy
 *                                  proxy, labeled as such)
 *   module degradation             PR trend: first-90-measured-days baseline
 *                                  vs last-90 window across the available
 *                                  history vs the warranted annual decline.
 *                                  Indicative only — not an IEC measurement.
 *   O&M SLA response/resolution    p90 over trailing-90d tickets per priority
 *   BESS warranty                  read-through of BessWarrantyStatus + open
 *                                  violations (the guardian's own numbers)
 *   BESS availability              energy-weighted availability published to
 *   (tolling / CM / ancillary)     analysis_results by the availability job,
 *                                  with the unavailability split by category
 *   BESS cycle cap + RTE floor     BessCycleRecord sums over the window
 *
 * Results land in one AnalysisArtifact per plant (kind='contract_obligations')
 * so the Contracts tab renders from a single read. Breaches open PlantAlert
 * rows (kind=CONTRACT_OBLIGATION, dedup_key='<contract>:<field>'); an
 * obligation must return to 'ok' (not just 'at_risk') to resolve — the
 * at_risk band is the hysteresis.
 */

export type ObligationStatus = 'ok' | 'at_risk' | 'breach' | 'unmonitored' | 'no_data';

export interface ObligationReading {
  contract_id: string;
  contract_type: string;
  field: string;
  status: ObligationStatus;
  observed_value: number | null;
  threshold: number | null;
  unit: string | null;
  window: string | null;
  detail: string;
}

const FLAP_GUARD_HOURS = 24;
const AVAILABILITY_AT_RISK_PP = 1.0;
const SLA_AT_RISK_FRACTION = 0.8;
const DEGRADATION_MARGIN_PP = 1.0;

/**
 * Our own tolerance for telemetry noise and rounding when comparing delivered
 * capability against declared capability. It is a platform convention, not a
 * contractual term: no tolling agreement grants a 1% derate for free.
 */
const DERATE_TOLERANCE_FRACTION = 0.01;

const BESS_AVAILABILITY_WINDOW_DAYS = 30;
const BESS_AVAILABILITY_MIN_DAYS = 24;
const CAPACITY_MARKET_WINDOW_DAYS = 365;
const CAPACITY_MARKET_MIN_DAYS = 30;
const CYCLE_WINDOW_DAYS = 365;
const CYCLE_MIN_RECORD_DAYS = 60;
const CYCLE_CAP_AT_RISK_FRACTION = 0.8;
const RTE_WINDOW_DAYS = 90;
const RTE_MIN_RECORD_DAYS = 14;
const RTE_AT_RISK_PP = 1.0;

/** Contract types whose availability comes from the BESS lane, not the PV twin. */
const BESS_AVAILABILITY_CONTRACT_TYPES = new Set<string>([
  'BESS_TOLLING',
  'BESS_CAPACITY_MARKET',
  'BESS_ANCILLARY',
]);

// ---------------------------------------------------------------------------
// Pure readings (exported for tests)
// ---------------------------------------------------------------------------

export function availabilityReading(opts: {
  prPct: number | null;
  measuredDays: number;
  thresholdPct: number;
}): { status: ObligationStatus; detail: string } {
  const { prPct, measuredDays, thresholdPct } = opts;
  if (prPct == null || measuredDays < 24) {
    return {
      status: 'no_data',
      detail: `Not enough measured days in the last 30 (${measuredDays}/24 needed) to assess the ${thresholdPct}% guarantee`,
    };
  }
  const status: ObligationStatus =
    prPct < thresholdPct ? 'breach' : prPct < thresholdPct + AVAILABILITY_AT_RISK_PP ? 'at_risk' : 'ok';
  return {
    status,
    detail: `30-day energy delivery at ${prPct.toFixed(1)}% of twin expectation vs the ${thresholdPct}% guarantee (energy proxy, not contractual availability metering)`,
  };
}

export function degradationReading(opts: {
  baselinePr: number | null;
  currentPr: number | null;
  baselineDays: number;
  currentDays: number;
  spanYears: number;
  annualDegradationPct: number;
}): { status: ObligationStatus; observedDeclinePct: number | null; allowedDeclinePct: number | null; detail: string } {
  const { baselinePr, currentPr, baselineDays, currentDays, spanYears, annualDegradationPct } = opts;
  if (
    baselinePr == null ||
    currentPr == null ||
    baselinePr <= 0 ||
    baselineDays < 60 ||
    currentDays < 60 ||
    spanYears < 0.5
  ) {
    return {
      status: 'no_data',
      observedDeclinePct: null,
      allowedDeclinePct: null,
      detail: 'Not enough performance history to compare against the warranted degradation curve (needs two 90-day windows at least 6 months apart)',
    };
  }
  const observed = ((baselinePr - currentPr) / baselinePr) * 100;
  const allowed = annualDegradationPct * spanYears;
  const status: ObligationStatus =
    observed > allowed + DEGRADATION_MARGIN_PP ? 'breach' : observed > allowed ? 'at_risk' : 'ok';
  return {
    status,
    observedDeclinePct: Math.round(observed * 100) / 100,
    allowedDeclinePct: Math.round(allowed * 100) / 100,
    detail: `Performance declined ${observed.toFixed(1)}% over ${spanYears.toFixed(1)} years vs ${allowed.toFixed(1)}% warranted (indicative PR-trend comparison, not an IEC warranty measurement)`,
  };
}

export function slaReading(opts: {
  p90Hours: number | null;
  count: number;
  termHours: number;
  label: string;
}): { status: ObligationStatus; detail: string } {
  const { p90Hours, count, termHours, label } = opts;
  if (p90Hours == null || count < 3) {
    return {
      status: 'no_data',
      detail: `Fewer than 3 ${label} tickets in the last 90 days, so the SLA is not assessable this window`,
    };
  }
  const status: ObligationStatus =
    p90Hours > termHours ? 'breach' : p90Hours > termHours * SLA_AT_RISK_FRACTION ? 'at_risk' : 'ok';
  return {
    status,
    detail: `p90 ${label} time ${p90Hours.toFixed(1)}h across ${count} tickets (90 days) vs ${termHours}h agreed`,
  };
}

// ---------------------------------------------------------------------------
// BESS availability: the definition, and what the definition cannot see
// ---------------------------------------------------------------------------

/**
 * A settlement period counts as available when all of these hold:
 *   telemetry is present for the period,
 *   the run state says grid-connected,
 *   no blocking alarm is active,
 *   and the asset could have delivered its DECLARED derated capability, which
 *   means both enough power (racks online) and enough energy (state of charge
 *   headroom to hold that power for the declared duration).
 *
 * Anything else is unavailable, and the category says which limb failed. A
 * headline "97% available" with no breakdown is useless in a dispute, so the
 * breakdown is a first-class output, not a debug extra.
 */
export type UnavailabilityCategory =
  | 'no_telemetry'
  | 'offline'
  | 'derated'
  | 'soc_unable'
  | 'operator_curtailed';

export const UNAVAILABILITY_CATEGORIES: UnavailabilityCategory[] = [
  'no_telemetry',
  'offline',
  'derated',
  'soc_unable',
  'operator_curtailed',
];

const CATEGORY_LABELS: Record<UnavailabilityCategory, string> = {
  no_telemetry: 'no telemetry',
  offline: 'offline',
  derated: 'derated',
  soc_unable: 'state of charge unable',
  operator_curtailed: 'operator declared curtailment (excluded)',
};

/**
 * Canonical metric names for the availability results in `analysis_results`
 * (domain 'bess'). One convention, defined once: the job that computes
 * availability publishes exactly these names and this evaluator reads exactly
 * these names.
 */
export const BESS_AVAILABILITY_METRICS = {
  energyWeighted: 'energy_weighted_availability_pct',
  periodCount: 'availability_pct',
  unavailability: {
    no_telemetry: 'unavailability_pct_no_telemetry',
    offline: 'unavailability_pct_offline',
    derated: 'unavailability_pct_derated',
    soc_unable: 'unavailability_pct_soc_unable',
    operator_curtailed: 'unavailability_pct_operator_curtailed',
  } as Record<UnavailabilityCategory, string>,
} as const;

export interface AvailabilityPeriodSample {
  /** Period start, ISO. Carried for traceability only. */
  period_start?: string;
  /** false when the poller produced no sample covering this period. */
  telemetry_present: boolean;
  /** Run state reported by the PCS/BMS says grid-connected. */
  grid_connected: boolean;
  /** An active alarm that blocks dispatch (safety trip, PCS fault). */
  blocking_alarm: boolean;
  /** MW the asset could have delivered, from racks online. null reads as zero. */
  deliverable_mw: number | null;
  /** Energy above the discharge floor at period start, MWh. null skips the SoC limb. */
  usable_energy_mwh: number | null;
  /** MW the contract declares for this period. */
  declared_mw: number;
  /** Hours the declared MW must be sustainable for. */
  declared_duration_h: number;
  /**
   * Customer-declared curtailment or planned outage. Excluded from both the
   * numerator and the denominator, because the counterparty asked for it. This
   * is operator input, not a measurement, and it is reported separately so a
   * generous exclusion is visible rather than buried in the headline.
   */
  operator_curtailed?: boolean;
}

export interface AvailabilityPeriodVerdict {
  available: boolean;
  category: UnavailabilityCategory | null;
  /** MW credited to this period, capped at the declared MW. */
  effective_mw: number;
}

export function classifyAvailabilityPeriod(
  sample: AvailabilityPeriodSample,
  opts: { derateToleranceFraction?: number } = {},
): AvailabilityPeriodVerdict {
  const tolerance = opts.derateToleranceFraction ?? DERATE_TOLERANCE_FRACTION;
  const declared = Math.max(0, sample.declared_mw);

  // Exclusion first: a declared curtailment removes the period from the
  // measurement entirely, so nothing about the asset's own state applies.
  if (sample.operator_curtailed) {
    return { available: false, category: 'operator_curtailed', effective_mw: 0 };
  }
  if (!sample.telemetry_present) {
    return { available: false, category: 'no_telemetry', effective_mw: 0 };
  }
  if (!sample.grid_connected || sample.blocking_alarm) {
    return { available: false, category: 'offline', effective_mw: 0 };
  }

  const powerMw = sample.deliverable_mw == null ? 0 : Math.max(0, sample.deliverable_mw);
  const socMw =
    sample.usable_energy_mwh == null || sample.declared_duration_h <= 0
      ? null
      : Math.max(0, sample.usable_energy_mwh) / sample.declared_duration_h;
  const capable = socMw == null ? powerMw : Math.min(powerMw, socMw);
  const effective = Math.min(declared, capable);
  const floor = declared * (1 - tolerance);

  if (effective >= floor) return { available: true, category: null, effective_mw: effective };
  // Both limbs can bind at once. The power shortfall is reported first because
  // racks offline is the harder constraint: charging fixes state of charge,
  // nothing on the operator's side fixes a rack that is out.
  const category: UnavailabilityCategory = powerMw < floor ? 'derated' : 'soc_unable';
  return { available: false, category, effective_mw: effective };
}

export interface AvailabilitySummary {
  total_periods: number;
  /** Operator-declared exclusions, removed from the measurement. */
  excluded_periods: number;
  counted_periods: number;
  available_periods: number;
  /** available periods / counted periods */
  availability_pct: number | null;
  /** Σ available MW.h / Σ declared MW.h */
  energy_weighted_availability_pct: number | null;
  declared_mwh: number;
  available_mwh: number;
  unavailable_periods_by_category: Record<UnavailabilityCategory, number>;
  /**
   * MW.h shortfall per category. The `operator_curtailed` entry is EXCLUDED
   * energy, not lost energy: it never reduces either published metric.
   */
  shortfall_mwh_by_category: Record<UnavailabilityCategory, number>;
  period_minutes: number;
}

const zeroByCategory = (): Record<UnavailabilityCategory, number> => ({
  no_telemetry: 0,
  offline: 0,
  derated: 0,
  soc_unable: 0,
  operator_curtailed: 0,
});

/**
 * Both metrics from one pass.
 *
 * The energy-weighted figure is the one tolling and capacity market contracts
 * actually care about. A 50% derate lasting a full day and a full outage
 * lasting half a day are the same lost energy but a completely different period
 * count, and period-counting cannot tell them apart: the first shows 0%
 * availability for every one of its periods only if you count a derate as a
 * total loss, and 100% if you do not. Energy weighting removes the choice.
 *
 * `periodMinutes` only scales the absolute MW.h figures. Both ratios are
 * invariant to it as long as every period is the same length.
 */
export function summarizeAvailability(
  periods: AvailabilityPeriodSample[],
  opts: { periodMinutes?: number; derateToleranceFraction?: number } = {},
): AvailabilitySummary {
  const periodMinutes = opts.periodMinutes ?? 30;
  const dtHours = periodMinutes / 60;

  const unavailablePeriods = zeroByCategory();
  const shortfallMwh = zeroByCategory();
  let excluded = 0;
  let counted = 0;
  let available = 0;
  let declaredMwh = 0;
  let availableMwh = 0;

  for (const sample of periods) {
    const declared = Math.max(0, sample.declared_mw);
    const verdict = classifyAvailabilityPeriod(sample, opts);

    if (verdict.category === 'operator_curtailed') {
      excluded += 1;
      unavailablePeriods.operator_curtailed += 1;
      shortfallMwh.operator_curtailed += declared * dtHours;
      continue;
    }

    counted += 1;
    declaredMwh += declared * dtHours;
    availableMwh += verdict.effective_mw * dtHours;
    if (verdict.available) {
      available += 1;
    } else if (verdict.category) {
      unavailablePeriods[verdict.category] += 1;
      shortfallMwh[verdict.category] += Math.max(0, declared - verdict.effective_mw) * dtHours;
    }
  }

  return {
    total_periods: periods.length,
    excluded_periods: excluded,
    counted_periods: counted,
    available_periods: available,
    availability_pct: counted ? (available / counted) * 100 : null,
    energy_weighted_availability_pct: declaredMwh > 0 ? (availableMwh / declaredMwh) * 100 : null,
    declared_mwh: declaredMwh,
    available_mwh: availableMwh,
    unavailable_periods_by_category: unavailablePeriods,
    shortfall_mwh_by_category: shortfallMwh,
    period_minutes: periodMinutes,
  };
}

/**
 * Summary to `analysis_results` rows (domain 'bess'). The availability job
 * imports this instead of re-deriving metric names, so there is exactly one
 * naming convention on both sides of the table.
 */
export function availabilityMetricRows(
  summary: AvailabilitySummary,
): { metric: string; value: number }[] {
  const rows: { metric: string; value: number }[] = [];
  if (summary.energy_weighted_availability_pct != null) {
    rows.push({
      metric: BESS_AVAILABILITY_METRICS.energyWeighted,
      value: summary.energy_weighted_availability_pct,
    });
  }
  if (summary.availability_pct != null) {
    rows.push({ metric: BESS_AVAILABILITY_METRICS.periodCount, value: summary.availability_pct });
  }
  if (summary.declared_mwh > 0) {
    for (const category of UNAVAILABILITY_CATEGORIES) {
      rows.push({
        metric: BESS_AVAILABILITY_METRICS.unavailability[category],
        value: (summary.shortfall_mwh_by_category[category] / summary.declared_mwh) * 100,
      });
    }
  }
  return rows;
}

/**
 * The resolution disclaimer that every availability figure carries. At 15
 * minute polling there are one or two samples inside a half-hour settlement
 * period, so a five minute outage never appears at all.
 */
export function availabilitySamplingCaveat(sampleIntervalMinutes: number | null): string {
  if (sampleIntervalMinutes == null || !Number.isFinite(sampleIntervalMinutes)) {
    return 'Sampled availability at the ingest polling interval, not a settlement-grade measurement: the interval was not recorded with these results, so the shortest outage that would show up here is unknown.';
  }
  const minutes = Math.round(sampleIntervalMinutes);
  return `Sampled availability at ${minutes}-minute resolution, not a settlement-grade measurement: an outage shorter than ${minutes} minutes between samples never appears here.`;
}

function unavailabilityBreakdownText(
  byCategoryPp: Partial<Record<UnavailabilityCategory, number>> | null | undefined,
): string {
  if (!byCategoryPp) return '';
  const parts = UNAVAILABILITY_CATEGORIES.map((category) => ({
    category,
    pp: byCategoryPp[category] ?? 0,
  }))
    .filter((p) => Number.isFinite(p.pp) && p.pp >= 0.05)
    .sort((a, b) => b.pp - a.pp)
    .map((p) => `${CATEGORY_LABELS[p.category]} ${p.pp.toFixed(1)}pp`);
  return parts.length ? ` Unavailability by category: ${parts.join(', ')}.` : '';
}

function deviceScopeText(deviceCount: number): string {
  return deviceCount > 1 ? ` Averaged across ${deviceCount} BESS devices on this plant.` : '';
}

export function bessAvailabilityReading(opts: {
  observedPct: number | null;
  measuredDays: number;
  thresholdPct: number;
  sampleIntervalMinutes: number | null;
  basis: 'tolling' | 'ancillary';
  byCategoryPp?: Partial<Record<UnavailabilityCategory, number>> | null;
  deviceCount?: number;
}): { status: ObligationStatus; detail: string } {
  const { observedPct, measuredDays, thresholdPct, basis } = opts;
  const caveat = availabilitySamplingCaveat(opts.sampleIntervalMinutes);

  if (observedPct == null || measuredDays < BESS_AVAILABILITY_MIN_DAYS) {
    return {
      status: 'no_data',
      detail: `Only ${measuredDays} of the ${BESS_AVAILABILITY_MIN_DAYS} days needed carry availability results, so the ${thresholdPct}% commitment is not assessable this window. ${caveat}`,
    };
  }

  const status: ObligationStatus =
    observedPct < thresholdPct
      ? 'breach'
      : observedPct < thresholdPct + AVAILABILITY_AT_RISK_PP
        ? 'at_risk'
        : 'ok';
  const breakdown = unavailabilityBreakdownText(opts.byCategoryPp);
  const devices = deviceScopeText(opts.deviceCount ?? 1);

  if (basis === 'ancillary') {
    return {
      status,
      detail: `Availability to respond ${observedPct.toFixed(1)}% over ${measuredDays} days vs the ${thresholdPct}% commitment.${breakdown}${devices} Response delivery is not verified here: that needs 1-second data and OEM clouds sample at 5 to 15 minutes. The system operator settles against your own balancing mechanism and EDL or EDT submissions, which this platform does not receive. ${caveat}`,
    };
  }
  return {
    status,
    detail: `Energy-weighted availability ${observedPct.toFixed(1)}% over ${measuredDays} days vs the ${thresholdPct}% guarantee.${breakdown}${devices} ${caveat}`,
  };
}

/**
 * Capacity market satisfactory performance days.
 *
 * Never returns 'breach', by design. Satisfactory performance is determined by
 * the capacity market settlement body from a formal test regime and settlement
 * metering this platform does not receive. The most we can honestly offer is
 * the operator's own indicative count, which is worth having before an auction
 * or a test window and worth nothing as evidence.
 */
export function satisfactoryPerformanceReading(opts: {
  observedDays: number | null;
  windowDays: number;
  requiredDays: number;
  sampleIntervalMinutes: number | null;
}): { status: ObligationStatus; detail: string } {
  const { observedDays, windowDays, requiredDays } = opts;
  const caveat = availabilitySamplingCaveat(opts.sampleIntervalMinutes);
  const indicative =
    'Indicative only: satisfactory performance is determined by the capacity market settlement body from test and metering submissions this platform does not receive, so this is never a certification.';

  if (observedDays == null || windowDays < CAPACITY_MARKET_MIN_DAYS) {
    return {
      status: 'no_data',
      detail: `Only ${windowDays} days of availability results in the delivery window, below the ${CAPACITY_MARKET_MIN_DAYS} needed for an indicative view of the ${requiredDays} required days. ${indicative} ${caveat}`,
    };
  }
  return {
    status: observedDays >= requiredDays ? 'ok' : 'at_risk',
    detail: `${observedDays} of ${windowDays} days with results showed no shortfall against the declared derated capacity, against ${requiredDays} satisfactory performance days in the agreement. ${indicative} ${caveat}`,
  };
}

function cycleProvenanceText(modelledFraction: number): string {
  if (!(modelledFraction > 0)) return '';
  if (modelledFraction >= 0.999) {
    return ' These cycle records are dispatch model output, not metered throughput.';
  }
  return ` ${Math.round(modelledFraction * 100)}% of these cycle records are dispatch model output, not metered throughput.`;
}

export function annualCycleCapReading(opts: {
  efcUsed: number | null;
  recordDays: number;
  windowDays: number;
  capPerYear: number;
  modelledFraction: number;
}): { status: ObligationStatus; detail: string } {
  const { efcUsed, recordDays, windowDays, capPerYear } = opts;
  if (efcUsed == null || capPerYear <= 0) {
    return {
      status: 'no_data',
      detail: `No cycle records in the last ${windowDays} days to compare against the ${capPerYear} cycles per year cap`,
    };
  }
  const usagePct = (efcUsed / capPerYear) * 100;
  const provenance = cycleProvenanceText(opts.modelledFraction);
  const detail = `${efcUsed.toFixed(0)} equivalent full cycles in the last ${windowDays} days against the ${capPerYear} cycles per year cap (${usagePct.toFixed(0)}%), from ${recordDays} days of cycle records.${provenance}`;

  // An exceeded cap is exceeded whatever the record count says, so the
  // data-sufficiency gate only guards the reassuring verdicts.
  if (usagePct >= 100) return { status: 'breach', detail };
  if (recordDays < CYCLE_MIN_RECORD_DAYS) {
    return {
      status: 'no_data',
      detail: `${detail} Fewer than ${CYCLE_MIN_RECORD_DAYS} days of records, so the remaining headroom is not assessable.`,
    };
  }
  return { status: usagePct >= CYCLE_CAP_AT_RISK_FRACTION * 100 ? 'at_risk' : 'ok', detail };
}

export function rteFloorReading(opts: {
  rtePct: number | null;
  recordDays: number;
  windowDays: number;
  floorPct: number;
  modelledFraction: number;
}): { status: ObligationStatus; detail: string } {
  const { rtePct, recordDays, windowDays, floorPct } = opts;
  if (rtePct == null || recordDays < RTE_MIN_RECORD_DAYS) {
    return {
      status: 'no_data',
      detail: `Only ${recordDays} days of cycle records in the last ${windowDays}, below the ${RTE_MIN_RECORD_DAYS} needed to assess the ${floorPct}% round-trip efficiency floor`,
    };
  }
  const status: ObligationStatus =
    rtePct < floorPct ? 'breach' : rtePct < floorPct + RTE_AT_RISK_PP ? 'at_risk' : 'ok';
  return {
    status,
    detail: `Round-trip efficiency ${rtePct.toFixed(1)}% across ${recordDays} days of cycle records (${windowDays}-day window) vs the ${floorPct}% floor.${cycleProvenanceText(opts.modelledFraction)}`,
  };
}

// ---------------------------------------------------------------------------
// Data loads
// ---------------------------------------------------------------------------

interface DailyPr {
  day: string;
  ratio: number; // actual / predicted
}

async function loadDailyPr(plantUuid: string): Promise<DailyPr[]> {
  const from = new Date(Date.now() - 730 * 86_400_000);
  const rows = (await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'digitaltwin',
    deviceId: 'PLANT',
    metrics: ['power_ac_predicted', 'power_ac_actual'],
    from,
    resolution: 'daily',
    limit: 3000,
  })) as { bucket: Date; metric: string; avg_value: number; sample_count: number }[];

  const byDay = new Map<string, { pred?: number; act?: number }>();
  for (const r of rows) {
    const day = new Date(r.bucket).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? {};
    const energy = Number(r.avg_value) * Number(r.sample_count ?? 1);
    if (r.metric === 'power_ac_predicted') entry.pred = (entry.pred ?? 0) + energy;
    if (r.metric === 'power_ac_actual') entry.act = (entry.act ?? 0) + energy;
    byDay.set(day, entry);
  }
  return Array.from(byDay.entries())
    .filter(([, e]) => e.pred != null && e.act != null && e.pred > 0)
    .map(([day, e]) => ({ day, ratio: e.act! / e.pred! }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function trailing30Pr(daily: DailyPr[]): { prPct: number | null; measuredDays: number } {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const window = daily.filter((d) => d.day >= cutoff);
  const m = mean(window.map((d) => d.ratio));
  return { prPct: m == null ? null : m * 100, measuredDays: window.length };
}

function degradationWindows(daily: DailyPr[]): {
  baselinePr: number | null;
  currentPr: number | null;
  baselineDays: number;
  currentDays: number;
  spanYears: number;
} {
  const baseline = daily.slice(0, 90);
  const current = daily.slice(-90);
  const midpoint = (w: DailyPr[]) =>
    w.length ? new Date(w[Math.floor(w.length / 2)].day).getTime() : null;
  const m0 = midpoint(baseline);
  const m1 = midpoint(current);
  const spanYears = m0 != null && m1 != null ? (m1 - m0) / (365.25 * 86_400_000) : 0;
  const b = mean(baseline.map((d) => d.ratio));
  const c = mean(current.map((d) => d.ratio));
  return {
    baselinePr: b == null ? null : b * 100,
    currentPr: c == null ? null : c * 100,
    baselineDays: baseline.length,
    currentDays: current.length,
    spanYears,
  };
}

// --- BESS availability results (written by the availability job) ------------

type DayMetrics = Map<string, Record<string, number>>;

interface BessAvailabilityLoad {
  byDevice: Map<string, DayMetrics>;
  sampleIntervalMinutes: number | null;
}

interface BessAvailabilitySeries {
  /** ISO day to energy-weighted availability percent. */
  energyWeightedByDay: Map<string, number>;
  /** Window mean of each unavailability category, in percentage points. */
  byCategoryPp: Partial<Record<UnavailabilityCategory, number>>;
  deviceCount: number;
}

const AVAILABILITY_METRIC_NAMES = [
  BESS_AVAILABILITY_METRICS.energyWeighted,
  BESS_AVAILABILITY_METRICS.periodCount,
  ...UNAVAILABILITY_CATEGORIES.map((c) => BESS_AVAILABILITY_METRICS.unavailability[c]),
];

/**
 * Raw (not daily-rolled) rows, because the daily continuous aggregate drops
 * `metadata` and that is where the sampling interval rides. Several rows for
 * the same day and metric are averaged.
 */
async function loadBessAvailability(
  plantUuid: string,
  windowDays: number,
): Promise<BessAvailabilityLoad> {
  const rows = (await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'bess',
    metrics: AVAILABILITY_METRIC_NAMES,
    from: new Date(Date.now() - windowDays * 86_400_000),
    limit: 20_000,
  })) as { time: Date; device_id: string | null; metric: string; value: number; metadata: any }[];

  const sums = new Map<string, Map<string, Record<string, { sum: number; n: number }>>>();
  let sampleIntervalMinutes: number | null = null;

  for (const row of rows) {
    if (sampleIntervalMinutes == null) {
      const raw =
        row.metadata?.sample_interval_minutes ?? row.metadata?.resolution_minutes ?? null;
      const parsed = raw == null ? NaN : Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) sampleIntervalMinutes = parsed;
    }
    const device = row.device_id ?? 'PLANT';
    const day = new Date(row.time).toISOString().slice(0, 10);
    if (!sums.has(device)) sums.set(device, new Map());
    const byDay = sums.get(device)!;
    if (!byDay.has(day)) byDay.set(day, {});
    const metrics = byDay.get(day)!;
    const cell = metrics[row.metric] ?? { sum: 0, n: 0 };
    cell.sum += Number(row.value);
    cell.n += 1;
    metrics[row.metric] = cell;
  }

  const byDevice = new Map<string, DayMetrics>();
  for (const [device, byDay] of Array.from(sums.entries())) {
    const out: DayMetrics = new Map();
    for (const [day, metrics] of Array.from(byDay.entries())) {
      const averaged: Record<string, number> = {};
      for (const [metric, cell] of Object.entries(metrics)) {
        averaged[metric] = cell.sum / cell.n;
      }
      out.set(day, averaged);
    }
    byDevice.set(device, out);
  }
  return { byDevice, sampleIntervalMinutes };
}

/**
 * Canonical BESS device ids this asset could be publishing under. The vendor
 * connectors build the asset token from the device name, so both the name and
 * the external id are tried before falling back to plant-wide aggregation.
 */
function bessDeviceCandidates(
  asset: { name: string | null; external_asset_id: string } | null | undefined,
): string[] {
  if (!asset) return [];
  const out: string[] = [];
  for (const raw of [asset.name, asset.external_asset_id]) {
    if (!raw) continue;
    try {
      const token = sanitizeBessAssetToken(String(raw));
      if (token) out.push(buildBessDeviceId({ asset: token }));
    } catch {
      // Unusable token (reserved word, empty). Plant-wide aggregation stands.
    }
  }
  return out;
}

function selectBessSeries(
  load: BessAvailabilityLoad | null,
  preferredDeviceIds: string[],
): BessAvailabilitySeries {
  const empty: BessAvailabilitySeries = {
    energyWeightedByDay: new Map(),
    byCategoryPp: {},
    deviceCount: 0,
  };
  if (!load || !load.byDevice.size) return empty;

  const match = preferredDeviceIds.find((id) => load.byDevice.has(id));
  const devices = match ? [match] : Array.from(load.byDevice.keys());

  // Averaging across devices is only defensible when they share a declared
  // capability, so the reading says how many devices were folded together.
  const acc = new Map<string, Record<string, { sum: number; n: number }>>();
  for (const device of devices) {
    for (const [day, metrics] of Array.from(load.byDevice.get(device)!.entries())) {
      if (!acc.has(day)) acc.set(day, {});
      const cell = acc.get(day)!;
      for (const [metric, value] of Object.entries(metrics)) {
        const c = cell[metric] ?? { sum: 0, n: 0 };
        c.sum += value;
        c.n += 1;
        cell[metric] = c;
      }
    }
  }

  const energyWeightedByDay = new Map<string, number>();
  const categoryTotals = new Map<UnavailabilityCategory, { sum: number; n: number }>();
  for (const [day, metrics] of Array.from(acc.entries())) {
    const ew = metrics[BESS_AVAILABILITY_METRICS.energyWeighted];
    if (ew && ew.n > 0) energyWeightedByDay.set(day, ew.sum / ew.n);
    for (const category of UNAVAILABILITY_CATEGORIES) {
      const cell = metrics[BESS_AVAILABILITY_METRICS.unavailability[category]];
      if (!cell || cell.n === 0) continue;
      const t = categoryTotals.get(category) ?? { sum: 0, n: 0 };
      t.sum += cell.sum / cell.n;
      t.n += 1;
      categoryTotals.set(category, t);
    }
  }

  const byCategoryPp: Partial<Record<UnavailabilityCategory, number>> = {};
  for (const [category, t] of Array.from(categoryTotals.entries())) {
    if (t.n > 0) byCategoryPp[category] = t.sum / t.n;
  }
  return { energyWeightedByDay, byCategoryPp, deviceCount: devices.length };
}

/** Days with no recorded shortfall against the declared derated capability. */
function daysWithoutShortfall(series: BessAvailabilitySeries): number {
  const floorPct = (1 - DERATE_TOLERANCE_FRACTION) * 100;
  let n = 0;
  for (const value of Array.from(series.energyWeightedByDay.values())) {
    if (value >= floorPct) n += 1;
  }
  return n;
}

// --- BESS cycle records -----------------------------------------------------

interface BessCycleWindow {
  /** Equivalent full cycles summed over CYCLE_WINDOW_DAYS. */
  efc: number | null;
  cycleRecordDays: number;
  cycleModelledFraction: number;
  /** Energy-weighted round-trip efficiency over RTE_WINDOW_DAYS, percent. */
  rtePct: number | null;
  rteRecordDays: number;
  rteModelledFraction: number;
}

async function loadBessCycleWindow(assetId: string): Promise<BessCycleWindow> {
  const rows = await prisma.bessCycleRecord.findMany({
    where: {
      asset_id: assetId,
      cycle_date: { gte: new Date(Date.now() - CYCLE_WINDOW_DAYS * 86_400_000) },
    },
    select: {
      cycle_date: true,
      equivalent_cycles: true,
      energy_in_kwh: true,
      energy_out_kwh: true,
      provenance: true,
    },
  });
  if (!rows.length) {
    return {
      efc: null,
      cycleRecordDays: 0,
      cycleModelledFraction: 0,
      rtePct: null,
      rteRecordDays: 0,
      rteModelledFraction: 0,
    };
  }

  const rteCutoff = new Date(Date.now() - RTE_WINDOW_DAYS * 86_400_000);
  let efc = 0;
  let cycleModelled = 0;
  let energyIn = 0;
  let energyOut = 0;
  let rteDays = 0;
  let rteModelled = 0;

  for (const row of rows) {
    efc += Number(row.equivalent_cycles);
    if (row.provenance !== 'measured') cycleModelled += 1;
    if (new Date(row.cycle_date) >= rteCutoff) {
      energyIn += Number(row.energy_in_kwh);
      energyOut += Number(row.energy_out_kwh);
      rteDays += 1;
      if (row.provenance !== 'measured') rteModelled += 1;
    }
  }

  return {
    efc,
    cycleRecordDays: rows.length,
    cycleModelledFraction: cycleModelled / rows.length,
    rtePct: energyIn > 0 ? (energyOut / energyIn) * 100 : null,
    rteRecordDays: rteDays,
    rteModelledFraction: rteDays ? rteModelled / rteDays : 0,
  };
}

// ---------------------------------------------------------------------------
// Per-contract evaluation
// ---------------------------------------------------------------------------

type ContractWithTerms = Contract & { terms: ContractTerm[] };

function confirmedMonitored(c: ContractWithTerms): ContractTerm[] {
  return c.terms.filter((t) => t.status === 'CONFIRMED' && t.monitored && t.value_numeric != null);
}

function confirmedValue(c: ContractWithTerms, field: string): number | null {
  const t = c.terms.find((x) => x.field === field && x.status === 'CONFIRMED');
  return t?.value_numeric == null ? null : Number(t.value_numeric);
}

interface EvaluationContext {
  daily: DailyPr[] | null;
  tickets: SlaTicket[] | null;
  bessAvailability: BessAvailabilityLoad | null;
  bessAssets: Map<string, { name: string | null; external_asset_id: string }>;
  bessCycles: Map<string, BessCycleWindow>;
}

async function evaluateContract(
  plant: Plant,
  contract: ContractWithTerms,
  ctx: EvaluationContext,
): Promise<ObligationReading[]> {
  const monitored = confirmedMonitored(contract);
  const base = {
    contract_id: contract.id,
    contract_type: contract.contract_type as string,
  };

  if (!monitored.length) {
    return [
      {
        ...base,
        field: '_contract',
        status: 'unmonitored',
        observed_value: null,
        threshold: null,
        unit: null,
        window: null,
        detail: 'Terms on file, with no live-monitorable obligations for this contract type yet',
      },
    ];
  }

  const readings: ObligationReading[] = [];
  const isBessAvailabilityContract = BESS_AVAILABILITY_CONTRACT_TYPES.has(
    contract.contract_type as string,
  );
  const bessSeries = isBessAvailabilityContract
    ? selectBessSeries(
        ctx.bessAvailability,
        bessDeviceCandidates(contract.bess_asset_id ? ctx.bessAssets.get(contract.bess_asset_id) : null),
      )
    : null;
  const cycles = contract.bess_asset_id ? (ctx.bessCycles.get(contract.bess_asset_id) ?? null) : null;

  for (const term of monitored) {
    const threshold = Number(term.value_numeric);

    // BESS availability: tolling and ancillary commitments read the
    // energy-weighted figure, never the PV twin's energy proxy. Same field name
    // as the O&M SLA guarantee, different measurement entirely, so the routing
    // is by contract type.
    if (
      bessSeries &&
      (term.field === 'guaranteed_availability_pct' || term.field === 'response_availability_pct')
    ) {
      const days = Array.from(bessSeries.energyWeightedByDay.values());
      const observed = mean(days);
      const r = bessAvailabilityReading({
        observedPct: observed,
        measuredDays: days.length,
        thresholdPct: threshold,
        sampleIntervalMinutes: ctx.bessAvailability?.sampleIntervalMinutes ?? null,
        basis: contract.contract_type === 'BESS_ANCILLARY' ? 'ancillary' : 'tolling',
        byCategoryPp: bessSeries.byCategoryPp,
        deviceCount: bessSeries.deviceCount,
      });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: observed == null ? null : Math.round(observed * 100) / 100,
        threshold,
        unit: '%',
        window: `${BESS_AVAILABILITY_WINDOW_DAYS}d energy weighted`,
        detail: r.detail,
      });
      continue;
    }

    // Capacity market satisfactory performance: indicative, never certified.
    if (bessSeries && term.field === 'satisfactory_performance_days') {
      const windowDays = bessSeries.energyWeightedByDay.size;
      const observedDays = windowDays ? daysWithoutShortfall(bessSeries) : null;
      const r = satisfactoryPerformanceReading({
        observedDays,
        windowDays,
        requiredDays: threshold,
        sampleIntervalMinutes: ctx.bessAvailability?.sampleIntervalMinutes ?? null,
      });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: observedDays,
        threshold,
        unit: 'days',
        window: `${CAPACITY_MARKET_WINDOW_DAYS}d indicative`,
        detail: r.detail,
      });
      continue;
    }

    // Annual cycle cap from the asset's own cycle records.
    if (term.field === 'max_cycles_per_year' && contract.bess_asset_id) {
      const r = annualCycleCapReading({
        efcUsed: cycles?.efc ?? null,
        recordDays: cycles?.cycleRecordDays ?? 0,
        windowDays: CYCLE_WINDOW_DAYS,
        capPerYear: threshold,
        modelledFraction: cycles?.cycleModelledFraction ?? 0,
      });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: cycles?.efc == null ? null : Math.round(cycles.efc),
        threshold,
        unit: 'cycles',
        window: `${CYCLE_WINDOW_DAYS}d`,
        detail: r.detail,
      });
      continue;
    }

    // Round-trip efficiency floor from measured energy in and out.
    if (term.field === 'min_rte_pct' && contract.bess_asset_id) {
      const r = rteFloorReading({
        rtePct: cycles?.rtePct ?? null,
        recordDays: cycles?.rteRecordDays ?? 0,
        windowDays: RTE_WINDOW_DAYS,
        floorPct: threshold,
        modelledFraction: cycles?.rteModelledFraction ?? 0,
      });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: cycles?.rtePct == null ? null : Math.round(cycles.rtePct * 100) / 100,
        threshold,
        unit: '%',
        window: `${RTE_WINDOW_DAYS}d`,
        detail: r.detail,
      });
      continue;
    }

    // Availability / PR guarantees (PPA + O&M SLA share the shape).
    if (term.field === 'availability_guarantee_pct' || term.field === 'guaranteed_availability_pct') {
      const { prPct, measuredDays } = ctx.daily ? trailing30Pr(ctx.daily) : { prPct: null, measuredDays: 0 };
      const r = availabilityReading({ prPct, measuredDays, thresholdPct: threshold });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: prPct == null ? null : Math.round(prPct * 100) / 100,
        threshold,
        unit: '%',
        window: '30d',
        detail: r.detail,
      });
      continue;
    }

    // Module degradation trend (evaluated once, on the annual-degradation term).
    if (term.field === 'annual_degradation_pct') {
      const w = ctx.daily
        ? degradationWindows(ctx.daily)
        : { baselinePr: null, currentPr: null, baselineDays: 0, currentDays: 0, spanYears: 0 };
      const r = degradationReading({ ...w, annualDegradationPct: threshold });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: r.observedDeclinePct,
        threshold: r.allowedDeclinePct,
        unit: '%',
        window: `${Math.round(w.spanYears * 10) / 10}y trend`,
        detail: r.detail,
      });
      continue;
    }
    if (term.field === 'initial_capacity_pct' || term.field === 'year1_degradation_pct') {
      // Folded into the annual-degradation trend reading — no separate row.
      continue;
    }

    // O&M SLA response/resolution percentiles.
    const slaMap = SLA_TERM_MAP[term.field];
    if (slaMap && ctx.tickets) {
      const metrics = slaMetrics(ctx.tickets);
      const bucket = metrics[slaMap.metric][slaMap.priority] ?? { p90Hours: null, count: 0 };
      const label = `${slaMap.priority.toLowerCase()}-priority ${slaMap.metric}`;
      const r = slaReading({ ...bucket, termHours: threshold, label });
      readings.push({
        ...base,
        field: term.field,
        status: r.status,
        observed_value: bucket.p90Hours == null ? null : Math.round(bucket.p90Hours * 10) / 10,
        threshold,
        unit: 'h',
        window: '90d p90',
        detail: r.detail,
      });
      continue;
    }

    // BESS warranty read-through from the guardian's own tables.
    if (contract.contract_type === 'BESS_WARRANTY' && contract.bess_asset_id) {
      if (term.field === 'soh_eol_threshold_pct' || term.field === 'cycle_count_warranty') {
        const [latest, openViolations] = await Promise.all([
          prisma.bessWarrantyStatus.findFirst({
            where: { asset_id: contract.bess_asset_id },
            orderBy: { snapshot_date: 'desc' },
          }),
          prisma.bessWarrantyViolation.count({
            where: { asset_id: contract.bess_asset_id, resolved_at: null },
          }),
        ]);
        if (!latest) {
          readings.push({
            ...base,
            field: term.field,
            status: 'no_data',
            observed_value: null,
            threshold,
            unit: term.field === 'soh_eol_threshold_pct' ? '%' : 'cycles',
            window: null,
            detail: 'No warranty telemetry snapshots recorded for this asset yet',
          });
          continue;
        }
        if (term.field === 'soh_eol_threshold_pct') {
          const sohPct = Number(latest.current_soh) * 100;
          const risk = latest.risk_level;
          const status: ObligationStatus =
            sohPct <= threshold || risk === 'CRITICAL'
              ? 'breach'
              : risk === 'HIGH' || risk === 'MEDIUM' || openViolations > 0
                ? 'at_risk'
                : 'ok';
          readings.push({
            ...base,
            field: term.field,
            status,
            observed_value: Math.round(sohPct * 100) / 100,
            threshold,
            unit: '%',
            window: 'latest snapshot',
            detail: `SoH ${sohPct.toFixed(1)}% vs ${threshold}% capacity floor · warranty risk ${risk}${openViolations ? ` · ${openViolations} open violation(s)` : ''}`,
          });
        } else {
          const used = Number(latest.equivalent_full_cycles);
          const usagePct = threshold > 0 ? (used / threshold) * 100 : 0;
          const status: ObligationStatus = usagePct >= 100 ? 'breach' : usagePct >= 80 ? 'at_risk' : 'ok';
          readings.push({
            ...base,
            field: term.field,
            status,
            observed_value: Math.round(used),
            threshold,
            unit: 'cycles',
            window: 'cumulative',
            detail: `${Math.round(used).toLocaleString()} equivalent full cycles used of the ${threshold.toLocaleString()}-cycle budget (${usagePct.toFixed(0)}%)`,
          });
        }
        continue;
      }
    }

    // Monitored flag on a field the evaluator has no data source for.
    readings.push({
      ...base,
      field: term.field,
      status: 'unmonitored',
      observed_value: null,
      threshold,
      unit: term.unit,
      window: null,
      detail: 'Term on file, with no live data source wired for this obligation yet',
    });
  }

  return readings;
}

// ---------------------------------------------------------------------------
// Alert state machine (dedup_key = contract:field)
// ---------------------------------------------------------------------------

async function applyObligationAlert(
  plant: Plant,
  orgClerkId: string,
  r: ObligationReading,
  dryRun: boolean,
): Promise<{ opened?: PlantAlert; resolved?: boolean }> {
  const dedupKey = `${r.contract_id}:${r.field}`;
  const active = await prisma.plantAlert.findFirst({
    where: { plant_id: plant.id, kind: 'CONTRACT_OBLIGATION', dedup_key: dedupKey, status: 'ACTIVE' },
  });

  if (r.status === 'breach') {
    if (active) {
      if (!dryRun) {
        await prisma.plantAlert.update({
          where: { id: active.id },
          data: { metric_value: r.observed_value ?? 0, last_seen_at: new Date(), message: r.detail },
        });
      }
      return {};
    }
    const recentResolved = await prisma.plantAlert.findFirst({
      where: {
        plant_id: plant.id,
        kind: 'CONTRACT_OBLIGATION',
        dedup_key: dedupKey,
        status: 'RESOLVED',
        resolved_at: { gte: new Date(Date.now() - FLAP_GUARD_HOURS * 3_600_000) },
      },
      orderBy: { resolved_at: 'desc' },
    });
    if (recentResolved) {
      if (!dryRun) {
        await prisma.plantAlert.update({
          where: { id: recentResolved.id },
          data: {
            status: 'ACTIVE',
            resolved_at: null,
            metric_value: r.observed_value ?? 0,
            last_seen_at: new Date(),
          },
        });
      }
      return {};
    }
    if (dryRun) return { opened: { id: 'dry-run' } as PlantAlert };
    const opened = await prisma.plantAlert.create({
      data: {
        org_clerk_id: orgClerkId,
        plant_id: plant.id,
        kind: 'CONTRACT_OBLIGATION',
        severity: 'WARNING',
        dedup_key: dedupKey,
        metric_value: r.observed_value ?? 0,
        threshold: r.threshold ?? 0,
        message: r.detail,
        context: { contract_id: r.contract_id, field: r.field, contract_type: r.contract_type },
      },
    });
    return { opened };
  }

  // Only a clean 'ok' resolves; 'at_risk' keeps the alert active (hysteresis),
  // and no_data/unmonitored leave state untouched (absence of evidence).
  if (active && r.status === 'ok') {
    if (!dryRun) {
      await prisma.plantAlert.update({
        where: { id: active.id },
        data: { status: 'RESOLVED', resolved_at: new Date(), metric_value: r.observed_value ?? 0 },
      });
    }
    return { resolved: true };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ContractEvaluation {
  plantId: string;
  slug: string;
  obligations: ObligationReading[];
  opened: number;
  resolved: number;
}

export async function evaluatePlantContracts(
  plant: Plant,
  orgClerkId: string,
  dryRun = false,
): Promise<ContractEvaluation | null> {
  const contracts = (await prisma.contract.findMany({
    where: { plant_id: plant.id, status: 'ACTIVE' },
    include: { terms: true },
  })) as ContractWithTerms[];
  if (!contracts.length) return null;

  // Shared data loads, fetched once and only when a contract needs them.
  const isBessAvailability = (c: ContractWithTerms) =>
    BESS_AVAILABILITY_CONTRACT_TYPES.has(c.contract_type as string);

  const needsPr = contracts.some(
    (c) =>
      !isBessAvailability(c) &&
      confirmedMonitored(c).some((t) =>
        ['availability_guarantee_pct', 'guaranteed_availability_pct', 'annual_degradation_pct'].includes(t.field),
      ),
  );
  const needsTickets = contracts.some((c) => confirmedMonitored(c).some((t) => SLA_TERM_MAP[t.field]));

  const bessAvailabilityContracts = contracts.filter(
    (c) =>
      isBessAvailability(c) &&
      confirmedMonitored(c).some((t) =>
        ['guaranteed_availability_pct', 'response_availability_pct', 'satisfactory_performance_days'].includes(
          t.field,
        ),
      ),
  );
  // A capacity market agreement needs the full delivery-year view; tolling and
  // ancillary settle monthly, so 30 days is the useful window.
  const availabilityWindowDays = bessAvailabilityContracts.some(
    (c) => c.contract_type === 'BESS_CAPACITY_MARKET',
  )
    ? CAPACITY_MARKET_WINDOW_DAYS
    : BESS_AVAILABILITY_WINDOW_DAYS;

  const cycleAssetIds = Array.from(
    new Set(
      contracts
        .filter((c) =>
          confirmedMonitored(c).some((t) => t.field === 'max_cycles_per_year' || t.field === 'min_rte_pct'),
        )
        .map((c) => c.bess_asset_id)
        .filter((id): id is string => !!id),
    ),
  );

  const dailyPromise: Promise<DailyPr[] | null> = needsPr
    ? loadDailyPr(plant.id).catch((): DailyPr[] | null => null)
    : Promise.resolve(null);
  const ticketPromise: Promise<SlaTicket[] | null> = needsTickets
    ? prisma.ticket.findMany({
        where: { plant_id: plant.id, created_at: { gte: new Date(Date.now() - 90 * 86_400_000) } },
        select: { created_at: true, assigned_at: true, closed_at: true, priority: true },
      })
    : Promise.resolve(null);
  const availabilityPromise: Promise<BessAvailabilityLoad | null> = bessAvailabilityContracts.length
    ? loadBessAvailability(plant.id, availabilityWindowDays).catch((): BessAvailabilityLoad | null => null)
    : Promise.resolve(null);
  const assetPromise: Promise<{ id: string; name: string | null; external_asset_id: string }[]> =
    bessAvailabilityContracts.length
      ? prisma.bessAsset.findMany({
          where: { plant_id: plant.id },
          select: { id: true, name: true, external_asset_id: true },
        })
      : Promise.resolve([]);
  const cyclePromise: Promise<(BessCycleWindow | null)[]> = Promise.all(
    cycleAssetIds.map((id) => loadBessCycleWindow(id).catch((): BessCycleWindow | null => null)),
  );

  const [daily, ticketRows, bessAvailability, bessAssetRows, cycleWindows] = await Promise.all([
    dailyPromise,
    ticketPromise,
    availabilityPromise,
    assetPromise,
    cyclePromise,
  ]);

  const bessAssets = new Map(
    bessAssetRows.map((a) => [a.id, { name: a.name, external_asset_id: a.external_asset_id }]),
  );
  const bessCycles = new Map<string, BessCycleWindow>();
  cycleAssetIds.forEach((id, i) => {
    const w = cycleWindows[i];
    if (w) bessCycles.set(id, w);
  });

  const obligations: ObligationReading[] = [];
  for (const contract of contracts) {
    obligations.push(
      ...(await evaluateContract(plant, contract, {
        daily,
        tickets: ticketRows,
        bessAvailability,
        bessAssets,
        bessCycles,
      })),
    );
  }

  let opened = 0;
  let resolved = 0;
  for (const r of obligations) {
    if (r.field === '_contract') continue;
    const outcome = await applyObligationAlert(plant, orgClerkId, r, dryRun);
    if (outcome.opened) opened++;
    if (outcome.resolved) resolved++;
  }

  // Obligations that vanished (contract archived, term un-monitored) must not
  // leave zombie alerts behind.
  const liveKeys = new Set(obligations.map((r) => `${r.contract_id}:${r.field}`));
  const stale = await prisma.plantAlert.findMany({
    where: { plant_id: plant.id, kind: 'CONTRACT_OBLIGATION', status: 'ACTIVE' },
  });
  for (const alert of stale) {
    if (alert.dedup_key && !liveKeys.has(alert.dedup_key)) {
      if (!dryRun) {
        await prisma.plantAlert.update({
          where: { id: alert.id },
          data: { status: 'RESOLVED', resolved_at: new Date() },
        });
      }
      resolved++;
    }
  }

  if (!dryRun) {
    await prisma.analysisArtifact.upsert({
      where: { plant_id_kind: { plant_id: plant.id, kind: 'contract_obligations' } },
      create: {
        plant_id: plant.id,
        kind: 'contract_obligations',
        payload: { evaluated_at: new Date().toISOString(), obligations } as object,
        source: 'computed',
        model_version: 'contract-evaluator-v1',
      },
      update: {
        payload: { evaluated_at: new Date().toISOString(), obligations } as object,
        source: 'computed',
        model_version: 'contract-evaluator-v1',
      },
    });
  }

  return { plantId: plant.id, slug: plant.slug, obligations, opened, resolved };
}
