/**
 * TypeScript interfaces for per-inverter soiling analysis data.
 * Matches JSON output from nuravolt.soiling.per_inverter_analysis
 */

// ============================================================
// Data Source Types (ML Integration)
// ============================================================

/**
 * Data source type for soiling intelligence
 * - sensor: DustIQ sensor measurements (ground truth)
 * - ml_model: ML model predictions (transfer learning)
 */
export type DataSourceType = 'sensor' | 'ml_model';

/**
 * ML model validation metrics
 * Provides transparency about model performance
 */
export interface MLValidationMetrics {
  mae: number;           // Mean Absolute Error
  rmse: number;          // Root Mean Squared Error
  r_squared: number;     // R² coefficient of determination
  bias: number;          // Systematic bias
  count: number;         // Number of validation samples
}

// ============================================================
// Per-Inverter Metrics
// ============================================================

export interface SoilingRatioStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  std: number;
}

export interface LossPercentages {
  soiling: number;
  temperature: number;
  spectral: number;
  inverter: number;
  wiringBop: number;
  degradation: number;
  total: number;
}

export interface EnergyValues {
  reference: number;
  net: number;
  soilingLoss: number;
}

export interface LossDisaggregation {
  method: string;
  percentages: LossPercentages;
  energy_kWh: EnergyValues;
}

export interface AnomalyPeriod {
  start: string;
  end: string;
  severity: 'Minor' | 'Major' | 'Critical';
  description?: string;
}

export interface AnomalyDetection {
  totalAnomalies: number;
  anomalyRate_pct: number;
  periods: AnomalyPeriod[];
}

export interface PerformanceMetrics {
  performanceRatio: number;
  avgPowerNormalized: number;
  capacityFactor: number;
  availability_pct: number;
  productionRate: number;
}

export interface FleetComparison {
  rank: number;
  deviationFromMean_pct: number;
  zScore: number;
  severity: 'Normal' | 'Minor' | 'Major' | 'Critical';
}

export interface DataQuality {
  completeness_pct: number;
  validRecords: number;
  totalRecords: number;
}

export interface Metadata {
  analysisStart: string;
  analysisEnd: string;
  generatedAt: string;
  method?: 'sensor' | 'ml_transfer_learning';  // Data source method
  foundationModel?: string;                     // Foundation model identifier (for ML)
}

export interface InverterSoilingMetrics {
  inverterId: string;
  groupId: string;
  soilingRatio: SoilingRatioStats;
  lossDisaggregation: LossDisaggregation;
  anomalyDetection: AnomalyDetection;
  performance: PerformanceMetrics;
  fleetComparison: FleetComparison;
  dataQuality: DataQuality;
  metadata: Metadata;
}

// ============================================================
// Fleet Summary
// ============================================================

export interface PlantInfo {
  plantId: string;
  plantName: string;
  capacity_MW: number;
  totalInverters: number;
  inverterGroups: string[];
}

export interface AnalysisPeriod {
  start: string;
  end: string;
  totalDays: number;
}

export interface FleetSoilingStats {
  srMean: number;
  srStd: number;
  srMin: number;
  srMax: number;
}

export interface FleetLosses {
  totalSoilingLoss_MWh: number;
  totalLoss_MWh: number;
  referenceEnergy_MWh: number;
  netEnergy_MWh: number;
}

export interface HealthDistribution {
  normal: number;
  minorIssues: number;
  majorIssues: number;
  critical: number;
}

export interface GroupMetrics {
  inverterCount: number;
  srMean: number;
  srStd: number;
  healthScore: number;
}

export interface InverterRanking {
  inverterId: string;
  srMean: number;
  rank: number;
}

export interface AnomalySummary {
  totalAnomalies: number;
  invertersWithAnomalies: number;
}

export interface EconomicImpact {
  estimatedAnnualLoss_EUR: number;
  cleaningROIPotential_EUR: number;
}

export interface FleetSummary {
  plantInfo: PlantInfo;
  analysisPeriod: AnalysisPeriod;
  fleetSoiling: FleetSoilingStats;
  fleetLosses: FleetLosses;
  healthDistribution: HealthDistribution;
  groupMetrics: Record<string, GroupMetrics>;
  topPerformers: InverterRanking[];
  worstPerformers: InverterRanking[];
  anomalySummary: AnomalySummary;
  economicImpact: EconomicImpact;
  generatedAt: string;
}

// ============================================================
// Time Series Data
// ============================================================

export interface DailySoilingRecord {
  date: string;
  inverterId: string;
  sr: number;
}

export interface DailySoilingData {
  data: DailySoilingRecord[];
}

// ============================================================
// ECharts Config Types
// ============================================================

export interface EChartsHeatmapConfig {
  title: {
    text: string;
    subtext?: string;
  };
  tooltip: object;
  xAxis: {
    type: string;
    data: string[];
  };
  yAxis: {
    type: string;
    data: string[];
  };
  visualMap: {
    min: number;
    max: number;
    inRange: {
      color: string[];
    };
  };
  series: Array<{
    type: string;
    data: Array<[number, number, number]>;
  }>;
}

export interface EChartsTimeseriesConfig {
  title: {
    text: string;
  };
  tooltip: object;
  legend: {
    data: string[];
  };
  xAxis: {
    type: string;
    data: string[];
  };
  yAxis: {
    type: string;
    name: string;
  };
  series: Array<{
    name: string;
    type: string;
    data: number[];
  }>;
}

export interface EChartsWaterfallConfig {
  title: {
    text: string;
  };
  tooltip: object;
  xAxis: {
    type: string;
    data: string[];
  };
  yAxis: {
    type: string;
    name: string;
  };
  series: Array<{
    type: string;
    stack: string;
    data: Array<number | '-'>;
    itemStyle?: {
      borderColor: string;
      color: string;
    };
  }>;
}

// ============================================================
// Component Props Types
// ============================================================

export interface SoilingDashboardProps {
  plantId?: string;
}

export interface SoilingHeatmapProps {
  data?: DailySoilingData;
  loading?: boolean;
  height?: number | string;
}

export interface SoilingTimeSeriesProps {
  inverterIds?: string[];
  showFleetAverage?: boolean;
  loading?: boolean;
  height?: number | string;
}

export interface LossWaterfallProps {
  inverterId?: string;
  loading?: boolean;
  height?: number | string;
}

export interface FleetSummaryCardProps {
  summary?: FleetSummary;
  loading?: boolean;
}

export interface InverterSelectorProps {
  inverters: string[];
  selectedInverters: string[];
  onSelectionChange: (selected: string[]) => void;
  maxSelection?: number;
}

// ============================================================
// Severity Helpers
// ============================================================

export const SEVERITY_COLORS: Record<FleetComparison['severity'], string> = {
  Normal: '#10B981',   // green
  Minor: '#F59E0B',    // yellow
  Major: '#F97316',    // orange
  Critical: '#EF4444', // red
};

export const SEVERITY_THRESHOLDS = {
  Minor: 1.5,    // z-score threshold
  Major: 2.0,
  Critical: 3.0,
};

export function getSeverityColor(severity: FleetComparison['severity']): string {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.Normal;
}

export function getHealthPercentage(distribution: HealthDistribution): number {
  const total = distribution.normal + distribution.minorIssues +
                distribution.majorIssues + distribution.critical;
  if (total === 0) return 100;
  return Math.round((distribution.normal / total) * 100);
}

// ============================================================
// API Response Types (New - Phase 2)
// ============================================================

/**
 * Plant Summary API Response
 * GET /api/soiling/plants/[plantId]/summary
 */
export interface PlantSummaryResponse {
  plantInfo: {
    plantId: string;
    plantName: string;
    capacity_MW: number;
    totalInverters: number;
  };
  currentStatus: {
    avgSoilingRatio: number;
    estimatedLossPct: number;
    lastUpdateTime: string;
    dataSource?: DataSourceType;            // Data source: 'sensor' or 'ml_model'
    validation?: MLValidationMetrics;       // ML model validation metrics (only for ML source)
  };
  fleetHealth: {
    normalInverters: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
  economicImpact: {
    ytdEnergyLoss_MWh: number;
    ytdRevenueLoss_EUR: number;
    nextCleaningRecommended: string | null;
    estimatedROI_pct: number;
    expectedNetBenefit_EUR: number;
    paybackDays: number;
  } | null;
  topPerformers: InverterRanking[];
  worstPerformers: InverterRanking[];
}

/**
 * Forecast API Response
 * GET /api/soiling/plants/[plantId]/forecast
 */
export interface ForecastDataPoint {
  date: string;
  soilingRatio: number;
  lowerBound: number;
  upperBound: number;
  soilingLossPct: number;
  cleaningRecommended: boolean;
  confidence: number;
}

export interface ForecastResponse {
  forecastPeriod: {
    start: string;
    end: string;
    days: number;
  };
  forecasts: ForecastDataPoint[];
  modelInfo: {
    type: string;
    version: string;
    lastTrainedAt: string;
  };
  statistics: {
    meanSoilingRatio: number;
    meanLossPct: number;
    cleaningsRecommended: number;
  };
}

/**
 * Cleaning Schedule API Response
 * GET /api/soiling/plants/[plantId]/cleaning-schedule
 */
export interface CleaningScenario {
  scenario?: string;
  dates: string[];
  nCleanings: number;
  netBenefit_EUR: number;
  roi_pct: number;
  paybackDays?: number;
  energyRecovered_MWh: number;
  revenueRecovered_EUR: number;
  cleaningCost_EUR: number;
  avgSoilingRatio?: number;
}

export interface CleaningScheduleResponse {
  plantId: string;
  validPeriod: {
    from: string;
    to: string;
  };
  optimal: CleaningScenario;
  alternatives: CleaningScenario[];
  recommendations: string[];
  technicalDetails: {
    avgSoilingRatioBaseline: number;
    avgSoilingRatioOptimized: number;
    avgLossBaseline_pct: number;
    avgLossOptimized_pct: number;
  };
}

/**
 * Per-Inverter API Response
 * GET /api/soiling/inverters/[inverterId]
 */
export interface InverterResponse {
  inverterId: string;
  groupId: string;
  soilingRatio: {
    current: number;
    mean: number;
    median: number;
    std: number;
    min: number;
    max: number;
  };
  lossDisaggregation: LossDisaggregation;
  performance: PerformanceMetrics;
  fleetComparison: {
    rank: number;
    totalInverters: number;
    deviationFromMean_pct: number;
    zScore: number;
    severity: FleetComparison['severity'];
  };
  anomalies: {
    total: number;
    rate_pct: number;
    recent: Array<{
      start: string;
      end: string;
      duration_hours: number;
      severity: AnomalyPeriod['severity'];
      type: string;
      deviation_pct: number;
    }>;
  };
  dataQuality: DataQuality;
  metadata: {
    analysisStart: string;
    analysisEnd: string;
    lastUpdated: string;
  };
}

// ============================================================
// Interactive Cleaning Schedule Types
// ============================================================

/**
 * Cleaning optimization parameters that users can adjust
 */
export interface CleaningParameters {
  // Economic parameters
  cleaning_cost_per_MW: number;
  electricity_rate_per_MWh: number;
  capacity_MW: number;

  // Operational constraints
  min_days_between_cleanings: number;
  rain_avoidance_days: number;
  rain_threshold_mm: number;

  // Soiling threshold
  cleaning_threshold_sr: number;
}

/**
 * Manual cleaning date constraint (user-specified or locked date)
 */
export interface ManualCleaningConstraint {
  date: string;
  locked: boolean;
  reason?: string;
}

/**
 * Optimization request payload
 * POST /api/soiling/plants/[plantId]/optimize
 */
export interface OptimizationRequest {
  plant_id: string;
  parameters: CleaningParameters;
  manual_cleaning_dates?: string[];
  locked_dates?: string[];
  mode: 'quick' | 'exhaustive';
  /** Override the mode's default min cleanings (≥1). Optional. */
  min_cleanings?: number;
  /** Override the mode's default max cleanings (≤26 — physical limit at 14d spacing). Optional. */
  max_cleanings?: number;
}

/**
 * Detailed cost/benefit result for a single cleaning schedule
 */
export interface CostBenefitResult {
  dates: string[];
  n_cleanings: number;
  energy_recovered_MWh: number;
  revenue_recovered_EUR: number;
  cleaning_cost_EUR: number;
  net_benefit_EUR: number;
  roi_pct: number;
  payback_days: number;
  avg_sr: number;
  avg_loss_pct: number;
}

/**
 * Optimization response from backend
 * POST /api/soiling/plants/[plantId]/optimize
 */
export interface OptimizationResponse {
  plant_id: string;
  parameters: CleaningParameters;
  optimal_schedule: CostBenefitResult;
  alternatives: CostBenefitResult[];
  comparison_table: Array<{
    n_cleanings: number;
    best_dates: string[];
    net_benefit_EUR: number;
    roi_pct: number;
  }>;
  execution_time_ms: number;
  /** True when the run used a live 16-day rain forecast for date avoidance. */
  rain_aware?: boolean;
  warnings?: string[];
}

/**
 * Digital twin forecast data point
 */
export interface DigitalTwinDataPoint {
  date: string;
  sr_predicted: number;
  soiling_loss_pct: number;
  energy_if_clean_MWh: number;
  energy_with_soiling_MWh: number;
  sun_hours: number;
  rainfall_mm?: number;
}

/**
 * Digital twin API response
 * GET /api/soiling/plants/[plantId]/digital-twin
 */
export interface DigitalTwinResponse {
  plant_id: string;
  capacity_MW: number;
  forecast_period: {
    start: string;
    end: string;
    days: number;
  };
  daily_forecasts: DigitalTwinDataPoint[];
  metadata: {
    generated_at: string;
    model_version: string;
    data_source?: string;
  };
}

/**
 * Live client-side cost/benefit calculation result
 */
export interface LiveCostBenefitResult {
  dates: string[];
  n_cleanings: number;
  total_cost_EUR: number;
  estimated_energy_recovered_MWh: number;
  estimated_revenue_recovered_EUR: number;
  estimated_net_benefit_EUR: number;
  estimated_roi_pct: number;
  avg_sr_without_cleaning: number;
  avg_sr_with_cleaning: number;
  calculation_method: 'client-side-estimate' | 'backend-optimized';
}

/**
 * Saved scenario for comparison
 */
export interface SavedScenario {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  parameters: CleaningParameters;
  result: CostBenefitResult | LiveCostBenefitResult;
  is_optimized: boolean;
}

/**
 * Constraint validation result for manual date placement
 */
export interface DateConstraintValidation {
  date: string;
  is_valid: boolean;
  violations: Array<{
    type: 'too_close' | 'rain_expected' | 'locked_conflict';
    message: string;
    severity: 'error' | 'warning';
  }>;
}

/**
 * Props for interactive cleaning schedule component
 */
export interface InteractiveCleaningScheduleProps {
  plantId: string;
  dataSource: DataSourceType;
  initialParameters?: Partial<CleaningParameters>;
  onOptimizationComplete?: (result: OptimizationResponse) => void;
}

// ============================================================
// Scenario Storage (Phase 1C)
// ============================================================

export interface SavedScenarioData {
  id: string;
  name: string;
  plantId: string;
  createdAt: string;
  updatedAt: string;
  cleaningDates: string[];
  lockedDates: string[];
  parameters: CleaningParameters;
  result: LiveCostBenefitResult;
  notes?: string;
}

export interface ScenarioComparison {
  scenarios: SavedScenarioData[];
  comparisonMetrics: {
    scenario_id: string;
    name: string;
    n_cleanings: number;
    net_benefit_EUR: number;
    roi_pct: number;
    energy_recovered_MWh: number;
    avg_sr: number;
  }[];
}

export interface MultiPlantComparison {
  plants: {
    plantId: string;
    plantName: string;
    scenario: SavedScenarioData;
  }[];
  aggregateMetrics: {
    total_cleanings: number;
    total_net_benefit_EUR: number;
    total_energy_recovered_MWh: number;
    avg_roi_pct: number;
  };
}

// ============================================================
// AOD-Based Monthly Soiling Rates (Phase 2 Enhancement)
// ============================================================

/**
 * Monthly soiling rate derived from AOD correlation
 */
export interface MonthlySoilingRate {
  month: string;                    // "2025-01" format (YYYY-MM)
  month_name: string;               // "January"
  aod_avg: number;                  // Average AOD at 550nm
  aod_dust_avg: number;             // Dust AOD component
  soiling_rate_per_day: number;     // Decimal rate (e.g., 0.0022)
  soiling_rate_pct_per_day: number; // Percentage rate (e.g., 0.22)
  seasonal_factor: number;          // Multiplier vs baseline (e.g., 0.73)
  confidence: number;               // 0-1 confidence score
  notes?: string;                   // Optional notes (e.g., "Wet season")
}

/**
 * AOD-to-soiling calibration coefficients
 */
export interface AODCalibration {
  intercept: number;                // Linear regression intercept
  slope: number;                    // Linear regression slope
  r_squared: number;                // R² goodness of fit
  data_points: number;              // Number of data points used
  calibration_date: string;         // When calibration was performed
}

/**
 * Complete monthly soiling rates data structure
 */
export interface MonthlySoilingRatesData {
  metadata: {
    plant_id: string;
    generated_at: string;
    data_source: string;
    base_soiling_rate_per_day: number;
    calibration_method: string;
  };
  calibration: AODCalibration;
  monthly_rates: MonthlySoilingRate[];
  aod_to_soiling_formula: {
    description: string;
    base_rate: number;
    aod_reference: number;
    min_rate: number;
    max_rate: number;
  };
}

/**
 * Daily SR projection data point (for trajectory calculations)
 */
export interface SRProjectionDataPoint {
  date: string;                           // "2025-01-15"
  dateFormatted: string;                  // "Jan 15"
  week: number;                           // ISO week number
  sr_without_cleaning: number;            // SR if no cleaning
  sr_with_cleaning: number;               // SR with cleaning schedule
  soiling_rate_applied: number;           // Variable rate for this day
  is_cleaning_day: boolean;               // True if cleaning occurs
  cumulative_energy_recovered_MWh: number;
  cumulative_net_benefit_EUR: number;
}

/**
 * Weekly aggregated data point (for visualization)
 */
export interface WeeklyDataPoint {
  week: number;                    // ISO week number
  weekLabel: string;               // "W1", "W2", etc.
  startDate: string;               // First day of week
  endDate: string;                 // Last day of week
  sr_without_avg: number;          // Average SR without cleaning
  sr_with_avg: number;             // Average SR with cleaning
  avg_soiling_rate: number;        // Average soiling rate
  has_cleaning: boolean;           // True if cleaning in this week
  cleaning_dates: string[];        // Cleaning dates in this week
  energy_recovered_MWh: number;    // Energy recovered this week
  revenue_recovered_EUR: number;   // Revenue recovered this week
}

// ============================================================
// Rain Data & Labeling (Phase 3 - Natural Cleaning Detection)
// ============================================================

/**
 * Daily rain/precipitation data point
 */
export interface RainDataPoint {
  date: string;                    // "2024-01-15" (YYYY-MM-DD)
  precipitation_mm: number;        // Daily precipitation in mm
  is_cleaning_event: boolean;      // >5mm threshold - natural cleaning
  is_heavy_rain: boolean;          // >10mm - very effective cleaning
}

/**
 * Rain event summary for visualization
 */
export interface RainCleaningEvent {
  date: string;
  amount_mm: number;
  type: 'moderate' | 'heavy';      // moderate: 5-10mm, heavy: >10mm
  expected_sr_recovery: number;    // Estimated SR improvement (e.g., 0.02-0.05)
}

/**
 * Complete rain history data structure
 */
export interface RainHistoryData {
  metadata: {
    plant_id: string;
    latitude: number;
    longitude: number;
    period: { start: string; end: string };
    source: string;                 // "Open-Meteo Historical Weather API"
    cleaning_threshold_mm: number;  // Default: 5.0
    generated_at: string;
  };
  daily_data: RainDataPoint[];
  cleaning_events: RainCleaningEvent[];
  statistics: {
    total_days: number;
    rain_days: number;              // Days with any precipitation
    cleaning_events_count: number;  // Days >5mm
    heavy_rain_count: number;       // Days >10mm
    avg_monthly_precipitation: number;
  };
}

/**
 * User-created data label/annotation
 */
/**
 * Available label types for data annotations
 */
export type LabelType = 'rain_cleaning' | 'dust_event' | 'manual_cleaning' | 'anomaly' | 'other';

export interface DataLabel {
  id: string;                       // UUID
  date: string;                     // "2024-01-15"
  type: LabelType;
  label: string;                    // Short description
  notes?: string;                   // Optional detailed notes
  createdAt: string;                // ISO timestamp
  createdBy?: string;               // Optional user identifier
}

/**
 * Labels storage file structure
 */
export interface LabelsData {
  metadata: {
    plant_id: string;
    version: number;
    last_updated: string;
  };
  labels: DataLabel[];
}

/**
 * Combined soiling analysis data (rain + SR + rate + labels)
 */
export interface SoilingAnalysisData {
  plantId: string;
  period: { start: string; end: string };
  rain: RainDataPoint[];
  soilingRatio: Array<{ date: string; value: number }>;
  soilingRate: Array<{ date: string; value: number }>;  // %/day
  labels: DataLabel[];
  cleaningEvents: RainCleaningEvent[];
}

/**
 * Label type metadata for UI rendering
 */
export const LABEL_TYPE_CONFIG = {
  rain_cleaning: { color: '#3B82F6', icon: '💧', label: 'Rain Cleaning' },
  dust_event: { color: '#92400E', icon: '🌫️', label: 'Dust Event' },
  manual_cleaning: { color: '#10B981', icon: '🧹', label: 'Manual Cleaning' },
  anomaly: { color: '#EF4444', icon: '⚠️', label: 'Anomaly' },
  other: { color: '#6B7280', icon: '📝', label: 'Other' },
} as const;

// ============================================================
// Data Quality Hub Types
// ============================================================

/**
 * Zone-level performance ratio data point
 */
export interface ZonePR {
  zoneId: string;           // "INV 01", "INV 02", etc.
  timestamp: string;        // ISO 8601
  performanceRatio: number; // 0.0 - 1.2
  inverterCount: number;    // Number of inverters in calculation
  onlineCount: number;      // Number of inverters online
}

/**
 * Spatial uniformity measurement at a single timestamp
 */
export interface UniformityMeasurement {
  timestamp: string;              // ISO 8601 or YYYY-MM-DD
  coefficientOfVariation: number; // CV across zones (0.0 - 1.0)
  isUniform: boolean;             // CV < threshold (e.g., 0.10)
  zonePRs: Record<string, number>; // Zone ID -> PR value
  highestZone: string;
  lowestZone: string;
  spread: number;                 // Max PR - Min PR
}

/**
 * Zone statistics aggregated over analysis period
 */
export interface ZoneStatistics {
  avgPR: number;
  stdPR: number;
  minPR: number;
  maxPR: number;
  highPerformancePct: number;     // Percentage of times this zone was highest
  lowPerformancePct: number;      // Percentage of times this zone was lowest
}

/**
 * Non-uniformity alert/event
 */
export interface UniformityAlert {
  id: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  avgCV: number;
  maxCV: number;
  affectedZones: string[];          // Zones with deviation
  likelyCause: 'partial_cloud' | 'localized_soiling' | 'sensor_issue' | 'unknown';
  severity: 'low' | 'medium' | 'high';
  description: string;
}

/**
 * Complete spatial uniformity data structure
 */
export interface SpatialUniformityData {
  metadata: {
    plantId: string;
    generatedAt: string;
    period: { start: string; end: string };
    zones: string[];
    cvThreshold: number;            // Default: 0.10
    measurementInterval: string;    // e.g., "15min" or "daily"
  };
  summary: {
    totalMeasurements: number;
    uniformMeasurements: number;
    nonUniformMeasurements: number;
    uniformityRate: number;         // Percentage uniform
    avgCV: number;
    maxCV: number;
    alertCount: number;
  };
  zoneStatistics: Record<string, ZoneStatistics>;
  timeSeries: UniformityMeasurement[];
  alerts: UniformityAlert[];
}

/**
 * Irradiance quality metrics between two sources
 */
export interface IrradianceQualityMetrics {
  correlation: number;              // Pearson correlation coefficient (-1 to 1)
  rmse: number;                     // Root Mean Square Error (W/m²)
  mae: number;                      // Mean Absolute Error (W/m²)
  bias: number;                     // Mean bias (W/m²), positive = on-site higher
  biasPct: number;                  // Bias as percentage
  r_squared: number;                // R-squared (0 to 1)
  sampleCount: number;              // Number of data points
}

/**
 * Irradiance comparison data point
 */
export interface IrradianceComparisonPoint {
  timestamp: string;
  onSite_Wm2: number;               // Measured GHI
  openMeteo_Wm2: number;            // Open-Meteo GHI
  difference_Wm2: number;           // on-site - openMeteo
  differencePct: number;            // Percentage difference
  qualityFlag: 'good' | 'suspect' | 'poor';
}

/**
 * Irradiance quality alert
 */
export interface IrradianceAlert {
  id: string;
  type: 'high_bias' | 'low_correlation' | 'sensor_degradation' | 'systematic_deviation';
  severity: 'low' | 'medium' | 'high';
  message: string;
  recommendation: string;
  period?: { start: string; end: string };
}

/**
 * Complete irradiance comparison data structure
 */
export interface IrradianceComparisonData {
  metadata: {
    plantId: string;
    generatedAt: string;
    period: { start: string; end: string };
    location: { latitude: number; longitude: number };
    onSiteSensorType: string;       // e.g., "Pyranometer", "Reference Cell"
    openMeteoSource: string;        // e.g., "ERA5", "ICON"
  };
  overallMetrics: IrradianceQualityMetrics;
  monthlyMetrics: Array<{
    month: string;                  // "2024-01"
    metrics: IrradianceQualityMetrics;
  }>;
  hourlyMetrics: Array<{
    hour: number;                   // 0-23
    metrics: IrradianceQualityMetrics;
  }>;
  alerts: IrradianceAlert[];
  scatterData: IrradianceComparisonPoint[];  // For scatter plot (sampled/aggregated)
}

/**
 * Correlation analysis between zone PR and irradiance source
 */
export interface ZoneCorrelation {
  zoneId: string;
  onSiteCorrelation: number;        // Correlation with on-site sensor
  openMeteoCorrelation: number;     // Correlation with Open-Meteo
  betterSource: 'on_site' | 'open_meteo' | 'similar';
  correlationDifference: number;    // Abs difference
  sampleCount: number;
}

/**
 * Correlation analysis for a specific condition
 */
export interface ConditionCorrelation {
  condition: string;                // e.g., "afternoon_partial_clouds"
  description: string;
  zoneCorrelations: ZoneCorrelation[];
  recommendation: string;
}

/**
 * Detected pattern in data source correlations
 */
export interface CorrelationPattern {
  id: string;
  pattern: string;                  // Description of the pattern
  frequency: number;                // How often this pattern occurs (0-1)
  confidence: number;               // Statistical confidence (0-1)
  affectedZones: string[];
  timeOfDay?: 'morning' | 'midday' | 'afternoon';
  seasonality?: 'spring' | 'summer' | 'autumn' | 'winter' | null;
}

/**
 * Complete data source correlation data structure
 */
export interface DataSourceCorrelationData {
  metadata: {
    plantId: string;
    generatedAt: string;
    period: { start: string; end: string };
    cvThreshold: number;            // Threshold for "non-uniform"
    minSampleSize: number;          // Minimum samples for valid correlation
  };
  overallAnalysis: {
    uniformPeriods: {
      count: number;
      zoneCorrelations: ZoneCorrelation[];
    };
    nonUniformPeriods: {
      count: number;
      zoneCorrelations: ZoneCorrelation[];
    };
  };
  conditionalAnalysis: ConditionCorrelation[];
  patterns: CorrelationPattern[];
  recommendations: string[];
}

/**
 * Props for DataQualitySection
 */
export interface DataQualitySectionProps {
  plantId: string;
}

/**
 * Props for SpatialUniformityChart
 */
export interface SpatialUniformityChartProps {
  data: SpatialUniformityData;
  height?: number;
  showAlerts?: boolean;
}

/**
 * Props for IrradianceQualityChart
 */
export interface IrradianceQualityChartProps {
  data: IrradianceComparisonData;
  height?: number;
  showScatter?: boolean;
}

/**
 * Props for DataSourceCorrelationCard
 */
export interface DataSourceCorrelationCardProps {
  data: DataSourceCorrelationData;
}

/**
 * Props for QualityAlertsPanel
 */
export interface QualityAlertsPanelProps {
  spatialAlerts?: UniformityAlert[];
  irradianceAlerts?: IrradianceAlert[];
  recommendations?: string[];
}

/**
 * Color configuration for quality severity levels
 */
export const QUALITY_SEVERITY_COLORS = {
  low: '#FBBF24',      // Yellow
  medium: '#F97316',   // Orange
  high: '#EF4444',     // Red
} as const;

/**
 * Color configuration for CV thresholds
 */
export const CV_THRESHOLD_COLORS = {
  uniform: '#10B981',      // Green (CV < 0.05)
  normal: '#3B82F6',       // Blue (CV 0.05-0.10)
  moderate: '#F97316',     // Orange (CV 0.10-0.20)
  high: '#EF4444',         // Red (CV > 0.20)
} as const;

/**
 * Helper function to get CV category and color
 */
export function getCVCategory(cv: number): { category: string; color: string; label: string } {
  if (cv < 0.05) return { category: 'uniform', color: CV_THRESHOLD_COLORS.uniform, label: 'Highly Uniform' };
  if (cv < 0.10) return { category: 'normal', color: CV_THRESHOLD_COLORS.normal, label: 'Normal' };
  if (cv < 0.20) return { category: 'moderate', color: CV_THRESHOLD_COLORS.moderate, label: 'Non-Uniform' };
  return { category: 'high', color: CV_THRESHOLD_COLORS.high, label: 'High Non-Uniformity' };
}

// ============================================================
// Forecast-Driven Optimization Types
// ============================================================

/**
 * Dust risk level based on AOD deviation from baseline
 */
export type DustRiskLevel = 'low' | 'normal' | 'elevated' | 'high';

/**
 * SOiling ratio timeline point with forecast-driven enhancements
 */
export interface SRTimelinePoint {
  sr: number;                    // Current soiling ratio (0.80-1.00)
  mlBaseline: number;            // ML predicted SR for this day
  isCleaning: boolean;           // True if cleaning occurs this day
  aodAdjustment?: number;        // AOD adjustment factor (0.5-1.5, default 1.0)
  dustRisk?: DustRiskLevel;      // Dust risk classification
  rainDeferralPenalty?: number;  // Penalty score for rain within window (-100 to 0)
  rainRecommendation?: string;   // Human-readable rain deferral recommendation
  rainCleaning?: boolean;        // True if natural rain cleaning occurred
}

/**
 * Parameters for forecast-driven cost/benefit calculation
 */
export interface ForecastDrivenParams {
  cleaningDates: string[];                     // YYYY-MM-DD format
  mlForecast: DigitalTwinDataPoint[];          // 365-day ML predictions
  aodForecast?: AODForecastPoint[];            // 5-day AOD forecast (optional)
  rainForecast?: RainForecastPoint[];          // 16-day rain forecast (optional)
  parameters: CleaningParameters;              // Economic and operational parameters
}

/**
 * Optimization forecasts container
 */
export interface OptimizationForecasts {
  ml: DigitalTwinDataPoint[];      // 365-day ML forecast
  aod?: AODForecastPoint[];        // 5-day AOD forecast
  rain?: RainForecastPoint[];      // 16-day rain forecast
  loaded_at: string;               // ISO timestamp when forecasts were loaded
}

// ============================================================
// SR Estimation Types (5-Layer Hierarchy)
// ============================================================

/**
 * SR Estimation Layer (hierarchical priority)
 * Lower layer = higher priority/confidence
 */
export type SREstimationLayerType = 1 | 2 | 3 | 4 | 5;

export const SR_ESTIMATION_LAYERS = {
  DUSTIQ: 1,          // Direct sensor measurement (95% confidence)
  SAME_PLANT_ML: 2,   // ML trained on plant's own DustIQ (85% confidence)
  TRANSFER: 3,        // Transfer learning from similar plant (75% confidence)
  FOUNDATION: 4,      // Global foundation model (65% confidence)
  DISAGGREGATION: 5,  // Physics-based loss disaggregation (55% confidence)
} as const;

export const SR_LAYER_NAMES: Record<SREstimationLayerType, string> = {
  1: 'DustIQ Sensor',
  2: 'Same-Plant ML',
  3: 'Transfer Learning',
  4: 'Foundation Model',
  5: 'Loss Disaggregation',
};

export const SR_LAYER_DESCRIPTIONS: Record<SREstimationLayerType, string> = {
  1: 'Direct measurement from DustIQ sensor',
  2: 'ML model trained on this plant\'s historical DustIQ data',
  3: 'ML model from a similar plant with DustIQ',
  4: 'Global model trained on all available DustIQ data',
  5: 'Physics-based decomposition of performance losses',
};

/**
 * Method availability status for a single estimation method
 */
export interface SRMethodAvailability {
  method: string;                    // 'dustiq' | 'same_plant_ml' | 'transfer' | 'foundation' | 'disaggregation'
  layer: SREstimationLayerType;
  available: boolean;
  confidence: number;                // 0-100
  reason: string;                    // Why available/unavailable
  data_days?: number;                // Days of training data available
  latest_data?: string;              // ISO date of latest data
  source_plant?: string;             // For transfer learning
  similarity_score?: number;         // For transfer learning (0-1)
}

/**
 * Result of auto-selecting the best method
 */
export interface SRMethodSelectionResult {
  selected_method: string;
  selected_layer: SREstimationLayerType;
  confidence: number;
  reason: string;
}

/**
 * Validation metrics for SR estimation
 */
export interface SRValidationMetrics {
  mae?: number;                      // Mean Absolute Error
  rmse?: number;                     // Root Mean Square Error
  r2?: number;                       // R-squared
  bias?: number;                     // Systematic bias
}

/**
 * SR data point in time series
 */
export interface SRDataPoint {
  date: string;                      // YYYY-MM-DD
  sr: number;                        // Soiling ratio 0-1
}

/**
 * Confidence data point in time series
 */
export interface SRConfidencePoint {
  date: string;                      // YYYY-MM-DD
  confidence: number;                // 0-100
}

/**
 * Complete SR estimation result
 */
export interface SREstimationResultData {
  success: boolean;
  plant_id: string;
  method: string;
  layer: SREstimationLayerType;
  layer_name: string;
  current_sr: number;                // Most recent SR value
  avg_sr: number;                    // Average SR over period
  avg_confidence: number;            // Average confidence
  estimated_loss_pct: number;        // Estimated energy loss %
  validation: SRValidationMetrics;
  source_plant?: string;             // For transfer learning
  metadata: Record<string, unknown>;
  data: {
    sr: SRDataPoint[];
    confidence: SRConfidencePoint[];
  };
  estimated_at: string;              // ISO timestamp
  error?: string;                    // Error message if success=false
}

// ============================================================
// SR Estimation API Response Types
// ============================================================

/**
 * GET /api/soiling/plants/[plantId]/methods
 * Returns available SR estimation methods for a plant
 */
export interface SRMethodsResponse {
  plant_id: string;
  selected_method: string;
  selected_layer: SREstimationLayerType;
  selected_confidence: number;
  selected_reason: string;
  methods: SRMethodAvailability[];
}

/**
 * GET/POST /api/soiling/plants/[plantId]/estimation
 * Returns SR estimation result
 */
export type SREstimationResponse = SREstimationResultData;

/**
 * Transfer learning configuration for a plant
 */
export interface SRTransferConfig {
  source_plant: string | null;       // Currently configured source plant
  auto_select: boolean;              // Whether auto-selection is enabled
  similarity_score?: number;         // Similarity to source plant (0-1)
  last_updated?: string;             // When config was last changed
}

/**
 * Ranked transfer source candidate
 */
export interface SRTransferSourceCandidate {
  plant_id: string;
  similarity_score: number;          // 0-1, higher is more similar
  has_dustiq: boolean;
  data_days: number;                 // Days of DustIQ data
  latest_data: string;               // ISO date
}

/**
 * GET /api/soiling/plants/[plantId]/transfer-config
 * Returns transfer learning configuration
 */
export interface SRTransferConfigResponse {
  plant_id: string;
  current_config: SRTransferConfig;
  ranked_sources: SRTransferSourceCandidate[];
}

/**
 * PUT /api/soiling/plants/[plantId]/transfer-config
 * Request body for setting transfer source
 */
export interface SRSetTransferSourceRequest {
  source_plant: string;
}

/**
 * PUT /api/soiling/plants/[plantId]/transfer-config
 * Response from setting transfer source
 */
export interface SRSetTransferSourceResponse {
  success: boolean;
  target_plant: string;
  source_plant: string;
  similarity_score: number;
  error?: string;
}

/**
 * GET /api/soiling/similarity
 * Returns plant similarity matrix
 */
export interface SRSimilarityResponse {
  plants: string[];                  // Plant IDs in order
  matrix: number[][];                // NxN similarity matrix
  dustiq_plants: string[];           // Plants with DustIQ sensors
}

// ============================================================
// SR Estimation UI Component Props
// ============================================================

/**
 * Props for MethodSelectorPanel component
 */
export interface MethodSelectorPanelProps {
  plantId: string;
  onMethodSelect?: (method: string) => void;
  showComparison?: boolean;
}

/**
 * Props for TransferPlantConfig component
 */
export interface TransferPlantConfigProps {
  plantId: string;
  onConfigChange?: (config: SRTransferConfig) => void;
}

/**
 * Props for MethodComparisonChart component
 */
export interface MethodComparisonChartProps {
  plantId: string;
  methods?: string[];                // Methods to compare (default: all available)
  height?: number;
}

/**
 * SR layer badge color mapping
 */
export const SR_LAYER_COLORS: Record<SREstimationLayerType, string> = {
  1: '#10B981',  // Green - DustIQ (highest confidence)
  2: '#3B82F6',  // Blue - Same-Plant ML
  3: '#8B5CF6',  // Purple - Transfer
  4: '#F59E0B',  // Amber - Foundation
  5: '#6B7280',  // Gray - Disaggregation (lowest confidence)
};

/**
 * Get confidence level category
 */
export function getConfidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 80) return 'high';
  if (confidence >= 60) return 'medium';
  return 'low';
}

/**
 * Get confidence color based on value
 */
export function getConfidenceColor(confidence: number): string {
  if (confidence >= 80) return '#10B981';  // Green
  if (confidence >= 60) return '#F59E0B';  // Amber
  return '#EF4444';                         // Red
}

// ============================================================
// Zone Analysis Types
// ============================================================

/**
 * Soiling zone definition
 */
export interface SoilingZoneConfig {
  zone_id: string;
  zone_name: string;
  inverter_pattern: string;  // Regex pattern
  inverter_count: number;
  /** Explicit member list; the zones API often only carries the pattern. */
  inverters?: string[];
  description?: string;
  avg_soiling_rate?: number;
  avg_sr?: number;
}

/**
 * Zone-level performance metrics
 */
export interface ZonePerformanceMetrics {
  zone_id: string;
  zone_name: string;
  avg_sr: number;
  min_sr: number;
  max_sr: number;
  std_sr: number;
  avg_loss_pct: number;
  inverter_count: number;
  data_points: number;
  health_score: number;  // 0-100
  cleaning_priority: 'low' | 'medium' | 'high' | 'critical';
  recommendation?: string;
}

/**
 * Complete zone analysis result
 */
export interface ZoneAnalysisData {
  success: boolean;
  plant_id: string;
  zones: SoilingZoneConfig[];
  performance: ZonePerformanceMetrics[];
  zone_comparison: Record<string, number>;  // zone_id -> relative performance
  cleaning_recommendations: string[];
  analyzed_at: string;
  data_period: {
    start: string;
    end: string;
  };
  error?: string;
}

/**
 * GET /api/soiling/plants/[plantId]/zones
 * Returns zone configuration and analysis
 */
export type ZoneAnalysisResponse = ZoneAnalysisData;

/**
 * POST /api/soiling/plants/[plantId]/zones
 * Save custom zone configuration
 */
export interface SaveZoneConfigRequest {
  zones: Array<{
    zone_id: string;
    zone_name: string;
    inverter_pattern: string;
    inverters?: string[];
    description?: string;
  }>;
}

export interface SaveZoneConfigResponse {
  success: boolean;
  saved: boolean;
  file?: string;
  error?: string;
}

// ============================================================
// Zone Analysis UI Component Props
// ============================================================

/**
 * Props for ZoneAnalysisTab component
 */
export interface ZoneAnalysisTabProps {
  plantId: string;
  className?: string;
}

/**
 * Props for ZonePerformanceGrid component
 */
export interface ZonePerformanceGridProps {
  zones: SoilingZoneConfig[];
  performance: ZonePerformanceMetrics[];
  onZoneSelect?: (zoneId: string) => void;
  selectedZoneId?: string;
}

/**
 * Zone cleaning priority colors
 */
export const ZONE_PRIORITY_COLORS: Record<ZonePerformanceMetrics['cleaning_priority'], string> = {
  low: '#10B981',      // Green
  medium: '#F59E0B',   // Amber
  high: '#F97316',     // Orange
  critical: '#EF4444', // Red
};

/**
 * Get zone health color
 */
export function getZoneHealthColor(healthScore: number): string {
  if (healthScore >= 80) return '#10B981';  // Green
  if (healthScore >= 60) return '#3B82F6';  // Blue
  if (healthScore >= 40) return '#F59E0B';  // Amber
  return '#EF4444';                          // Red
}

/**
 * Get zone health label
 */
export function getZoneHealthLabel(healthScore: number): string {
  if (healthScore >= 80) return 'Excellent';
  if (healthScore >= 60) return 'Good';
  if (healthScore >= 40) return 'Fair';
  return 'Poor';
}

// ============================================================
// Unified Cleaning Scheduler Types
// ============================================================

/**
 * Planning horizon for cleaning optimization
 */
export type CleaningHorizon = 30 | 90 | 365;

/**
 * Horizon metadata for UI display
 */
export interface HorizonInfo {
  days: CleaningHorizon;
  mode: 'Tactical' | 'Planning' | 'Strategic';
  focus: string;
  features: string[];
  confidence: string;
}

/**
 * All available horizons with descriptions
 */
export const HORIZON_INFO: Record<CleaningHorizon, HorizonInfo> = {
  30: {
    days: 30,
    mode: 'Tactical',
    focus: 'Weather-sensitive scheduling, urgent cleanings',
    features: [
      'Rain deferral (wait after forecasted rain)',
      'AOD avoidance (skip dusty periods)',
      'Urgent detection (SR < 90%)',
      'Crew availability (weekday preference)',
    ],
    confidence: 'High (short-term forecasts more accurate)',
  },
  90: {
    days: 90,
    mode: 'Planning',
    focus: 'Seasonal patterns, budget cycles',
    features: [
      'Seasonal SR pattern integration',
      'Budget-aware scheduling',
      'Zone-level optimization',
      'Weather forecast integration',
    ],
    confidence: 'Medium (moderate forecast uncertainty)',
  },
  365: {
    days: 365,
    mode: 'Strategic',
    focus: 'Annual ROI optimization',
    features: [
      'Summer peak prioritization (May-Sept)',
      'Multi-cleaning combination testing',
      'Annual budget allocation',
      'Long-term ROI optimization',
    ],
    confidence: 'Lower (long-term forecast uncertainty)',
  },
};

/**
 * Cleaning recommendation from optimizer
 */
export interface UnifiedCleaningRecommendation {
  date: string;
  zone_id?: string;
  zone_name?: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  expected_benefit_EUR: number;
  cleaning_cost_EUR: number;
  net_benefit_EUR: number;
  confidence: number;
  sr_before?: number;
  sr_after: number;
  reason: string;
  weather_risk?: string;
}

/**
 * Schedule result from unified optimizer
 */
export interface UnifiedScheduleResult {
  recommendations: UnifiedCleaningRecommendation[];
  summary: {
    total_benefit_EUR: number;
    total_cost_EUR: number;
    net_benefit_EUR: number;
    roi_pct: number;
    n_cleanings: number;
  };
  horizon_days: number;
  optimizer_type: 'short_term' | 'long_term' | 'zone' | 'unified';
  performance: {
    avg_sr_baseline: number;
    avg_sr_optimized: number;
    energy_recovered_MWh: number;
  };
  created_at: string;
  metadata: Record<string, unknown>;
}

/**
 * Zone-specific schedule result
 */
export interface ZoneScheduleData {
  zone_id: string;
  zone_name: string;
  schedule: UnifiedScheduleResult;
  zone_metrics: {
    avg_sr: number;
    avg_loss_pct: number;
    cleaning_priority: 'low' | 'medium' | 'high' | 'critical';
    inverter_count: number;
    soiling_rate: number;
    optimal_interval_days: number;
  };
}

/**
 * API response for unified cleaning optimization
 * POST /api/soiling/plants/[plantId]/cleaning/unified
 */
export interface UnifiedCleaningResponse {
  success: boolean;
  result: UnifiedScheduleResult;
  summary: {
    horizon_days: number;
    optimizer_type: string;
    n_cleanings: number;
    financial: {
      total_investment_EUR: number;
      expected_return_EUR: number;
      net_benefit_EUR: number;
      roi_pct: number;
      payback_days: number;
    };
    priority_breakdown: Record<string, {
      count: number;
      dates: string[];
    }>;
    top_recommendation?: {
      date: string;
      zone: string;
      priority: string;
      reason: string;
    };
    performance: {
      avg_sr_baseline: number;
      avg_sr_optimized: number;
      energy_recovered_MWh: number;
    };
  };
  error?: string;
}

/**
 * API response for zone schedules
 * POST /api/soiling/plants/[plantId]/cleaning/unified?zone_level=true
 */
export interface ZoneSchedulesResponse {
  success: boolean;
  zones: ZoneScheduleData[];
  n_zones: number;
  error?: string;
}

/**
 * API response for horizon comparison
 * GET /api/soiling/plants/[plantId]/cleaning/unified?command=compare_horizons
 */
export interface HorizonComparisonResponse {
  success: boolean;
  comparison: Record<string, {
    result: UnifiedScheduleResult;
    summary: UnifiedCleaningResponse['summary'];
  }>;
  error?: string;
}

// ============================================================
// Unified Scheduler UI Component Props
// ============================================================

/**
 * Props for HorizonSelector component
 */
export interface HorizonSelectorProps {
  value: CleaningHorizon;
  onChange: (horizon: CleaningHorizon) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Props for ZoneScheduleTable component
 */
export interface ZoneScheduleTableProps {
  zones: ZoneScheduleData[];
  onZoneSelect?: (zoneId: string) => void;
  selectedZoneId?: string;
  className?: string;
}

/**
 * Props for CleaningSchedulerTab component
 */
export interface CleaningSchedulerTabProps {
  plantId: string;
  className?: string;
}

/**
 * Priority colors for cleaning recommendations
 */
export const CLEANING_PRIORITY_COLORS: Record<UnifiedCleaningRecommendation['priority'], string> = {
  urgent: '#EF4444',  // Red
  high: '#F97316',    // Orange
  medium: '#F59E0B',  // Amber
  low: '#10B981',     // Green
};

/**
 * Get priority badge color
 */
export function getCleaningPriorityColor(priority: UnifiedCleaningRecommendation['priority']): string {
  return CLEANING_PRIORITY_COLORS[priority] || CLEANING_PRIORITY_COLORS.medium;
}

/**
 * Get horizon mode color
 */
export function getHorizonModeColor(mode: HorizonInfo['mode']): string {
  switch (mode) {
    case 'Tactical': return '#3B82F6';   // Blue
    case 'Planning': return '#8B5CF6';   // Purple
    case 'Strategic': return '#F59E0B';  // Amber
    default: return '#6B7280';
  }
}

// ============================================================
// Enhanced Data Quality Types (Multi-Sensor Support)
// ============================================================

/**
 * Quality class for data quality scoring
 */
export type DataQualityClass = 'excellent' | 'good' | 'fair' | 'poor';

/**
 * Recommendation level for sensors
 */
export type SensorRecommendation = 'primary' | 'backup' | 'monitor' | 'investigate';

/**
 * Trend direction for quality metrics
 */
export type QualityTrend = 'improving' | 'stable' | 'degrading';

/**
 * Individual radiation sensor configuration
 */
export interface RadiationSensor {
  id: string;
  name: string;
  type: 'pyranometer' | 'reference_cell' | 'satellite' | 'weather_station';
  isReference: boolean;
  location?: {
    latitude: number;
    longitude: number;
    tilt?: number;
    azimuth?: number;
  };
}

/**
 * Sensor-to-sensor correlation metrics
 */
export interface SensorCorrelation {
  sensor1Id: string;
  sensor2Id: string;
  correlation: number;
  rmse: number;
  mae: number;
  bias: number;
  biasPct: number;
  r_squared: number;
  sampleCount: number;
}

/**
 * Monthly sensor performance vs actual power
 */
export interface MonthlyPowerCorrelation {
  month: string;
  sensorId: string;
  correlationWithPower: number;
  predictedVsActualRMSE?: number;
  sampleCount: number;
}

/**
 * Quality score breakdown for a single sensor
 */
export interface SensorQualityScore {
  sensorId: string;
  overallScore: number;
  breakdown: {
    correlationScore: number;
    biasScore: number;
    consistencyScore: number;
    completenessScore: number;
    powerCorrelationScore: number;
  };
  qualityClass: DataQualityClass;
  recommendation: SensorRecommendation;
  issues: string[];
}

/**
 * Enhanced irradiance comparison with multi-sensor support
 */
export interface EnhancedIrradianceData {
  metadata: {
    plantId: string;
    generatedAt: string;
    period: { start: string; end: string };
    location: { latitude: number; longitude: number };
  };
  sensors: RadiationSensor[];
  correlationMatrix: SensorCorrelation[];
  monthlyPowerCorrelations: MonthlyPowerCorrelation[];
  qualityScores: SensorQualityScore[];
  recommendedSource: {
    sensorId: string;
    reason: string;
    confidence: number;
  };
  alerts: IrradianceQualityAlert[];
  // Legacy compatibility
  overallMetrics: IrradianceQualityMetrics;
  monthlyMetrics: Array<{ month: string; metrics: IrradianceQualityMetrics }>;
  scatterData?: IrradianceComparisonPoint[];
}

/**
 * Overall data health score with breakdown
 */
export interface DataHealthScore {
  overall: number;
  breakdown: {
    irradiance: number;
    spatial: number;
    completeness: number;
    consistency: number;
  };
  trend: QualityTrend;
  trendPct: number;
  lastChecked: string;
}

/**
 * Issue summary by category
 */
export interface QualityIssueSummary {
  category: 'irradiance' | 'spatial' | 'sensor' | 'data_gap';
  count: number;
  severity: 'high' | 'medium' | 'low';
  latestIssue?: string;
}

/**
 * Complete overview data structure
 */
export interface DataQualityOverview {
  healthScore: DataHealthScore;
  issues: QualityIssueSummary[];
  keyMetrics: {
    irradianceCorrelation: number;
    spatialUniformityRate: number;
    dataCompleteness: number;
    daysSinceLastCheck: number;
  };
  recommendations: string[];
}
