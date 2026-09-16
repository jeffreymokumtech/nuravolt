/**
 * AOD-Based Soiling Rate Calculation Utilities
 *
 * Provides functions to calculate variable soiling rates based on
 * monthly AOD data and project SR trajectories for cleaning schedules.
 */

import { format, parseISO, getISOWeek, startOfWeek, endOfWeek } from 'date-fns';
import type {
  MonthlySoilingRate,
  MonthlySoilingRatesData,
  SRProjectionDataPoint,
  WeeklyDataPoint,
  CleaningParameters,
} from '@/types/soiling';

/**
 * Get the soiling rate for a specific date using monthly rates lookup.
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @param monthlyRates - Array of monthly soiling rates
 * @returns Soiling rate per day (decimal, e.g., 0.003 for 0.3%/day)
 */
export function getSoilingRateForDate(
  dateStr: string,
  monthlyRates: MonthlySoilingRate[]
): number {
  const monthKey = dateStr.slice(0, 7); // "2025-01" from "2025-01-15"

  // Try exact month match first
  let monthData = monthlyRates.find(m => m.month === monthKey);

  // If no exact match, find by month number (for year rollover)
  if (!monthData) {
    const monthNum = parseInt(dateStr.slice(5, 7));
    monthData = monthlyRates.find(m => {
      const mNum = parseInt(m.month.slice(5, 7));
      return mNum === monthNum;
    });
  }

  // Return rate or default
  return monthData?.soiling_rate_per_day ?? 0.003; // 0.3%/day fallback
}

/**
 * Calculate the full SR projection over a date range with variable rates.
 *
 * @param startDate - Start date (YYYY-MM-DD)
 * @param endDate - End date (YYYY-MM-DD)
 * @param cleaningDates - Array of cleaning date strings
 * @param monthlyRates - Monthly soiling rates
 * @param params - Additional parameters
 * @returns Array of daily SR projection data points
 */
export function calculateFullSRProjection(
  startDate: string,
  endDate: string,
  cleaningDates: string[],
  monthlyRates: MonthlySoilingRate[],
  params: {
    initialSR?: number;
    cleaningRecoverySR?: number;
    minSR?: number;
    capacityMW?: number;
    electricityRate?: number;
  } = {}
): SRProjectionDataPoint[] {
  const {
    initialSR = 1.0,
    cleaningRecoverySR = 0.95,
    minSR = 0.70,
    capacityMW = 9.0,
    electricityRate = 65,
  } = params;

  const projection: SRProjectionDataPoint[] = [];
  const cleaningSet = new Set(cleaningDates.sort());

  let currentDate = new Date(startDate);
  const end = new Date(endDate);

  let sr_with = initialSR;
  let sr_without = initialSR;
  let cumulative_energy = 0;
  let cumulative_benefit = 0;

  // Average sun hours per day for energy calculation
  const avgSunHours = 7.5;

  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const dailyRate = getSoilingRateForDate(dateStr, monthlyRates);
    const isCleaning = cleaningSet.has(dateStr);
    const weekNum = getISOWeek(currentDate);

    // SR without cleaning always decays
    sr_without = Math.max(sr_without - dailyRate, minSR);

    // SR with cleaning resets on cleaning days
    if (isCleaning) {
      sr_with = cleaningRecoverySR;
    } else {
      sr_with = Math.max(sr_with - dailyRate, minSR);
    }

    // Calculate energy recovered for this day
    const dailyEnergyIfClean = capacityMW * avgSunHours;
    const energyWith = dailyEnergyIfClean * sr_with;
    const energyWithout = dailyEnergyIfClean * sr_without;
    const dailyEnergyRecovered = Math.max(0, energyWith - energyWithout);

    cumulative_energy += dailyEnergyRecovered;
    cumulative_benefit += dailyEnergyRecovered * electricityRate;

    projection.push({
      date: dateStr,
      dateFormatted: format(currentDate, 'MMM d'),
      week: weekNum,
      sr_without_cleaning: parseFloat(sr_without.toFixed(4)),
      sr_with_cleaning: parseFloat(sr_with.toFixed(4)),
      soiling_rate_applied: dailyRate,
      is_cleaning_day: isCleaning,
      cumulative_energy_recovered_MWh: parseFloat(cumulative_energy.toFixed(2)),
      cumulative_net_benefit_EUR: parseFloat(cumulative_benefit.toFixed(2)),
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return projection;
}

/**
 * Aggregate daily SR projection data to weekly summaries.
 *
 * @param dailyData - Array of daily SR projection data points
 * @returns Array of weekly aggregated data points
 */
export function aggregateToWeekly(dailyData: SRProjectionDataPoint[]): WeeklyDataPoint[] {
  // Group by week number
  const weeklyMap = new Map<number, SRProjectionDataPoint[]>();

  dailyData.forEach(d => {
    const weekNum = d.week;
    if (!weeklyMap.has(weekNum)) {
      weeklyMap.set(weekNum, []);
    }
    weeklyMap.get(weekNum)!.push(d);
  });

  // Convert to weekly summaries
  const weeklyData: WeeklyDataPoint[] = [];

  Array.from(weeklyMap.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([week, days]) => {
      const firstDay = days[0];
      const lastDay = days[days.length - 1];

      // Calculate averages
      const sr_without_avg = days.reduce((sum, d) => sum + d.sr_without_cleaning, 0) / days.length;
      const sr_with_avg = days.reduce((sum, d) => sum + d.sr_with_cleaning, 0) / days.length;
      const avg_soiling_rate = days.reduce((sum, d) => sum + d.soiling_rate_applied, 0) / days.length;

      // Check for cleanings in this week
      const cleaningDays = days.filter(d => d.is_cleaning_day);
      const has_cleaning = cleaningDays.length > 0;
      const cleaning_dates = cleaningDays.map(d => d.date);

      // Energy recovered this week (difference from start to end of week)
      const startEnergy = firstDay.cumulative_energy_recovered_MWh;
      const endEnergy = lastDay.cumulative_energy_recovered_MWh;
      const weeklyEnergy = endEnergy - startEnergy + (firstDay.cumulative_energy_recovered_MWh > 0 ? 0 : firstDay.cumulative_energy_recovered_MWh);

      weeklyData.push({
        week,
        weekLabel: `W${week}`,
        startDate: firstDay.date,
        endDate: lastDay.date,
        sr_without_avg: parseFloat(sr_without_avg.toFixed(4)),
        sr_with_avg: parseFloat(sr_with_avg.toFixed(4)),
        avg_soiling_rate: parseFloat(avg_soiling_rate.toFixed(6)),
        has_cleaning,
        cleaning_dates,
        energy_recovered_MWh: parseFloat(weeklyEnergy.toFixed(2)),
        revenue_recovered_EUR: parseFloat((weeklyEnergy * 65).toFixed(2)),
      });
    });

  return weeklyData;
}

/**
 * Calculate optimal cleaning dates for a given number of cleanings.
 * Uses a simple even distribution strategy as a starting point.
 *
 * @param startDate - Start date
 * @param endDate - End date
 * @param nCleanings - Number of cleanings to schedule
 * @param monthlyRates - Monthly soiling rates (to prioritize high-soiling months)
 * @returns Array of cleaning date strings
 */
export function distributeCleaningsEvenly(
  startDate: string,
  endDate: string,
  nCleanings: number
): string[] {
  if (nCleanings <= 0) return [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  const totalDays = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  const interval = Math.floor(totalDays / (nCleanings + 1));
  const dates: string[] = [];

  for (let i = 1; i <= nCleanings; i++) {
    const cleaningDate = new Date(start);
    cleaningDate.setDate(cleaningDate.getDate() + interval * i);
    dates.push(cleaningDate.toISOString().split('T')[0]);
  }

  return dates;
}

/**
 * Calculate financial metrics for a cleaning schedule.
 *
 * @param projection - Full SR projection
 * @param cleaningDates - Array of cleaning dates
 * @param params - Cleaning parameters
 * @returns Financial summary
 */
export function calculateFinancialMetrics(
  projection: SRProjectionDataPoint[],
  cleaningDates: string[],
  params: CleaningParameters
): {
  totalCleanings: number;
  cleaningCost: number;
  energyRecovered: number;
  revenueRecovered: number;
  netBenefit: number;
  roi: number;
  paybackDays: number;
  avgSRWithout: number;
  avgSRWith: number;
} {
  const totalCleanings = cleaningDates.length;
  const cleaningCost = totalCleanings * params.capacity_MW * params.cleaning_cost_per_MW;

  // Get final cumulative values
  const lastDay = projection[projection.length - 1];
  const energyRecovered = lastDay?.cumulative_energy_recovered_MWh ?? 0;
  const revenueRecovered = energyRecovered * params.electricity_rate_per_MWh;
  const netBenefit = revenueRecovered - cleaningCost;
  const roi = cleaningCost > 0 ? (netBenefit / cleaningCost) * 100 : 0;

  // Calculate payback days
  const dailyRevenue = revenueRecovered / projection.length;
  const paybackDays = dailyRevenue > 0 ? cleaningCost / dailyRevenue : 0;

  // Calculate average SRs
  const avgSRWithout = projection.reduce((sum, d) => sum + d.sr_without_cleaning, 0) / projection.length;
  const avgSRWith = projection.reduce((sum, d) => sum + d.sr_with_cleaning, 0) / projection.length;

  return {
    totalCleanings,
    cleaningCost: parseFloat(cleaningCost.toFixed(2)),
    energyRecovered: parseFloat(energyRecovered.toFixed(2)),
    revenueRecovered: parseFloat(revenueRecovered.toFixed(2)),
    netBenefit: parseFloat(netBenefit.toFixed(2)),
    roi: parseFloat(roi.toFixed(1)),
    paybackDays: parseFloat(paybackDays.toFixed(1)),
    avgSRWithout: parseFloat(avgSRWithout.toFixed(4)),
    avgSRWith: parseFloat(avgSRWith.toFixed(4)),
  };
}

/**
 * Load monthly soiling rates from JSON file.
 * For client-side use with fetch.
 *
 * @param plantId - Plant identifier
 * @returns Promise resolving to monthly soiling rates data
 */
export async function loadMonthlySoilingRates(
  plantId: string = 'alpha1',
  dataRoot: string = '/data',
): Promise<MonthlySoilingRatesData | null> {
  try {
    const response = await fetch(`${dataRoot}/soiling/${plantId}/monthly_soiling_rates.json`);
    if (!response.ok) {
      console.warn(`Failed to load monthly soiling rates for ${plantId}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Error loading monthly soiling rates:', error);
    return null;
  }
}
