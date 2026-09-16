/**
 * Wind Power Plant Monitoring Types
 *
 * Type definitions for wind turbine monitoring, fault detection,
 * RUL prediction, and power curve analysis.
 */

// =============================================================================
// Enums & Constants
// =============================================================================

export type TurbineStatus =
  | 'OPERATING'
  | 'IDLE'
  | 'MAINTENANCE'
  | 'FAULT'
  | 'CURTAILED'
  | 'OFFLINE';

export type WindFaultCategory =
  | 'GEARBOX'
  | 'GENERATOR'
  | 'BLADE'
  | 'YAW'
  | 'MAIN_BEARING'
  | 'CONVERTER'
  | 'PITCH'
  | 'GRID';

export type WindFaultSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type WindComponent =
  | 'GEARBOX_BEARING'
  | 'GEARBOX_OIL'
  | 'GENERATOR_BEARING_DE'
  | 'GENERATOR_BEARING_NDE'
  | 'MAIN_BEARING'
  | 'PITCH_ACTUATOR'
  | 'YAW_MOTOR'
  | 'BLADE';

export type RULTrend = 'STABLE' | 'DEGRADING' | 'RAPID_DEGRADATION';

// =============================================================================
// Turbine & Plant Types
// =============================================================================

export interface WindTurbine {
  id: string;
  name: string;
  plantId: string;
  ratedPowerKw: number;
  hubHeightM: number;
  rotorDiameterM: number;
  manufacturer: string;
  model: string;
  commissionDate: string;
  latitude: number;
  longitude: number;
  enabled: boolean;
}

export interface WindPlantSummary {
  plantId: string;
  plantName: string;
  location: string;
  country: string;
  latitude: number;
  longitude: number;
  totalCapacityMw: number;
  turbineCount: number;
  turbineModel: string;
  commissioned: string;
  currentOutputMw: number;
  availability: number; // 0-1
  capacityFactor: number; // 0-1
  fleetHealthScore: number; // 0-100
  activeFaultCount: number;
  criticalAlertCount: number;
  lastUpdated: string;
}

export interface TurbineHealthSummary {
  turbineId: string;
  name: string;
  overallHealth: number; // 0-100
  availability: number; // 0-1
  capacityFactor: number; // 0-1
  activeFaults: number;
  lowestRUL: { component: WindComponent; days: number } | null;
  lastDataTimestamp: string;
  status: TurbineStatus;
}

// =============================================================================
// SCADA Data Types
// =============================================================================

export interface WindScadaPoint {
  timestamp: string;
  turbineId: string;
  windSpeed: number; // m/s
  windDirection: number; // degrees
  activePower: number; // kW
  reactivePower: number; // kVAR
  rotorRpm: number;
  generatorRpm: number;
  nacelleTemp: number; // °C
  gearboxOilTemp: number; // °C
  gearboxBearingTemp: number; // °C
  generatorBearingTempDE: number; // Drive End °C
  generatorBearingTempNDE: number; // Non-Drive End °C
  mainBearingTemp: number; // °C
  pitchAngle: number; // degrees
  yawAngle: number; // degrees
  ambientTemp: number; // °C
  availability: number; // 0-1
  gridFrequency: number; // Hz
  turbineStatus: TurbineStatus;
}

// =============================================================================
// Power Curve Types
// =============================================================================

export interface PowerCurvePoint {
  windSpeedBin: number; // center of bin (e.g., 5.5 m/s)
  expectedPower: number; // kW
  actualPower: number; // kW average
  stdDev: number;
  sampleCount: number;
}

export interface PowerCurveAnalysis {
  turbineId: string | null; // null for fleet-level
  plantId: string;
  period: { start: string; end: string };
  binWidth: number; // m/s
  cutInSpeed: number;
  ratedSpeed: number;
  cutOutSpeed: number;
  ratedPower: number;
  points: PowerCurvePoint[];
  performanceIndex: number; // 0-1+, actual vs expected energy
  anomalyScore: number; // 0-1
  lastUpdated: string;
}

// =============================================================================
// Fault Types
// =============================================================================

export interface WindFaultType {
  id: string;
  category: WindFaultCategory;
  code: string;
  name: string;
  description: string;
  severity: WindFaultSeverity;
  indicators: string[];
  thresholds: Record<string, number>;
}

export interface WindFaultEvidence {
  indicator: string;
  value: number;
  threshold: number;
  deviation: number; // percentage above/below normal
  timestamp: string;
}

export interface WindFault {
  id: string;
  turbineId: string;
  plantId: string;
  faultType: WindFaultType;
  detectedAt: string;
  resolvedAt?: string;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  confidence: number;
  evidence: WindFaultEvidence[];
  estimatedImpact: {
    lostEnergyKwh: number;
    repairCostUsd: number;
    downtimeHours: number;
  };
  // CARE dataset support (optional for backwards compatibility)
  source?: FaultSource;
  labeledEventId?: string;
  leadTimeDays?: number;
  detectionMethod?: DetectionMethod;
}

// =============================================================================
// RUL (Remaining Useful Life) Types
// =============================================================================

export interface WindComponentRUL {
  turbineId: string;
  component: WindComponent;
  componentName: string;
  estimatedRUL: number; // days
  confidence: number; // 0-1
  healthScore: number; // 0-100
  degradationRate: number; // per day
  lastUpdated: string;
  modelVersion: string;
  inputFeatures: Record<string, number>;
  trend: RULTrend;
  isUrgent: boolean; // true if < 30 days
}

// =============================================================================
// API Response Types
// =============================================================================

export interface WindPlantResponse {
  plant: WindPlantSummary;
}

export interface WindTurbinesResponse {
  turbines: (WindTurbine & { health: TurbineHealthSummary | null })[];
  count: number;
}

export interface PowerCurveResponse {
  analysis: PowerCurveAnalysis;
}

export interface WindFaultsResponse {
  faults: WindFault[];
  total: number;
}

export interface WindRULResponse {
  predictions: WindComponentRUL[];
  criticalCount: number;
}

export interface WindDashboardResponse {
  plant: WindPlantSummary;
  turbines: TurbineHealthSummary[];
  activeFaults: WindFault[];
  criticalRUL: WindComponentRUL[];
  powerCurve: PowerCurveAnalysis | null;
}

// =============================================================================
// Helper Functions
// =============================================================================

export function getStatusColor(status: TurbineStatus): string {
  switch (status) {
    case 'OPERATING':
      return '#22c55e'; // green
    case 'IDLE':
      return '#6b7280'; // gray
    case 'MAINTENANCE':
      return '#3b82f6'; // blue
    case 'FAULT':
      return '#ef4444'; // red
    case 'CURTAILED':
      return '#f59e0b'; // amber
    case 'OFFLINE':
      return '#374151'; // dark gray
    default:
      return '#6b7280';
  }
}

export function getHealthColor(health: number): string {
  if (health >= 90) return '#22c55e'; // green
  if (health >= 75) return '#84cc16'; // lime
  if (health >= 60) return '#eab308'; // yellow
  if (health >= 40) return '#f97316'; // orange
  return '#ef4444'; // red
}

export function getSeverityColor(severity: WindFaultSeverity): string {
  switch (severity) {
    case 'CRITICAL':
      return '#dc2626'; // red-600
    case 'HIGH':
      return '#ea580c'; // orange-600
    case 'MEDIUM':
      return '#ca8a04'; // yellow-600
    case 'LOW':
      return '#2563eb'; // blue-600
    default:
      return '#6b7280';
  }
}

export function getCategoryIcon(category: WindFaultCategory): string {
  switch (category) {
    case 'GEARBOX':
      return 'cog';
    case 'GENERATOR':
      return 'zap';
    case 'BLADE':
      return 'wind';
    case 'YAW':
      return 'compass';
    case 'MAIN_BEARING':
      return 'circle';
    case 'CONVERTER':
      return 'activity';
    case 'PITCH':
      return 'sliders';
    case 'GRID':
      return 'grid';
    default:
      return 'alert-triangle';
  }
}

export function formatPower(powerKw: number): string {
  if (powerKw >= 1000) {
    return `${(powerKw / 1000).toFixed(1)} MW`;
  }
  return `${powerKw.toFixed(0)} kW`;
}

export function formatWindSpeed(speed: number): string {
  return `${speed.toFixed(1)} m/s`;
}

export function formatRUL(days: number): string {
  if (days < 7) {
    return `${days.toFixed(0)} days`;
  }
  if (days < 30) {
    return `${Math.round(days / 7)} weeks`;
  }
  if (days < 365) {
    return `${Math.round(days / 30)} months`;
  }
  return `${(days / 365).toFixed(1)} years`;
}

export function getComponentDisplayName(component: WindComponent): string {
  const names: Record<WindComponent, string> = {
    GEARBOX_BEARING: 'Gearbox Bearing',
    GEARBOX_OIL: 'Gearbox Oil',
    GENERATOR_BEARING_DE: 'Generator Bearing (DE)',
    GENERATOR_BEARING_NDE: 'Generator Bearing (NDE)',
    MAIN_BEARING: 'Main Bearing',
    PITCH_ACTUATOR: 'Pitch Actuator',
    YAW_MOTOR: 'Yaw Motor',
    BLADE: 'Blade',
  };
  return names[component] || component;
}

// =============================================================================
// Fault Type Registry
// =============================================================================

// =============================================================================
// CARE Dataset / Labeled Fault Types
// =============================================================================

/**
 * Source of fault detection - distinguishes ground-truth labeled events
 * from ML-detected anomalies
 */
export type FaultSource = 'LABELED' | 'DETECTED';

/**
 * Detection method for ML-detected faults
 */
export type DetectionMethod = 'NBM' | 'POWER_CURVE' | 'THRESHOLD' | 'ANOMALY_DETECTION';

/**
 * CARE dataset metadata for labeled events
 */
export interface CAREMetadata {
  farm: 'A' | 'B' | 'C';
  features: number;
  durationDays: number;
}

/**
 * A labeled fault event from the CARE dataset with ground-truth metadata
 */
export interface LabeledFaultEvent {
  id: string;
  datasetId: string;
  turbineId: string;
  faultType: WindFaultType;
  eventStart: string;
  eventEnd: string;
  description: string;
  careMetadata: CAREMetadata;
}

/**
 * Extended WindFault with CARE dataset support
 * Adds source tracking, lead time analysis, and detection method
 */
export interface WindFaultWithSource extends WindFault {
  /** Whether this fault is from labeled ground-truth or ML detection */
  source: FaultSource;
  /** ID of the corresponding labeled event (if this is a DETECTED fault that maps to a labeled one) */
  labeledEventId?: string;
  /** Days before the labeled failure that this fault was detected (for DETECTED faults) */
  leadTimeDays?: number;
  /** Detection method used (for DETECTED faults) */
  detectionMethod?: DetectionMethod;
}

// =============================================================================
// SCADA Time-Series Types
// =============================================================================

/**
 * Request parameters for SCADA time-series data
 */
export interface ScadaQueryParams {
  turbineId: string;
  start: string;
  end: string;
  resolution?: '10min' | 'hourly' | 'daily';
  signals?: string[];
}

/**
 * SCADA time-series response with metadata
 */
export interface ScadaTimeSeriesResponse {
  turbineId: string;
  plantId: string;
  period: { start: string; end: string };
  resolution: string;
  points: WindScadaPoint[];
  signals: string[];
  labeledEvents?: LabeledFaultEvent[];
  anomalyHighlights?: Array<{
    start: string;
    end: string;
    signal: string;
    zScore: number;
  }>;
}

/**
 * Response type for labeled events endpoint
 */
export interface LabeledEventsResponse {
  events: LabeledFaultEvent[];
  total: number;
  byCategory: Record<WindFaultCategory, number>;
  bySeverity: Record<WindFaultSeverity, number>;
}

/**
 * Extended faults response with source breakdown
 */
export interface WindFaultsWithSourceResponse {
  faults: WindFaultWithSource[];
  total: number;
  summary: {
    bySource: {
      LABELED: number;
      DETECTED: number;
    };
    avgLeadTimeDays: number | null;
    detectionRate: number;
  };
}

// =============================================================================
// Helper Functions for Labeled Faults
// =============================================================================

export function getFaultSourceLabel(source: FaultSource): string {
  return source === 'LABELED' ? 'Ground Truth' : 'ML Detected';
}

export function getFaultSourceColor(source: FaultSource): string {
  return source === 'LABELED' ? '#8b5cf6' : '#3b82f6'; // purple for labeled, blue for detected
}

export function formatLeadTime(days: number | undefined): string {
  if (days === undefined || days === null) return 'N/A';
  if (days === 0) return 'Same day';
  if (days === 1) return '1 day early';
  if (days < 7) return `${days} days early`;
  if (days < 30) return `${Math.round(days / 7)} weeks early`;
  return `${Math.round(days / 30)} months early`;
}

// =============================================================================
// Fault Type Registry
// =============================================================================

export const WIND_FAULT_TYPES: Record<string, WindFaultType> = {
  // Gearbox faults
  GB001: {
    id: 'GB001',
    category: 'GEARBOX',
    code: 'GB001',
    name: 'Gearbox Bearing Overtemperature',
    description: 'Gearbox bearing temperature exceeds normal operating range',
    severity: 'HIGH',
    indicators: ['gearbox_bearing_temp', 'gearbox_oil_temp'],
    thresholds: { gearbox_bearing_temp_max: 85, temp_rise_rate: 5 },
  },
  GB002: {
    id: 'GB002',
    category: 'GEARBOX',
    code: 'GB002',
    name: 'Gearbox Oil Degradation',
    description: 'Gearbox oil temperature pattern indicates degraded lubricant',
    severity: 'MEDIUM',
    indicators: ['gearbox_oil_temp', 'ambient_temp'],
    thresholds: { oil_temp_delta_max: 45 },
  },
  GB003: {
    id: 'GB003',
    category: 'GEARBOX',
    code: 'GB003',
    name: 'Gearbox Gear Tooth Damage',
    description: 'Abnormal power-temperature relationship suggests gear damage',
    severity: 'CRITICAL',
    indicators: ['gearbox_bearing_temp', 'active_power', 'rotor_rpm'],
    thresholds: { power_temp_correlation_min: 0.3 },
  },

  // Generator faults
  GN001: {
    id: 'GN001',
    category: 'GENERATOR',
    code: 'GN001',
    name: 'Generator Bearing DE Overtemperature',
    description: 'Drive-end generator bearing temperature anomaly',
    severity: 'HIGH',
    indicators: ['generator_bearing_temp_de', 'generator_rpm'],
    thresholds: { generator_bearing_temp_de_max: 95 },
  },
  GN002: {
    id: 'GN002',
    category: 'GENERATOR',
    code: 'GN002',
    name: 'Generator Bearing NDE Overtemperature',
    description: 'Non-drive-end generator bearing temperature anomaly',
    severity: 'HIGH',
    indicators: ['generator_bearing_temp_nde', 'generator_rpm'],
    thresholds: { generator_bearing_temp_nde_max: 90 },
  },
  GN003: {
    id: 'GN003',
    category: 'GENERATOR',
    code: 'GN003',
    name: 'Generator Winding Temperature Anomaly',
    description: 'Generator winding temperature exceeds safe limits',
    severity: 'CRITICAL',
    indicators: ['generator_winding_temp', 'active_power'],
    thresholds: { generator_winding_temp_max: 155 },
  },

  // Blade/Pitch faults
  BL001: {
    id: 'BL001',
    category: 'PITCH',
    code: 'BL001',
    name: 'Pitch System Malfunction',
    description: 'Pitch angle does not respond correctly to wind conditions',
    severity: 'HIGH',
    indicators: ['pitch_angle', 'wind_speed', 'active_power'],
    thresholds: { pitch_deviation_max: 5 },
  },
  BL002: {
    id: 'BL002',
    category: 'BLADE',
    code: 'BL002',
    name: 'Blade Icing Detected',
    description: 'Power output significantly below expected, suggesting icing',
    severity: 'MEDIUM',
    indicators: ['active_power', 'wind_speed', 'ambient_temp'],
    thresholds: { power_deficit_pct: 20, ambient_temp_max: 3 },
  },
  BL003: {
    id: 'BL003',
    category: 'BLADE',
    code: 'BL003',
    name: 'Blade Imbalance',
    description: 'Rotor imbalance detected through power/rpm fluctuations',
    severity: 'HIGH',
    indicators: ['rotor_rpm', 'active_power'],
    thresholds: { rpm_variance_max: 2.0 },
  },

  // Yaw faults
  YW001: {
    id: 'YW001',
    category: 'YAW',
    code: 'YW001',
    name: 'Yaw Misalignment',
    description: 'Nacelle not properly aligned with wind direction',
    severity: 'MEDIUM',
    indicators: ['yaw_angle', 'wind_direction', 'active_power'],
    thresholds: { yaw_error_max: 15 },
  },
  YW002: {
    id: 'YW002',
    category: 'YAW',
    code: 'YW002',
    name: 'Yaw Motor Failure',
    description: 'Yaw system not responding to wind direction changes',
    severity: 'HIGH',
    indicators: ['yaw_angle', 'wind_direction'],
    thresholds: { yaw_response_time_max: 300 },
  },

  // Main bearing faults
  MB001: {
    id: 'MB001',
    category: 'MAIN_BEARING',
    code: 'MB001',
    name: 'Main Bearing Overtemperature',
    description: 'Main shaft bearing temperature exceeds normal range',
    severity: 'CRITICAL',
    indicators: ['main_bearing_temp', 'rotor_rpm'],
    thresholds: { main_bearing_temp_max: 70 },
  },

  // Converter/Grid faults
  CV001: {
    id: 'CV001',
    category: 'CONVERTER',
    code: 'CV001',
    name: 'Converter Overtemperature',
    description: 'Power converter temperature exceeds limits',
    severity: 'HIGH',
    indicators: ['converter_temp', 'active_power'],
    thresholds: { converter_temp_max: 65 },
  },
  GR001: {
    id: 'GR001',
    category: 'GRID',
    code: 'GR001',
    name: 'Grid Frequency Deviation',
    description: 'Grid frequency outside acceptable range',
    severity: 'MEDIUM',
    indicators: ['grid_frequency'],
    thresholds: { grid_frequency_min: 49.5, grid_frequency_max: 50.5 },
  },
};
