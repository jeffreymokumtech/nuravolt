import type { DigitalTwinDataPoint } from '@/types/soiling';

// Cleaning fully restores SR to 1.0 — a clean panel performs at its design
// point. The Python optimizer uses a conservative 0.95 cap to discourage
// over-cleaning, but for the operator-facing trajectory chart the physical
// expectation is "post-cleaning, SR = 1.0".
const CLEANING_RECOVERY_SR = 1.0;
const MIN_SR_FLOOR = 0.8;
const DECAY_TIME_CONSTANT = 30;
const EMPTY_SET: ReadonlySet<string> = new Set();

export interface WhatIfParams {
  capacityMW: number;
  electricityRatePerMWh: number;
  cleaningCostPerMW: number;
  minDaysBetween: number;
}

export interface PerCleaningImpact {
  date: string;
  srBefore: number;
  srAfter: number;
  /** Energy recovered vs no-cleaning baseline from this cleaning until the next one (or forecast end). */
  energyRecoveredMWh: number;
  revenueEUR: number;
  costEUR: number;
  netEUR: number;
}

export interface WhatIfScore {
  dates: string[];
  nCleanings: number;
  srSeries: number[];
  /** Zero-cleaning simulation — the reference all benefits are measured against. */
  baselineSeries: number[];
  energyRecoveredMWh: number;
  revenueEUR: number;
  costEUR: number;
  netEUR: number;
  roiPct: number;
  avgSrWith: number;
  avgSrWithout: number;
  perCleaning: PerCleaningImpact[];
}

export function simulateSr(
  forecast: DigitalTwinDataPoint[],
  cleaningDates: ReadonlySet<string>,
): number[] {
  let sr = 1.0;
  const series: number[] = [];
  for (const day of forecast) {
    if (cleaningDates.has(day.date)) {
      // A cleaning never lowers SR — cleaning already-clean panels is wasted
      // money, not damage. (The Python scorer uses a hard 0.95 reset, but its
      // optimizer never picks such dates, so the two only diverge on manual
      // what-ifs where the physical behaviour is the honest one.)
      sr = Math.max(sr, CLEANING_RECOVERY_SR);
    } else {
      const decay = (sr - day.sr_predicted) / DECAY_TIME_CONSTANT;
      sr = Math.max(sr - decay, MIN_SR_FLOOR);
    }
    series.push(sr);
  }
  return series;
}

export function scoreSchedule(
  forecast: DigitalTwinDataPoint[],
  cleaningDates: string[],
  params: WhatIfParams,
): WhatIfScore {
  const dates = [...cleaningDates].sort();
  const dateSet = new Set(dates);
  const srSeries = simulateSr(forecast, dateSet);
  // Reference is the zero-cleaning simulation (not the raw ML baseline), so a
  // schedule with no cleanings scores exactly zero and every euro shown is
  // attributable to a cleaning. Both simulations share the same start-clean
  // transient, which cancels out in the difference.
  const baselineSeries = simulateSr(forecast, EMPTY_SET);

  let energyRecoveredMWh = 0;
  let sumWith = 0;
  let sumWithout = 0;
  for (let i = 0; i < forecast.length; i++) {
    const day = forecast[i];
    energyRecoveredMWh += day.energy_if_clean_MWh * (srSeries[i] - baselineSeries[i]);
    sumWith += srSeries[i];
    sumWithout += baselineSeries[i];
  }

  const costPerCleaning = params.capacityMW * params.cleaningCostPerMW;
  const costEUR = dates.length * costPerCleaning;
  const revenueEUR = energyRecoveredMWh * params.electricityRatePerMWh;
  const netEUR = revenueEUR - costEUR;
  const roiPct = costEUR > 0 ? (netEUR / costEUR) * 100 : 0;

  const indexByDate = new Map(forecast.map((d, i) => [d.date, i]));
  const perCleaning: PerCleaningImpact[] = dates
    .filter((d) => indexByDate.has(d))
    .map((date, k, kept) => {
      const start = indexByDate.get(date)!;
      const next = k + 1 < kept.length ? indexByDate.get(kept[k + 1])! : forecast.length;
      let segEnergy = 0;
      for (let i = start; i < next; i++) {
        segEnergy += forecast[i].energy_if_clean_MWh * (srSeries[i] - baselineSeries[i]);
      }
      const segRevenue = segEnergy * params.electricityRatePerMWh;
      return {
        date,
        srBefore: start > 0 ? srSeries[start - 1] : 1.0,
        srAfter: srSeries[start],
        energyRecoveredMWh: segEnergy,
        revenueEUR: segRevenue,
        costEUR: costPerCleaning,
        netEUR: segRevenue - costPerCleaning,
      };
    });

  return {
    dates,
    nCleanings: dates.length,
    srSeries,
    baselineSeries,
    energyRecoveredMWh,
    revenueEUR,
    costEUR,
    netEUR,
    roiPct,
    avgSrWith: forecast.length > 0 ? sumWith / forecast.length : 1,
    avgSrWithout: forecast.length > 0 ? sumWithout / forecast.length : 1,
    perCleaning,
  };
}

export interface DateViolation {
  type: 'too_close' | 'rain_soon';
  message: string;
  severity: 'error' | 'warning';
}

export function validateDate(
  date: string,
  existing: string[],
  forecast: DigitalTwinDataPoint[],
  minDaysBetween: number,
): DateViolation[] {
  const violations: DateViolation[] = [];
  const t = Date.parse(date);
  for (const other of existing) {
    if (other === date) continue;
    const days = Math.abs(t - Date.parse(other)) / 86_400_000;
    if (days < minDaysBetween) {
      violations.push({
        type: 'too_close',
        message: `Only ${Math.round(days)}d from cleaning on ${other} (min ${minDaysBetween}d)`,
        severity: 'error',
      });
    }
  }
  // Rain within 3 days after the cleaning largely wastes the spend.
  const idx = forecast.findIndex((d) => d.date === date);
  if (idx >= 0) {
    const rain = forecast
      .slice(idx, idx + 4)
      .reduce((acc, d) => acc + (d.rainfall_mm ?? 0), 0);
    if (rain >= 5) {
      violations.push({
        type: 'rain_soon',
        message: `${rain.toFixed(0)}mm rain forecast within 3 days of ${date} — rain may clean for free`,
        severity: 'warning',
      });
    }
  }
  return violations;
}
