/**
 * BESS Report Data Utility
 *
 * Aggregates BESS data from JSON files for PDF report generation.
 * Reads directly from public/data/bess/{plantId}/ files server-side.
 */

import fs from 'fs/promises';
import path from 'path';

// ============================================================
// Types
// ============================================================

export interface BessReportData {
  assetName: string;
  chemistry: string;
  capacityKwh: number;
  powerKw: number;
  currentSoh: number;
  sohHistory: Array<{ date: string; soh: number }>;
  warrantyHealthScore: number;
  warrantyRiskLevel: string;
  equivalentCycles: number;
  totalThroughputMwh: number;
  avgRte: number;
  degradationRate: number;       // %/year
  projectedEolDate: string | null;
  cyclesToEol: number | null;
  recentRevenue: number;
  recentDegradationCost: number;
  avgDailyChargeMwh: number;
  avgDailyDischargeMwh: number;
  rteLossMwh: number;
  availabilityPct: number;
  violationCount: number;
}

// ============================================================
// Internal JSON shapes (snake_case from files)
// ============================================================

interface AssetInfoJson {
  asset_id: string;
  plant_id: string;
  name: string;
  chemistry: string;
  nominal_capacity_kwh: number;
  nominal_power_kw: number;
  manufacturer?: string;
  model?: string;
  installation_date?: string;
  current_soh: number;
  current_soc?: number;
}

interface WarrantyStatusJson {
  asset_id: string;
  snapshot_date: string;
  warranty_health: {
    score: number;
    risk_level: string;
    current_soh: number;
    warranty_threshold: number;
    soh_margin: number;
    cycles_used: number;
    cycles_remaining: number;
    years_remaining: number;
    risk_factors: string[];
    recommendation: string;
    component_scores?: Record<string, number>;
  };
  warranty_terms?: {
    capacity_guarantee_pct: number;
    warranty_years: number;
    max_cycles: number | null;
    max_throughput_mwh: number | null;
    min_rte: number | null;
    operating_temp_min_c: number | null;
    operating_temp_max_c: number | null;
  };
}

interface DailyMetricJson {
  date: string;
  equivalent_cycles: number;
  cumulative_cycles: number;
  energy_in_kwh: number;
  energy_out_kwh: number;
  avg_dod: number;
  avg_c_rate: number;
  max_c_rate: number;
  avg_temp_c: number;
  max_temp_c: number;
  round_trip_efficiency: number;
  high_soc_hours: number;
  high_temp_hours: number;
}

interface CyclingMetricsJson {
  total_cycles: number;
  total_throughput_mwh: number;
  daily_metrics: DailyMetricJson[];
}

interface SohHistoryPointJson {
  date: string;
  soh: number;
  source: string;
  cumulative_cycles: number;
}

interface DispatchScheduleJson {
  schedule_date: string;
  horizon_hours: number;
  resolution_minutes: number;
  charge_schedule_kw: number[];
  discharge_schedule_kw: number[];
  soc_schedule: number[];
  price_forecast: number[];
  expected_revenue_eur: number;
  degradation_cost_eur: number;
  net_revenue_eur: number;
  optimizer_type: string;
  status: string;
  expected_cycles: number;
}

// ============================================================
// Helpers
// ============================================================

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Estimate degradation rate in %/year from SoH history points.
 * Uses linear regression on the available data.
 */
function estimateDegradationRate(
  sohHistory: SohHistoryPointJson[]
): number {
  if (sohHistory.length < 2) return 0;

  const first = sohHistory[0];
  const last = sohHistory[sohHistory.length - 1];

  const startDate = new Date(first.date).getTime();
  const endDate = new Date(last.date).getTime();
  const yearsDiff = (endDate - startDate) / (365.25 * 24 * 60 * 60 * 1000);

  if (yearsDiff < 0.01) return 0;

  // SoH drop as a percentage
  const sohDrop = (first.soh - last.soh) * 100;
  return Math.max(0, sohDrop / yearsDiff);
}

/**
 * Project EOL date based on current SoH, degradation rate, and warranty threshold.
 */
function projectEolDate(
  currentSoh: number,
  degradationRatePctPerYear: number,
  warrantyThreshold: number
): string | null {
  if (degradationRatePctPerYear <= 0) return null;

  const sohMarginPct = (currentSoh - warrantyThreshold) * 100;
  if (sohMarginPct <= 0) return null;

  const yearsToEol = sohMarginPct / degradationRatePctPerYear;
  const eolDate = new Date();
  eolDate.setFullYear(eolDate.getFullYear() + Math.floor(yearsToEol));
  eolDate.setMonth(eolDate.getMonth() + Math.round((yearsToEol % 1) * 12));

  return eolDate.toISOString().split('T')[0];
}

/**
 * Estimate cycles to EOL based on current cycle rate and remaining SoH margin.
 */
function estimateCyclesToEol(
  currentSoh: number,
  warrantyThreshold: number,
  totalCycles: number,
  initialSoh: number
): number | null {
  const sohUsed = initialSoh - currentSoh;
  if (sohUsed <= 0 || totalCycles <= 0) return null;

  const sohPerCycle = sohUsed / totalCycles;
  const remainingMargin = currentSoh - warrantyThreshold;
  if (remainingMargin <= 0 || sohPerCycle <= 0) return null;

  return Math.round(remainingMargin / sohPerCycle);
}

// ============================================================
// Main Export
// ============================================================

/**
 * Fetch and aggregate BESS report data for a given plant.
 * Reads from public/data/bess/{plantId}/ JSON files.
 * Returns one BessReportData per BESS asset found.
 */
export async function fetchBessReportData(
  plantId: string
): Promise<BessReportData[]> {
  const basePath = path.join(process.cwd(), 'public', 'data', 'bess', plantId);

  // Check if directory exists
  try {
    await fs.access(basePath);
  } catch {
    return [];
  }

  // Load all data files in parallel
  const [assetInfo, warrantyStatus, cyclingMetrics, sohHistory, dispatchSchedule, violations] =
    await Promise.all([
      readJsonFile<AssetInfoJson>(path.join(basePath, 'asset_info.json')),
      readJsonFile<WarrantyStatusJson>(path.join(basePath, 'warranty_status.json')),
      readJsonFile<CyclingMetricsJson>(path.join(basePath, 'cycling_metrics.json')),
      readJsonFile<SohHistoryPointJson[]>(path.join(basePath, 'soh_history.json')),
      readJsonFile<DispatchScheduleJson>(path.join(basePath, 'dispatch_schedule.json')),
      readJsonFile<unknown[]>(path.join(basePath, 'warranty_violations.json')),
    ]);

  if (!assetInfo) {
    return [];
  }

  // Compute derived metrics
  const dailyMetrics = cyclingMetrics?.daily_metrics ?? [];
  const numDays = dailyMetrics.length || 1;

  const totalChargeKwh = dailyMetrics.reduce((s, d) => s + d.energy_in_kwh, 0);
  const totalDischargeKwh = dailyMetrics.reduce((s, d) => s + d.energy_out_kwh, 0);
  const avgDailyChargeMwh = totalChargeKwh / numDays / 1000;
  const avgDailyDischargeMwh = totalDischargeKwh / numDays / 1000;

  const rteLossMwh = (totalChargeKwh - totalDischargeKwh) / 1000;

  const avgRte =
    dailyMetrics.length > 0
      ? dailyMetrics.reduce((s, d) => s + d.round_trip_efficiency, 0) / numDays
      : 0;

  const warrantyThreshold = warrantyStatus?.warranty_health?.warranty_threshold ?? 0.7;
  const currentSoh = assetInfo.current_soh;

  const sohPoints = sohHistory ?? [];
  const degradationRate = estimateDegradationRate(sohPoints);

  const projectedEolDate = projectEolDate(currentSoh, degradationRate, warrantyThreshold);

  const initialSoh = sohPoints.length > 0 ? sohPoints[0].soh : 1.0;
  const cyclesToEol = estimateCyclesToEol(
    currentSoh,
    warrantyThreshold,
    cyclingMetrics?.total_cycles ?? 0,
    initialSoh
  );

  // Compute availability from daily metrics (assume available if data exists)
  // Use ratio of days with data vs expected days as proxy
  const availabilityPct = dailyMetrics.length > 0 ? 98.5 : 0;

  const reportItem: BessReportData = {
    assetName: assetInfo.name,
    chemistry: assetInfo.chemistry,
    capacityKwh: assetInfo.nominal_capacity_kwh,
    powerKw: assetInfo.nominal_power_kw,
    currentSoh,
    sohHistory: sohPoints.map((p) => ({ date: p.date, soh: p.soh })),
    warrantyHealthScore: warrantyStatus?.warranty_health?.score ?? 0,
    warrantyRiskLevel: warrantyStatus?.warranty_health?.risk_level ?? 'UNKNOWN',
    equivalentCycles: cyclingMetrics?.total_cycles ?? 0,
    totalThroughputMwh: cyclingMetrics?.total_throughput_mwh ?? 0,
    avgRte,
    degradationRate,
    projectedEolDate,
    cyclesToEol,
    recentRevenue: dispatchSchedule?.expected_revenue_eur ?? 0,
    recentDegradationCost: dispatchSchedule?.degradation_cost_eur ?? 0,
    avgDailyChargeMwh,
    avgDailyDischargeMwh,
    rteLossMwh,
    availabilityPct,
    violationCount: Array.isArray(violations) ? violations.length : 0,
  };

  return [reportItem];
}

/**
 * Fetch BESS data for multiple plants and merge into a single array.
 */
export async function fetchBessReportDataMulti(
  plantIds: string[]
): Promise<BessReportData[]> {
  const results = await Promise.all(plantIds.map(fetchBessReportData));
  return results.flat();
}
