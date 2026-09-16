/**
 * Forecast-Driven Cleaning Schedule Optimization
 *
 * Smart optimization system that uses:
 * - ML predictions as primary soiling forecast (replaces linear decay)
 * - AOD trends for dust exposure risk scoring
 * - Rain forecasts for deferral logic and natural cleaning
 *
 * Performance target: <500ms for live calculation
 */

import { addDays, parseISO, format } from 'date-fns';
import type {
  CleaningParameters,
  LiveCostBenefitResult,
  DigitalTwinDataPoint,
  AODForecastPoint,
  RainForecastPoint,
  ForecastDrivenParams,
  SRTimelinePoint,
  DustRiskLevel,
} from '@/types/soiling';

// ============================================================
// Core Algorithm Constants
// ============================================================

const CLEANING_RECOVERY_SR = 0.95;       // Clean panels to 95% (5% permanent soiling)
const MIN_SR_FLOOR = 0.80;               // Physical floor for heavily soiled panels
const DECAY_TIME_CONSTANT = 30.0;       // Days to decay toward ML prediction

// AOD adjustment constants
const AOD_SENSITIVITY = 0.20;            // ±20% soiling rate per 0.10 AOD deviation
const AOD_DEVIATION_UNIT = 0.10;         // Base AOD deviation unit
const AOD_ADJUSTMENT_MIN = 0.50;         // Minimum adjustment factor (50%)
const AOD_ADJUSTMENT_MAX = 1.50;         // Maximum adjustment factor (150%)

// Rain deferral constants
const RAIN_LARGE_MM = 5.0;               // Large rain event threshold
const RAIN_MEDIUM_MM = 2.0;              // Medium rain event threshold
const RAIN_LARGE_PROB_THRESHOLD = 60;    // Probability threshold for large rain (cumulative %)
const RAIN_MEDIUM_PROB_THRESHOLD = 40;   // Probability threshold for medium rain (cumulative %)
const RAIN_DEFERRAL_PENALTY_LARGE = -100; // Penalty for cleaning before large rain
const RAIN_DEFERRAL_PENALTY_MEDIUM = -50; // Penalty for cleaning before medium rain

// Natural rain cleaning constants
const RAIN_CLEANING_THRESHOLD = 5.0;     // Rain amount for natural cleaning (mm)
const RAIN_CLEANING_MAX_BOOST = 0.05;    // Maximum SR boost from rain cleaning

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Calculate cost/benefit using forecast-driven algorithm
 *
 * Algorithm steps:
 * 1. Build SR timeline using ML predictions (not linear decay)
 * 2. Apply AOD dynamic adjustments (if forecast available)
 * 3. Apply rain deferrals and natural cleaning (if forecast available)
 * 4. Calculate energy metrics
 * 5. Calculate financial metrics
 *
 * @param params Forecast-driven parameters
 * @returns Live cost/benefit result
 */
export function calculateForecastDrivenCostBenefit(
  params: ForecastDrivenParams
): LiveCostBenefitResult {
  const { cleaningDates, mlForecast, aodForecast, rainForecast, parameters } = params;

  // Validate inputs
  if (!mlForecast || mlForecast.length === 0) {
    throw new Error('ML forecast data is required for forecast-driven calculation');
  }

  // Build SR timeline using ML predictions
  const srTimeline = buildMLSRTimeline(mlForecast, cleaningDates);

  // Calculate baseline AOD for adjustments
  const baselineAOD = aodForecast && aodForecast.length > 0
    ? calculateHistoricalAODBaseline(mlForecast)
    : null;

  // Apply AOD adjustments if forecast available
  if (aodForecast && aodForecast.length > 0 && baselineAOD !== null) {
    applyAODDynamicAdjustments(srTimeline, aodForecast, baselineAOD);
  }

  // Apply rain deferrals and natural cleaning if forecast available
  if (rainForecast && rainForecast.length > 0) {
    applyRainDeferrals(srTimeline, rainForecast, cleaningDates);
  }

  // Calculate energy and financial metrics
  const result = calculateMetrics(srTimeline, mlForecast, cleaningDates, parameters);

  // Add calculation method metadata
  const hasAOD = aodForecast && aodForecast.length > 0;
  const hasRain = rainForecast && rainForecast.length > 0;
  result.calculation_method = hasAOD && hasRain
    ? 'forecast-driven-full'
    : hasAOD || hasRain
    ? 'forecast-driven-partial'
    : 'forecast-driven-ml-only';

  return result;
}

// ============================================================
// ML-Based SR Timeline Builder
// ============================================================

/**
 * Build soiling ratio timeline using ML predictions
 *
 * Key innovation: Decay TOWARD ML prediction (not linear decay)
 * - Cleaning day: SR = 0.95 (restore to 95%)
 * - Normal day: Decay from current SR toward ML prediction with confidence weighting
 *
 * @param mlForecast 365-day ML forecast
 * @param cleaningDates Cleaning date strings (YYYY-MM-DD)
 * @returns Map of date -> SR timeline point
 */
function buildMLSRTimeline(
  mlForecast: DigitalTwinDataPoint[],
  cleaningDates: string[]
): Map<string, SRTimelinePoint> {
  const timeline = new Map<string, SRTimelinePoint>();
  const cleaningSet = new Set(cleaningDates);

  let currentSR = 1.0; // Start perfectly clean

  for (const forecast of mlForecast) {
    const date = forecast.date;

    if (cleaningSet.has(date)) {
      // Cleaning day: restore to 95%
      currentSR = CLEANING_RECOVERY_SR;
    } else {
      // Normal day: decay toward ML prediction
      const mlSR = forecast.sr_predicted;
      const confidence = forecast.confidence || 1.0;

      // Calculate decay rate based on distance to ML prediction
      // Higher confidence = faster convergence to ML prediction
      const decayRate = (currentSR - mlSR) / DECAY_TIME_CONSTANT * confidence;
      currentSR = Math.max(currentSR - decayRate, MIN_SR_FLOOR);
    }

    timeline.set(date, {
      sr: currentSR,
      mlBaseline: forecast.sr_predicted,
      isCleaning: cleaningSet.has(date),
    });
  }

  return timeline;
}

// ============================================================
// AOD Dynamic Adjustments
// ============================================================

/**
 * Calculate historical AOD baseline from ML forecast data
 *
 * Uses average of recent historical period for comparison
 *
 * @param mlForecast 365-day ML forecast
 * @returns Baseline AOD value
 */
function calculateHistoricalAODBaseline(mlForecast: DigitalTwinDataPoint[]): number {
  // Use first 30 days as historical baseline (representative of typical conditions)
  const historicalPeriod = mlForecast.slice(0, Math.min(30, mlForecast.length));

  // Estimate baseline from soiling loss (higher loss = higher AOD)
  // This is a proxy when direct AOD historical data not available
  const avgSoilingLoss = historicalPeriod.reduce((sum, day) => sum + day.soiling_loss_pct, 0) / historicalPeriod.length;

  // Typical AOD range: 0.05 (clean) to 0.30 (dusty)
  // Map soiling loss (2-10%) to AOD (0.05-0.25)
  const estimatedBaseline = 0.05 + (avgSoilingLoss / 10.0) * 0.20;

  return estimatedBaseline;
}

/**
 * Apply AOD-based dynamic adjustments to soiling rates
 *
 * Logic:
 * - Calculate AOD deviation from baseline
 * - Adjust soiling rate by ±20% per 0.10 AOD deviation (capped ±50%)
 * - Classify dust risk level for UI display
 *
 * @param srTimeline SR timeline to modify in-place
 * @param aodForecast 5-day AOD forecast
 * @param baselineAOD Historical baseline AOD
 */
function applyAODDynamicAdjustments(
  srTimeline: Map<string, SRTimelinePoint>,
  aodForecast: AODForecastPoint[],
  baselineAOD: number
): void {
  // Create date lookup map
  const aodByDate = new Map<string, number>();
  for (const point of aodForecast) {
    if (point.aod_550nm_mean !== null) {
      aodByDate.set(point.date, point.aod_550nm_mean);
    }
  }

  // Apply adjustments to each day in forecast window
  for (const [date, data] of srTimeline.entries()) {
    if (aodByDate.has(date) && !data.isCleaning) {
      const currentAOD = aodByDate.get(date)!;
      const aodDeviation = currentAOD - baselineAOD;

      // Calculate adjustment factor
      // Example: +0.10 AOD → +20% soiling rate, capped at ±50%
      const adjustmentFactor = 1.0 + (aodDeviation / AOD_DEVIATION_UNIT) * AOD_SENSITIVITY;
      const cappedFactor = Math.max(AOD_ADJUSTMENT_MIN, Math.min(AOD_ADJUSTMENT_MAX, adjustmentFactor));

      // Apply adjustment (increases soiling if high dust)
      const soilingRate = 1 - data.sr;
      const adjustedSR = 1 - (soilingRate * cappedFactor);
      data.sr = Math.max(adjustedSR, MIN_SR_FLOOR);
      data.aodAdjustment = cappedFactor;
      data.dustRisk = classifyDustRisk(aodDeviation);
    }
  }
}

/**
 * Classify dust risk level based on AOD deviation
 *
 * @param aodDeviation Deviation from baseline AOD
 * @returns Dust risk level
 */
function classifyDustRisk(aodDeviation: number): DustRiskLevel {
  if (aodDeviation < -0.05) return 'low';       // Cleaner than baseline
  if (aodDeviation < 0.05) return 'normal';     // Near baseline
  if (aodDeviation < 0.15) return 'elevated';   // Moderately dusty
  return 'high';                                 // Very dusty
}

// ============================================================
// Rain Deferral Logic
// ============================================================

/**
 * Apply rain-based deferral logic and natural cleaning
 *
 * Logic:
 * 1. For each cleaning date, check 3-7 day window for rain
 * 2. Apply penalty if significant rain expected (defer cleaning)
 * 3. Apply natural rain cleaning boost for heavy rain events
 *
 * @param srTimeline SR timeline to modify in-place
 * @param rainForecast 16-day rain forecast
 * @param cleaningDates Cleaning date strings
 */
function applyRainDeferrals(
  srTimeline: Map<string, SRTimelinePoint>,
  rainForecast: RainForecastPoint[],
  cleaningDates: string[]
): void {
  // Create date lookup map
  const rainByDate = new Map<string, RainForecastPoint>();
  for (const point of rainForecast) {
    rainByDate.set(point.date, point);
  }

  // Check each cleaning date for rain in 3-7 day window
  for (const cleaningDate of cleaningDates) {
    const cleaningDateObj = parseISO(cleaningDate);

    // Check 3-7 day window after cleaning
    const windowStart = addDays(cleaningDateObj, 3);
    const windowEnd = addDays(cleaningDateObj, 7);

    const rainWindow: RainForecastPoint[] = [];
    let currentDate = windowStart;
    while (currentDate <= windowEnd) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      if (rainByDate.has(dateStr)) {
        rainWindow.push(rainByDate.get(dateStr)!);
      }
      currentDate = addDays(currentDate, 1);
    }

    if (rainWindow.length > 0) {
      const totalRainProb = rainWindow.reduce((sum, r) => sum + r.precipitation_probability, 0);
      const maxRainMM = Math.max(...rainWindow.map((r) => r.precipitation_mm));

      const timelinePoint = srTimeline.get(cleaningDate);
      if (timelinePoint) {
        // Apply deferral penalty based on rain intensity and probability
        if (maxRainMM > RAIN_LARGE_MM && totalRainProb > RAIN_LARGE_PROB_THRESHOLD) {
          timelinePoint.rainDeferralPenalty = RAIN_DEFERRAL_PENALTY_LARGE;
          timelinePoint.rainRecommendation =
            `DEFER: ${maxRainMM.toFixed(1)}mm rain expected (${totalRainProb.toFixed(0)}% cumulative probability)`;
        } else if (maxRainMM > RAIN_MEDIUM_MM && totalRainProb > RAIN_MEDIUM_PROB_THRESHOLD) {
          timelinePoint.rainDeferralPenalty = RAIN_DEFERRAL_PENALTY_MEDIUM;
          timelinePoint.rainRecommendation =
            `CONSIDER DEFERRING: ${maxRainMM.toFixed(1)}mm rain possible (${totalRainProb.toFixed(0)}% probability)`;
        }
      }
    }
  }

  // Apply natural rain cleaning boosts
  for (const rainPoint of rainForecast) {
    if (rainPoint.precipitation_mm > RAIN_CLEANING_THRESHOLD) {
      const timelinePoint = srTimeline.get(rainPoint.date);
      if (timelinePoint && !timelinePoint.isCleaning) {
        // Natural rain cleaning boost (up to 5% SR improvement)
        const cleaningBoost = Math.min(
          RAIN_CLEANING_MAX_BOOST,
          rainPoint.precipitation_mm / 100
        );
        timelinePoint.sr = Math.min(timelinePoint.sr + cleaningBoost, 1.0);
        timelinePoint.rainCleaning = true;
      }
    }
  }
}

// ============================================================
// Energy & Financial Metrics Calculation
// ============================================================

/**
 * Calculate energy and financial metrics from SR timeline
 *
 * @param srTimeline SR timeline
 * @param mlForecast ML forecast data (for energy calculations)
 * @param cleaningDates Cleaning dates
 * @param parameters Economic parameters
 * @returns Cost/benefit result
 */
function calculateMetrics(
  srTimeline: Map<string, SRTimelinePoint>,
  mlForecast: DigitalTwinDataPoint[],
  cleaningDates: string[],
  parameters: CleaningParameters
): LiveCostBenefitResult {
  let energyRecovered = 0;
  let sumSRWithCleaning = 0;
  let sumSRWithoutCleaning = 0;
  let daysCount = 0;

  // Calculate energy recovery for each day
  for (const forecast of mlForecast) {
    const timelinePoint = srTimeline.get(forecast.date);
    if (!timelinePoint) continue;

    const srWithCleaning = timelinePoint.sr;
    const srWithoutCleaning = forecast.sr_predicted;
    const energyIfClean = forecast.energy_if_clean_MWh;

    const energyWith = energyIfClean * srWithCleaning;
    const energyWithout = forecast.energy_with_soiling_MWh;

    energyRecovered += Math.max(0, energyWith - energyWithout);
    sumSRWithCleaning += srWithCleaning;
    sumSRWithoutCleaning += srWithoutCleaning;
    daysCount++;
  }

  // Calculate financial metrics
  const totalCost = cleaningDates.length * parameters.capacity_MW * parameters.cleaning_cost_per_MW;
  const revenueRecovered = energyRecovered * parameters.electricity_rate_per_MWh;
  const netBenefit = revenueRecovered - totalCost;
  const roi = totalCost > 0 ? (netBenefit / totalCost) * 100 : 0;

  return {
    dates: cleaningDates,
    n_cleanings: cleaningDates.length,
    total_cost_EUR: parseFloat(totalCost.toFixed(2)),
    estimated_energy_recovered_MWh: parseFloat(energyRecovered.toFixed(3)),
    estimated_revenue_recovered_EUR: parseFloat(revenueRecovered.toFixed(2)),
    estimated_net_benefit_EUR: parseFloat(netBenefit.toFixed(2)),
    estimated_roi_pct: parseFloat(roi.toFixed(1)),
    avg_sr_without_cleaning: parseFloat((sumSRWithoutCleaning / daysCount).toFixed(4)),
    avg_sr_with_cleaning: parseFloat((sumSRWithCleaning / daysCount).toFixed(4)),
    calculation_method: 'forecast-driven-full',
  };
}
