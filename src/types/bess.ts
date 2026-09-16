/**
 * TypeScript interfaces for BESS (Battery Energy Storage System) analytics.
 * Matches Prisma schema and nuravolt.bess Python backend structures.
 */

// ============================================================
// Enums (match Prisma schema)
// ============================================================

export type BessChemistry = 'LFP' | 'NMC' | 'NCA' | 'LTO';

export type WarrantyViolationType =
  | 'TEMPERATURE_EXCEED'
  | 'SOC_HIGH_DWELL'
  | 'SOC_LOW_DWELL'
  | 'CYCLING_DEPTH'
  | 'CYCLING_FREQUENCY'
  | 'C_RATE_EXCEED'
  | 'VOLTAGE_VIOLATION'
  | 'THROUGHPUT_EXCEED'
  | 'HVAC_FAILURE'
  | 'RTE_DEGRADATION'
  | 'CAPACITY_DEGRADATION';

export type WarrantyRiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export type ViolationSeverity = 'warning' | 'critical';

// ============================================================
// Asset & Hardware Types
// ============================================================

/**
 * BESS Asset information
 * Matches BessAsset Prisma model
 */
export interface BessAssetInfo {
  id: string;
  plantId: string;
  externalAssetId: string;
  name: string | null;
  chemistry: BessChemistry;
  nominalCapacityKwh: number;
  nominalPowerKw: number;
  moduleCount: number | null;
  rackCount: number | null;
  installationDate: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  currentSoh: number | null;
  currentSoc: number | null;
  lastCapacityTest: string | null;
  lastUpdated: string | null;
  enabled: boolean;
}

/**
 * Asset overview for dashboard display
 */
export interface BessAssetOverview {
  asset: BessAssetInfo;
  currentStatus: {
    soh: number;
    soc: number;
    temperature: number | null;
    power: number | null;
    status: 'charging' | 'discharging' | 'idle' | 'offline';
  };
  kpis: {
    cycleCount: number;
    totalThroughputMwh: number;
    avgRte: number;
    warrantyHealthScore: number;
    activeViolations: number;
  };
  metadata: {
    lastUpdated: string;
    dataQuality: 'good' | 'partial' | 'poor';
  };
}

// ============================================================
// Warranty Types
// ============================================================

/**
 * Warranty terms configuration
 * Matches BessWarrantyTerms Prisma model
 */
export interface WarrantyTerms {
  id: string;
  assetId: string;
  capacityGuaranteePct: number;
  warrantyYears: number;
  maxCycles: number | null;
  maxThroughputMwh: number | null;
  minRte: number | null;
  maxAvgSoc: number | null;
  minSoc: number | null;
  socHoldLimitHours: number | null;
  operatingTempMinC: number | null;
  operatingTempMaxC: number | null;
  tempViolationMinutes: number | null;
  maxCRateContinuous: number | null;
  maxCRatePeak: number | null;
  peakDurationMinutes: number | null;
  cellVoltageMinV: number | null;
  cellVoltageMaxV: number | null;
  effectiveFrom: string;
}

/**
 * Warranty status snapshot
 * Matches BessWarrantyStatus Prisma model
 */
export interface WarrantyStatus {
  id: string;
  assetId: string;
  snapshotDate: string;
  currentSoh: number;
  warrantyThreshold: number;
  sohMargin: number;
  equivalentFullCycles: number;
  totalThroughputMwh: number;
  cycleUsagePct: number;
  timeUsagePct: number;
  yearsRemaining: number;
  avgRte30d: number | null;
  warrantyHealthScore: number;
  riskLevel: WarrantyRiskLevel;
  projectedEolDate: string | null;
  projectedCyclesToEol: number | null;
  activeViolations: number;
}

/**
 * Warranty health score breakdown
 */
export interface WarrantyHealthScore {
  score: number;
  riskLevel: WarrantyRiskLevel;
  components: {
    sohScore: number;
    cycleScore: number;
    timeScore: number;
    efficiencyScore: number;
    violationsScore: number;
  };
  metrics: {
    currentSoh: number;
    warrantyThreshold: number;
    sohMargin: number;
    cyclesUsed: number;
    cyclesRemaining: number;
    yearsRemaining: number;
  };
  projections: {
    projectedEolDate: string | null;
    estimatedCyclesToEol: number | null;
  };
  riskFactors: string[];
  recommendation: string;
}

/**
 * Warranty violation event
 * Matches BessWarrantyViolation Prisma model
 */
export interface WarrantyViolation {
  id: string;
  assetId: string;
  violationType: WarrantyViolationType;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  severity: ViolationSeverity;
  measuredValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  description: string | null;
  rootCause: string | null;
  affectedModules: string[];
  isResolved: boolean;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  ticketId: string | null;
}

// ============================================================
// Cycling & Performance Types
// ============================================================

/**
 * Cycle record for a single day
 * Matches BessCycleRecord Prisma model
 */
export interface CycleRecord {
  id: string;
  assetId: string;
  cycleDate: string;
  energyInKwh: number;
  energyOutKwh: number;
  equivalentCycles: number;
  cumulativeCycles: number;
  cumulativeThroughputKwh: number;
  avgSoc: number | null;
  maxSoc: number | null;
  minSoc: number | null;
  avgDod: number | null;
  avgTempC: number | null;
  maxTempC: number | null;
  minTempC: number | null;
  avgCRate: number | null;
  maxCRate: number | null;
  roundTripEfficiency: number | null;
  highSocHours: number | null;
  highTempHours: number | null;
  rainflowData: RainflowCycle[] | null;
}

/**
 * Rainflow cycle from rainflow counting algorithm
 */
export interface RainflowCycle {
  depth: number;        // Depth of discharge (0-1)
  meanSoc: number;      // Mean SoC during cycle
  count: number;        // Full or half cycle (0.5 or 1.0)
  startTime: string;    // ISO timestamp
  endTime: string;      // ISO timestamp
  avgTemp: number | null;
  avgCRate: number | null;
}

/**
 * Daily cycling metrics summary
 */
export interface DailyCyclingMetrics {
  date: string;
  equivalentCycles: number;
  throughputKwh: number;
  avgDod: number;
  avgCRate: number;
  avgTemp: number;
  roundTripEfficiency: number;
  stressWeightedCycles: number;
}

/**
 * Cycling analysis summary
 */
export interface CyclingMetricsSummary {
  assetId: string;
  period: {
    start: string;
    end: string;
    days: number;
  };
  totals: {
    equivalentFullCycles: number;
    throughputMwh: number;
    energyChargedMwh: number;
    energyDischargedMwh: number;
  };
  averages: {
    dailyCycles: number;
    dod: number;
    cRate: number;
    temperature: number;
    roundTripEfficiency: number;
  };
  limits: {
    maxDod: number;
    maxCRate: number;
    maxTemp: number;
    minTemp: number;
  };
  stressMetrics: {
    highSocHoursTotal: number;
    highTempHoursTotal: number;
    stressWeightedCycles: number;
  };
  dailyRecords: DailyCyclingMetrics[];
}

/**
 * Capacity test result
 * Matches BessCapacityTest Prisma model
 */
export interface CapacityTest {
  id: string;
  assetId: string;
  testDate: string;
  measuredCapacityKwh: number;
  sohResult: number;
  capacityRetention: number;
  testType: 'standard' | 'partial' | 'estimated';
  ambientTempC: number | null;
  initialSoc: number | null;
  testProtocol: string | null;
  cRateUsed: number | null;
  durationHours: number | null;
  isValid: boolean;
  invalidationReason: string | null;
  notes: string | null;
}

/**
 * State of Health history for charting
 */
export interface SoHHistoryPoint {
  date: string;
  soh: number;
  source: 'capacity_test' | 'estimated' | 'operational';
  isCapacityTest: boolean;
  capacityKwh?: number;
}

// ============================================================
// Dispatch & Optimization Types
// ============================================================

/**
 * Dispatch schedule
 * Matches BessDispatchSchedule Prisma model
 */
export interface DispatchSchedule {
  id: string;
  assetId: string;
  scheduleDate: string;
  horizonHours: number;
  resolutionMinutes: number;
  chargeScheduleKw: number[];
  dischargeScheduleKw: number[];
  socSchedule: number[];
  priceForecast: number[];
  expectedRevenueEur: number;
  degradationCostEur: number;
  netRevenueEur: number;
  expectedCycles: number;
  avgDod: number | null;
  optimizerType: 'lp' | 'milp' | 'mpc' | 'rule_based';
  objectiveFunction: 'max_revenue' | 'min_degradation' | 'balanced' | null;
  solveTimeMs: number | null;
  status: 'optimal' | 'suboptimal' | 'infeasible' | 'timeout';
  solverMessage: string | null;
  warrantyConstrained: boolean;
  maxCyclesConstrained: boolean;
}

/**
 * Single time slot in dispatch schedule
 */
export interface DispatchSlot {
  timestamp: string;
  hour: number;
  chargeKw: number;
  dischargeKw: number;
  soc: number;
  priceEurMwh: number;
  action: 'charge' | 'discharge' | 'idle';
}

/**
 * Arbitrage opportunity
 */
export interface ArbitrageOpportunity {
  chargeWindow: {
    start: string;
    end: string;
    avgPriceEurMwh: number;
  };
  dischargeWindow: {
    start: string;
    end: string;
    avgPriceEurMwh: number;
  };
  spread: number;
  expectedRevenueEur: number;
  degradationCostEur: number;
  netRevenueEur: number;
  requiredCycles: number;
}

// ============================================================
// API Response Types
// ============================================================

/**
 * GET /api/bess/plants/[plantId]
 * List BESS assets for a plant
 */
export interface BessAssetsListResponse {
  plantId: string;
  assets: BessAssetInfo[];
  count: number;
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]
 * Asset overview with current status
 */
export interface BessAssetOverviewResponse {
  asset: BessAssetInfo;
  warrantyStatus: WarrantyStatus | null;
  cyclingMetrics: CyclingMetricsSummary | null;
  recentViolations: WarrantyViolation[];
  dispatchSchedule: DispatchSchedule | null;
  metadata: {
    generatedAt: string;
    dataSource: string;
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/warranty
 * Warranty status and health score
 */
/**
 * Where the numbers in `terms` came from. A limit defaulted from the cell
 * chemistry must never be presented as a contractual figure: it is not what the
 * OEM agreed to, and quoting it back in a warranty claim would be wrong.
 */
export interface WarrantyTermsProvenance {
  source: 'contract' | 'operator_declared' | 'chemistry_default' | 'unspecified';
  isContractDerived: boolean;
  /** Sentence the UI can render verbatim under the terms panel. */
  label: string;
  /** Columns that came from the contract or the operator. */
  declaredFields?: string[];
  /** Columns still standing on the chemistry baseline. */
  defaultedFields?: string[];
}

export interface WarrantyStatusResponse {
  assetId: string;
  status: WarrantyStatus;
  healthScore: WarrantyHealthScore;
  terms: WarrantyTerms | null;
  termsProvenance?: WarrantyTermsProvenance;
  history: Array<{
    date: string;
    healthScore: number;
    soh: number;
    cyclesUsed: number;
  }>;
  metadata: {
    generatedAt: string;
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/warranty/violations
 * Active violations list
 */
export interface WarrantyViolationsResponse {
  assetId: string;
  violations: WarrantyViolation[];
  summary: {
    total: number;
    active: number;
    resolved: number;
    bySeverity: {
      warning: number;
      critical: number;
    };
    byType: Record<WarrantyViolationType, number>;
  };
  metadata: {
    generatedAt: string;
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/cycling
 * Cycling metrics and rainflow analysis
 */
export interface CyclingMetricsResponse {
  assetId: string;
  metrics: CyclingMetricsSummary;
  rainflowAnalysis: {
    totalCycles: number;
    dodDistribution: Array<{
      dodRange: string;
      count: number;
      percentage: number;
    }>;
    avgCycleDepth: number;
    deepCycleRatio: number;
  };
  sohHistory: SoHHistoryPoint[];
  capacityTests: CapacityTest[];
  metadata: {
    generatedAt: string;
    analysisMethod: string;
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/dispatch
 * Current dispatch schedule
 */
export interface DispatchScheduleResponse {
  assetId: string;
  schedule: DispatchSchedule | null;
  slots: DispatchSlot[];
  summary: {
    totalChargeKwh: number;
    totalDischargeKwh: number;
    expectedRevenueEur: number;
    degradationCostEur: number;
    netRevenueEur: number;
    expectedCycles: number;
  };
  arbitrageOpportunities: ArbitrageOpportunity[];
  metadata: {
    generatedAt: string;
    optimizerType: string;
    status: string;
  };
}

// ============================================================
// Hook Types
// ============================================================

/**
 * Return type for useBESSData hook
 */
export interface UseBESSDataReturn {
  assets: BessAssetInfo[] | null;
  selectedAsset: BessAssetInfo | null;
  assetOverview: BessAssetOverviewResponse | null;
  warrantyStatus: WarrantyStatusResponse | null;
  cyclingMetrics: CyclingMetricsResponse | null;
  dispatchSchedule: DispatchScheduleResponse | null;
  violations: WarrantyViolationsResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  selectAsset: (assetId: string) => void;
}

// ============================================================
// Component Props Types
// ============================================================

export interface BessSectionProps {
  plantId: string;
}

export interface WarrantyHealthCardProps {
  healthScore: WarrantyHealthScore | null;
  loading?: boolean;
}

export interface WarrantyViolationsTableProps {
  violations: WarrantyViolation[];
  loading?: boolean;
  onResolve?: (violationId: string) => void;
}

export interface SoHHistoryChartProps {
  data: SoHHistoryPoint[];
  capacityTests?: CapacityTest[];
  warrantyThreshold?: number;
  loading?: boolean;
  height?: number;
}

export interface CyclingMetricsCardProps {
  metrics: CyclingMetricsSummary | null;
  loading?: boolean;
}

export interface DispatchScheduleChartProps {
  schedule: DispatchSchedule | null;
  slots: DispatchSlot[];
  loading?: boolean;
  height?: number;
}

// ============================================================
// Helper Functions & Constants
// ============================================================

/**
 * Chemistry display names
 */
export const CHEMISTRY_NAMES: Record<BessChemistry, string> = {
  LFP: 'Lithium Iron Phosphate',
  NMC: 'Nickel Manganese Cobalt',
  NCA: 'Nickel Cobalt Aluminum',
  LTO: 'Lithium Titanate',
};

/**
 * Chemistry short names
 */
export const CHEMISTRY_SHORT_NAMES: Record<BessChemistry, string> = {
  LFP: 'LFP',
  NMC: 'NMC',
  NCA: 'NCA',
  LTO: 'LTO',
};

/**
 * Risk level colors
 */
export const RISK_LEVEL_COLORS: Record<WarrantyRiskLevel, string> = {
  LOW: '#10B981',      // Green
  MODERATE: '#F59E0B', // Amber
  HIGH: '#F97316',     // Orange
  CRITICAL: '#EF4444', // Red
};

/**
 * Violation type display names
 */
export const VIOLATION_TYPE_NAMES: Record<WarrantyViolationType, string> = {
  TEMPERATURE_EXCEED: 'Temperature Exceeded',
  SOC_HIGH_DWELL: 'High SoC Dwell',
  SOC_LOW_DWELL: 'Low SoC Dwell',
  CYCLING_DEPTH: 'Excessive Cycle Depth',
  CYCLING_FREQUENCY: 'Excessive Cycling',
  C_RATE_EXCEED: 'C-Rate Exceeded',
  VOLTAGE_VIOLATION: 'Voltage Violation',
  THROUGHPUT_EXCEED: 'Throughput Exceeded',
  HVAC_FAILURE: 'HVAC System Failure',
  RTE_DEGRADATION: 'Efficiency Degradation',
  CAPACITY_DEGRADATION: 'Capacity Degradation',
};

/**
 * Severity colors
 */
export const SEVERITY_COLORS: Record<ViolationSeverity, string> = {
  warning: '#F59E0B',  // Amber
  critical: '#EF4444', // Red
};

/**
 * Get risk level from health score
 */
export function getRiskLevelFromScore(score: number): WarrantyRiskLevel {
  if (score >= 80) return 'LOW';
  if (score >= 60) return 'MODERATE';
  if (score >= 40) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Get risk level color
 */
export function getRiskLevelColor(level: WarrantyRiskLevel): string {
  return RISK_LEVEL_COLORS[level] || RISK_LEVEL_COLORS.MODERATE;
}

/**
 * Format SoH as percentage
 */
export function formatSoH(soh: number): string {
  return `${(soh * 100).toFixed(1)}%`;
}

/**
 * Format SoC as percentage
 */
export function formatSoC(soc: number): string {
  return `${(soc * 100).toFixed(0)}%`;
}

/**
 * Format power in kW or MW
 */
export function formatPower(powerKw: number): string {
  if (Math.abs(powerKw) >= 1000) {
    return `${(powerKw / 1000).toFixed(1)} MW`;
  }
  return `${powerKw.toFixed(0)} kW`;
}

/**
 * Format energy in kWh or MWh
 */
export function formatEnergy(energyKwh: number): string {
  if (Math.abs(energyKwh) >= 1000) {
    return `${(energyKwh / 1000).toFixed(2)} MWh`;
  }
  return `${energyKwh.toFixed(0)} kWh`;
}

/**
 * Format currency
 */
export function formatCurrency(value: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-EU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Get health score category
 */
export function getHealthScoreCategory(score: number): {
  label: string;
  color: string;
} {
  if (score >= 80) return { label: 'Excellent', color: '#10B981' };
  if (score >= 60) return { label: 'Good', color: '#3B82F6' };
  if (score >= 40) return { label: 'Fair', color: '#F59E0B' };
  if (score >= 20) return { label: 'Poor', color: '#F97316' };
  return { label: 'Critical', color: '#EF4444' };
}
