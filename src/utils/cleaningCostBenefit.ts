/**
 * Live cost/benefit calculation utility for cleaning schedules.
 *
 * Provides instant client-side calculations (<500ms) for user experimentation.
 * Uses forecast-driven algorithm with ML predictions (when available) or
 * simplified physics fallback.
 *
 * For final optimization, use backend API with full digital twin.
 */

import { differenceInDays, format, parseISO } from 'date-fns';
import type {
  CleaningParameters,
  LiveCostBenefitResult,
  DigitalTwinDataPoint,
  MonthlySoilingRate,
  AODForecastPoint,
  RainForecastPoint,
} from '@/types/soiling';
import { getSoilingRateForDate } from './aodSoilingRates';
import { calculateForecastDrivenCostBenefit } from './forecastDrivenOptimization';

interface CleaningEvent {
  date: Date;
  dateStr: string;
}

/**
 * Calculate live cost/benefit for manual cleaning dates
 *
 * @param cleaningDates - Array of cleaning date strings (YYYY-MM-DD)
 * @param parameters - Cleaning optimization parameters
 * @param digitalTwinData - Optional digital twin forecast data (ML predictions)
 * @param monthlySoilingRates - Optional monthly soiling rates for variable rate calculation
 * @param aodForecast - Optional AOD forecast data (5 days)
 * @param rainForecast - Optional rain forecast data (16 days)
 * @returns Live cost/benefit result
 */
export function calculateLiveCostBenefit(
  cleaningDates: string[],
  parameters: CleaningParameters,
  digitalTwinData?: DigitalTwinDataPoint[],
  monthlySoilingRates?: MonthlySoilingRate[],
  aodForecast?: AODForecastPoint[],
  rainForecast?: RainForecastPoint[]
): LiveCostBenefitResult {
  // Sort dates
  const sortedDates = [...cleaningDates].sort();
  const cleanings: CleaningEvent[] = sortedDates.map(dateStr => ({
    date: parseISO(dateStr),
    dateStr
  }));

  const n_cleanings = cleanings.length;

  // Calculate total cost
  const total_cost_EUR = n_cleanings * parameters.capacity_MW * parameters.cleaning_cost_per_MW;

  // If ML forecast + forecasts available, use smart forecast-driven logic
  if (digitalTwinData && digitalTwinData.length > 0 && (aodForecast || rainForecast)) {
    try {
      return calculateForecastDrivenCostBenefit({
        cleaningDates: sortedDates,
        mlForecast: digitalTwinData,
        aodForecast,
        rainForecast,
        parameters,
      });
    } catch (err) {
      console.warn('Forecast-driven calculation failed, falling back to digital twin:', err);
      // Fall through to digital twin calculation
    }
  }

  // If digital twin data available, use it for calculation
  if (digitalTwinData && digitalTwinData.length > 0) {
    return calculateWithDigitalTwin(cleanings, parameters, digitalTwinData, total_cost_EUR, monthlySoilingRates);
  }

  // Otherwise, use simplified estimation with variable rates
  return calculateSimplified(cleanings, parameters, total_cost_EUR, monthlySoilingRates);
}

/**
 * Calculate cost/benefit using digital twin forecast data
 */
function calculateWithDigitalTwin(
  cleanings: CleaningEvent[],
  parameters: CleaningParameters,
  digitalTwinData: DigitalTwinDataPoint[],
  total_cost_EUR: number,
  monthlySoilingRates?: MonthlySoilingRate[]
): LiveCostBenefitResult {
  // Create a map of cleaning dates for quick lookup
  const cleaningMap = new Map<string, boolean>();
  cleanings.forEach(c => cleaningMap.set(c.dateStr, true));

  // Simulate SR over time with cleanings
  let energy_recovered_MWh = 0;
  let current_sr = 1.0; // Start clean
  let sum_sr_with_cleaning = 0;
  let sum_sr_without_cleaning = 0;
  let days_count = 0;

  for (let i = 0; i < digitalTwinData.length; i++) {
    const day = digitalTwinData[i];
    const date = day.date;

    // Check if cleaning happens today
    if (cleaningMap.has(date)) {
      current_sr = 0.95; // Clean to 95% (5% permanent soiling)
    } else {
      // Apply daily soiling decay (use forecast if available)
      const daily_decay = 1 - (day.soiling_loss_pct / 100 / 30); // Approximate daily decay
      current_sr = Math.max(current_sr * daily_decay, 0.80); // Floor at 80%
    }

    // Energy recovered = (SR_with_cleaning - SR_without_cleaning) * energy_if_clean
    const sr_without_cleaning = day.sr_predicted;
    const energy_if_clean = day.energy_if_clean_MWh;

    const energy_with_cleaning = energy_if_clean * current_sr;
    const energy_without_cleaning = day.energy_with_soiling_MWh;

    energy_recovered_MWh += Math.max(0, energy_with_cleaning - energy_without_cleaning);

    sum_sr_with_cleaning += current_sr;
    sum_sr_without_cleaning += sr_without_cleaning;
    days_count++;
  }

  // Calculate averages
  const avg_sr_with_cleaning = sum_sr_with_cleaning / days_count;
  const avg_sr_without_cleaning = sum_sr_without_cleaning / days_count;

  // Calculate financial metrics
  const estimated_revenue_recovered_EUR = energy_recovered_MWh * parameters.electricity_rate_per_MWh;
  const estimated_net_benefit_EUR = estimated_revenue_recovered_EUR - total_cost_EUR;
  const estimated_roi_pct = total_cost_EUR > 0
    ? (estimated_net_benefit_EUR / total_cost_EUR) * 100
    : 0;

  return {
    dates: cleanings.map(c => c.dateStr),
    n_cleanings: cleanings.length,
    total_cost_EUR: parseFloat(total_cost_EUR.toFixed(2)),
    estimated_energy_recovered_MWh: parseFloat(energy_recovered_MWh.toFixed(3)),
    estimated_revenue_recovered_EUR: parseFloat(estimated_revenue_recovered_EUR.toFixed(2)),
    estimated_net_benefit_EUR: parseFloat(estimated_net_benefit_EUR.toFixed(2)),
    estimated_roi_pct: parseFloat(estimated_roi_pct.toFixed(1)),
    avg_sr_without_cleaning: parseFloat(avg_sr_without_cleaning.toFixed(4)),
    avg_sr_with_cleaning: parseFloat(avg_sr_with_cleaning.toFixed(4)),
    calculation_method: 'client-side-estimate'
  };
}

/**
 * Calculate cost/benefit using simplified physics model
 * (When digital twin data is not available)
 */
function calculateSimplified(
  cleanings: CleaningEvent[],
  parameters: CleaningParameters,
  total_cost_EUR: number,
  monthlySoilingRates?: MonthlySoilingRate[]
): LiveCostBenefitResult {
  // Assumptions for simplified model
  const analysis_days = 365;
  const avg_sun_hours_per_day = 7.5; // Average across year
  const daily_energy_if_clean_MWh = parameters.capacity_MW * avg_sun_hours_per_day;

  // Soiling rate - use variable rates if available, otherwise fixed
  const base_soiling_rate_per_day = 0.003; // 0.3% per day fallback (semi-arid climate)
  const cleaning_recovery = 0.95; // Clean to 95%

  // Helper to get soiling rate for a date
  const getSoilingRate = (dateStr: string): number => {
    if (monthlySoilingRates && monthlySoilingRates.length > 0) {
      return getSoilingRateForDate(dateStr, monthlySoilingRates);
    }
    return base_soiling_rate_per_day;
  };

  // Day-by-day simulation with variable soiling rates
  const sr_start = 1.0;
  // Note: min_sr is physical floor (heavily soiled panels), NOT based on threshold
  // Threshold is when you SHOULD clean, min_sr is the lowest SR possible
  const min_sr = 0.70; // Physical floor: even severely soiled panels retain ~70% performance

  // Create cleaning date set for quick lookup
  const cleaningDateSet = new Set(cleanings.map(c => c.dateStr));

  // Start date - use current year Jan 1 or first cleaning date
  const start_date = new Date(new Date().getFullYear(), 0, 1);
  const end_date = new Date(start_date);
  end_date.setDate(end_date.getDate() + analysis_days);

  // Day-by-day simulation
  let sr_without = sr_start;
  let sr_with = sr_start;
  let sum_sr_without = 0;
  let sum_sr_with = 0;
  let energy_recovered_MWh = 0;
  let day_count = 0;

  const currentDate = new Date(start_date);

  while (currentDate < end_date) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const dailyRate = getSoilingRate(dateStr);

    // Check if cleaning occurs today
    if (cleaningDateSet.has(dateStr)) {
      sr_with = cleaning_recovery;
    } else {
      // Apply daily soiling decay
      sr_with = Math.max(sr_with - dailyRate, min_sr);
    }

    // SR without cleaning always decays
    sr_without = Math.max(sr_without - dailyRate, min_sr);

    // Calculate energy for this day
    const daily_energy_with = daily_energy_if_clean_MWh * sr_with;
    const daily_energy_without = daily_energy_if_clean_MWh * sr_without;
    energy_recovered_MWh += Math.max(0, daily_energy_with - daily_energy_without);

    sum_sr_without += sr_without;
    sum_sr_with += sr_with;
    day_count++;

    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const avg_sr_without_cleaning = sum_sr_without / day_count;
  const avg_sr_with_cleaning = sum_sr_with / day_count;

  // Calculate financial metrics (energy_recovered_MWh already calculated in loop)
  const estimated_revenue_recovered_EUR = energy_recovered_MWh * parameters.electricity_rate_per_MWh;
  const estimated_net_benefit_EUR = estimated_revenue_recovered_EUR - total_cost_EUR;
  const estimated_roi_pct = total_cost_EUR > 0
    ? (estimated_net_benefit_EUR / total_cost_EUR) * 100
    : 0;

  return {
    dates: cleanings.map(c => c.dateStr),
    n_cleanings: cleanings.length,
    total_cost_EUR: parseFloat(total_cost_EUR.toFixed(2)),
    estimated_energy_recovered_MWh: parseFloat(energy_recovered_MWh.toFixed(3)),
    estimated_revenue_recovered_EUR: parseFloat(estimated_revenue_recovered_EUR.toFixed(2)),
    estimated_net_benefit_EUR: parseFloat(estimated_net_benefit_EUR.toFixed(2)),
    estimated_roi_pct: parseFloat(estimated_roi_pct.toFixed(1)),
    avg_sr_without_cleaning: parseFloat(avg_sr_without_cleaning.toFixed(4)),
    avg_sr_with_cleaning: parseFloat(avg_sr_with_cleaning.toFixed(4)),
    calculation_method: 'client-side-estimate'
  };
}

/**
 * Validate cleaning date against constraints
 *
 * @param newDate - New cleaning date to validate
 * @param existingDates - Existing cleaning dates
 * @param parameters - Cleaning parameters
 * @param rainForecast - Optional rain forecast data
 * @returns Validation result with violations
 */
export function validateCleaningDate(
  newDate: string,
  existingDates: string[],
  parameters: CleaningParameters,
  rainForecast?: Map<string, number>
): { isValid: boolean; violations: Array<{ type: string; message: string; severity: 'error' | 'warning' }> } {
  const violations: Array<{ type: string; message: string; severity: 'error' | 'warning' }> = [];
  const newDateObj = parseISO(newDate);

  // Check spacing constraint
  existingDates.forEach(existingDate => {
    if (existingDate === newDate) return;

    const existingDateObj = parseISO(existingDate);
    const days_between = Math.abs(differenceInDays(newDateObj, existingDateObj));

    if (days_between < parameters.min_days_between_cleanings) {
      violations.push({
        type: 'too_close',
        message: `Too close to cleaning on ${format(existingDateObj, 'MMM d, yyyy')} (${days_between} days, min: ${parameters.min_days_between_cleanings})`,
        severity: 'error'
      });
    }
  });

  // Check rain forecast (if available)
  if (rainForecast) {
    let total_rain_in_window = 0;

    // Check rain in next N days (rain_avoidance_days)
    for (let i = 0; i <= parameters.rain_avoidance_days; i++) {
      const checkDate = new Date(newDateObj);
      checkDate.setDate(checkDate.getDate() + i);
      const checkDateStr = format(checkDate, 'yyyy-MM-dd');

      const rain = rainForecast.get(checkDateStr) || 0;
      total_rain_in_window += rain;
    }

    if (total_rain_in_window > parameters.rain_threshold_mm) {
      violations.push({
        type: 'rain_expected',
        message: `Rain expected within ${parameters.rain_avoidance_days} days (${total_rain_in_window.toFixed(1)}mm, threshold: ${parameters.rain_threshold_mm}mm)`,
        severity: 'warning'
      });
    }
  }

  return {
    isValid: violations.filter(v => v.severity === 'error').length === 0,
    violations
  };
}

/**
 * Get color for constraint zone visualization
 *
 * @param date - Date to check
 * @param cleaningDates - Existing cleaning dates
 * @param parameters - Cleaning parameters
 * @param rainForecast - Optional rain forecast
 * @returns Color string (green, blue, red, or gray)
 */
export function getConstraintZoneColor(
  date: string,
  cleaningDates: string[],
  parameters: CleaningParameters,
  rainForecast?: Map<string, number>
): 'green' | 'blue' | 'red' | 'gray' {
  const validation = validateCleaningDate(date, cleaningDates, parameters, rainForecast);

  if (!validation.isValid) {
    return 'red'; // Error: too close to another cleaning
  }

  const hasRainWarning = validation.violations.some(v => v.type === 'rain_expected');
  if (hasRainWarning) {
    return 'blue'; // Warning: rain expected
  }

  return 'green'; // Valid placement
}
