import type {
  DigitalTwinDataPoint,
  OptimizationResponse,
  CostBenefitResult,
} from '@/types/soiling';
import { scoreSchedule, type WhatIfParams, type WhatIfScore } from './whatif';
import type { RainForecastDay } from './rainForecast';

/**
 * TypeScript port of the Python quick-mode cleaning-schedule search.
 *
 * Why this exists: the Python optimizer needs a persistent process (job
 * registry + spawned interpreter), which Vercel serverless does not provide —
 * on prod the job registry evaporates between requests and the run never
 * completes. Scoring already lived in TS (`whatif.ts` — the tab re-scored
 * every Python candidate client-side anyway), so the search runs wherever the
 * caller is: in the browser for the optimizer tab (instant, no jobs) and
 * in-process for the Shams chat tool. The Python engine remains the offline
 * artifact generator (operator_proposal.json).
 *
 * Candidate generation mirrors nuravolt/soiling/schedule_optimizer.py:
 * seasonal base grid, SR-threshold crossings (3 days early), SR local minima,
 * plus real rain avoidance for the first 16 days when a forecast is supplied
 * (a wash right before heavy rain is money spent on what the sky was about to
 * do for free).
 */

export interface OptimizeScheduleOptions {
  plantId: string;
  forecast: DigitalTwinDataPoint[];
  params: WhatIfParams;
  minCleanings?: number;
  maxCleanings?: number;
  maxScenariosPerCount?: number;
  rainForecast?: RainForecastDay[] | null;
  /** Heavy-rain threshold for candidate avoidance (mm/day). */
  rainThresholdMm?: number;
}

const SR_THRESHOLD = 0.97;
const RAIN_LOOKAHEAD_DAYS = 5;

/** Deterministic RNG (mulberry32) so identical inputs give identical plans. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCandidateIndices(
  forecast: DigitalTwinDataPoint[],
  rainForecast: RainForecastDay[] | null | undefined,
  rainThresholdMm: number,
): number[] {
  const n = forecast.length;
  if (n < 30) return [];
  const first = 14;
  const last = n - 15;
  const candidates = new Set<number>();

  // 1. Seasonal base grid: weekly May-Sept, biweekly otherwise (mirrors the
  //    Python prioritize_summer behaviour).
  let i = first;
  while (i <= last) {
    candidates.add(i);
    const month = Number(forecast[i].date.slice(5, 7));
    i += month >= 5 && month <= 9 ? 7 : 14;
  }

  // 2. Threshold crossings: candidate 3 days before SR first dips below 0.97.
  for (let idx = 3; idx < n; idx++) {
    const cur = forecast[idx].sr_predicted;
    const prev = forecast[idx - 1].sr_predicted;
    if (cur < SR_THRESHOLD && prev >= SR_THRESHOLD) {
      const c = idx - 3;
      if (c >= first && c <= last) candidates.add(c);
    }
  }

  // 3. Local minima of the predicted SR (largest recovery jump).
  for (let idx = Math.max(first, 3); idx <= Math.min(last, n - 4); idx++) {
    const v = forecast[idx].sr_predicted;
    if (
      v < forecast[idx - 3].sr_predicted &&
      v < forecast[idx + 3].sr_predicted &&
      v < SR_THRESHOLD
    ) {
      candidates.add(idx);
    }
  }

  // 4. Rain avoidance (real forecast horizon only): drop candidates with
  //    heavy rain forecast within the following days.
  if (rainForecast?.length) {
    const rainByDate = new Map(rainForecast.map((r) => [r.date, r.precipitation_mm]));
    for (const idx of [...candidates]) {
      const date = forecast[idx].date;
      if (!rainByDate.has(date) && !rainByDate.has(forecast[idx + 1]?.date)) continue;
      let upcoming = 0;
      for (let d = 0; d <= RAIN_LOOKAHEAD_DAYS; d++) {
        upcoming = Math.max(upcoming, rainByDate.get(forecast[idx + d]?.date) ?? 0);
      }
      if (upcoming >= rainThresholdMm) candidates.delete(idx);
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function combinationsCount(n: number, k: number): number {
  if (k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
    if (result > 1e15) return 1e15;
  }
  return Math.round(result);
}

function* lexCombinations(pool: number[], k: number): Generator<number[]> {
  const n = pool.length;
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => pool[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function spacingOk(combo: number[], minDays: number): boolean {
  for (let i = 1; i < combo.length; i++) {
    if (combo[i] - combo[i - 1] < minDays) return false;
  }
  return true;
}

function toResult(score: WhatIfScore, windowDays: number): CostBenefitResult {
  const paybackDays =
    score.revenueEUR > 0 ? score.costEUR / (score.revenueEUR / windowDays) : windowDays;
  return {
    dates: score.dates,
    n_cleanings: score.nCleanings,
    energy_recovered_MWh: round2(score.energyRecoveredMWh),
    revenue_recovered_EUR: round2(score.revenueEUR),
    cleaning_cost_EUR: round2(score.costEUR),
    net_benefit_EUR: round2(score.netEUR),
    roi_pct: round2(score.roiPct),
    payback_days: round1(paybackDays),
    avg_sr: round4(score.avgSrWith),
    avg_loss_pct: round2((1 - score.avgSrWith) * 100),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function optimizeSchedule(opts: OptimizeScheduleOptions): OptimizationResponse {
  const started = Date.now();
  const {
    forecast,
    params,
    minCleanings = 1,
    maxCleanings = 6,
    maxScenariosPerCount = 400,
    rainForecast,
    rainThresholdMm = 5,
  } = opts;
  const warnings: string[] = [];

  const candidateIdx = generateCandidateIndices(forecast, rainForecast, rainThresholdMm);
  if (!candidateIdx.length) {
    throw new Error('Forecast too short to generate cleaning candidates');
  }

  const minDays = Math.max(1, params.minDaysBetween);
  const rng = mulberry32(0xc1ea41);
  const bestPerCount = new Map<number, { score: WhatIfScore; result: CostBenefitResult }>();
  const windowDays = Math.max(1, forecast.length);

  for (let k = Math.max(1, minCleanings); k <= Math.min(maxCleanings, 12); k++) {
    const combos: number[][] = [];
    if (k === 1) {
      for (const c of candidateIdx) combos.push([c]);
    } else if (combinationsCount(candidateIdx.length, k) <= maxScenariosPerCount * 5) {
      for (const combo of lexCombinations(candidateIdx, k)) {
        if (spacingOk(combo, minDays)) {
          combos.push(combo);
          if (combos.length >= maxScenariosPerCount) break;
        }
      }
    } else {
      // Seeded uniform sampling with dedupe; avoids lexicographic bias.
      const seen = new Set<string>();
      let attempts = 0;
      while (combos.length < maxScenariosPerCount && attempts < maxScenariosPerCount * 30) {
        attempts++;
        const pick = new Set<number>();
        while (pick.size < k) {
          pick.add(candidateIdx[Math.floor(rng() * candidateIdx.length)]);
        }
        const combo = [...pick].sort((a, b) => a - b);
        if (!spacingOk(combo, minDays)) continue;
        const key = combo.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        combos.push(combo);
      }
    }

    let best: WhatIfScore | null = null;
    for (const combo of combos) {
      const dates = combo.map((i) => forecast[i].date);
      const score = scoreSchedule(forecast, dates, params);
      if (!best || score.netEUR > best.netEUR) best = score;
    }
    if (best) bestPerCount.set(k, { score: best, result: toResult(best, windowDays) });
  }

  if (!bestPerCount.size) {
    throw new Error('No valid cleaning scenarios found (spacing constraint too tight?)');
  }

  const ranked = [...bestPerCount.values()].sort(
    (a, b) => b.result.net_benefit_EUR - a.result.net_benefit_EUR,
  );
  const optimal = ranked[0].result;
  if (optimal.net_benefit_EUR <= 0) {
    warnings.push(
      'Best scenario has a non-positive net benefit at these prices; cleaning may not pay for itself.',
    );
  }

  return {
    plant_id: opts.plantId,
    parameters: {
      capacity_MW: params.capacityMW,
      electricity_rate_per_MWh: params.electricityRatePerMWh,
      cleaning_cost_per_MW: params.cleaningCostPerMW,
      min_days_between_cleanings: params.minDaysBetween,
    } as OptimizationResponse['parameters'],
    optimal_schedule: optimal,
    alternatives: ranked.slice(1).map((r) => r.result),
    comparison_table: [...bestPerCount.entries()]
      .sort(([a], [b]) => a - b)
      .map(([k, v]) => ({
        n_cleanings: k,
        best_dates: v.result.dates,
        net_benefit_EUR: v.result.net_benefit_EUR,
        roi_pct: v.result.roi_pct,
      })),
    execution_time_ms: Date.now() - started,
    rain_aware: Boolean(rainForecast?.length),
    warnings,
  };
}
