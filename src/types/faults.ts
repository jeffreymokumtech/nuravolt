/**
 * Fault Detection Types
 *
 * Types for reactive (current) and predictive (forecasted) fault detection.
 */

// Severity levels for reactive faults
export type FaultSeverity = 'critical' | 'warning' | 'info';

// Mode distinguishing reactive from predictive faults
export type FaultMode = 'reactive' | 'predictive';

// Urgency levels for predictive faults
export type FaultUrgency = 'urgent' | 'soon' | 'planned' | 'monitoring';

// Temporal status
export type FaultTemporalStatus = 'current' | 'historical';

// Reactive fault types (rule-based detection)
export type ReactiveFaultType =
  | 'inverter_offline'
  | 'inverter_clipping'
  | 'inverter_overtemperature'
  | 'inverter_efficiency_degradation'   // NEW v1.4
  | 'dc_link_capacitor_aging'           // NEW v1.4
  | 'dc_overvoltage'                    // NEW v1.4
  | 'dc_undervoltage'                   // NEW v1.4
  | 'inverter_cooling_degradation'      // NEW v1.4
  | 'string_open_circuit'
  | 'string_short_circuit'
  | 'string_mismatch_coarse'            // NEW v1.4
  | 'mppt_imbalance'                    // NEW v1.4
  | 'mppt_hunting'                      // NEW v1.4
  | 'dc_side_fault'                     // Classified DC-side issue
  | 'tracker_stuck'
  | 'tracker_misaligned'
  | 'grid_frequency_low'
  | 'grid_frequency_high'
  | 'grid_voltage_sag'
  | 'grid_voltage_swell'
  | 'grid_curtailment'                  // NEW v1.4
  | 'export_cap_active'                 // NEW v1.4
  | 'module_overtemperature'
  | 'module_current_degradation'        // NEW v1.4
  | 'module_voltage_drop'               // NEW v1.4
  | 'bypass_diode_active'               // NEW v1.4
  | 'communication_loss'
  | 'communication_fault'               // Classified communication issue
  | 'communication_partial'             // NEW v1.4
  | 'sensor_frozen'                     // NEW v1.4
  | 'irradiance_sensor_drift'           // NEW v1.4
  | 'soiling_detected'                  // NEW v1.4
  | 'vegetation_shading'                // NEW v1.4
  | 'insulation_resistance_low'         // NEW v1.4
  | 'unclassified_performance_loss'      // Digital twin residual loss (rest category)
  // BESS reactive fault types
  | 'bess_temperature_exceed'
  | 'bess_soc_dwell_high'
  | 'bess_soc_dwell_low'
  | 'bess_cycling_depth'
  | 'bess_c_rate_exceed'
  | 'bess_voltage_violation'
  | 'bess_hvac_failure'
  | 'bess_rte_degradation'
  | 'bess_capacity_degradation'
  | 'bess_cell_imbalance'
  | 'bess_bms_communication_loss';

// Predictive fault types (RUL model predictions)
export type PredictiveFaultType =
  | 'string_degradation'
  | 'module_degradation'
  | 'inverter_thermal'
  | 'thermal_hotspot'
  | 'mismatch'
  | 'bypass_diode'
  | 'insulation'
  // BESS predictive fault types
  | 'bess_capacity_fade'
  | 'bess_thermal_stress'
  | 'bess_cycle_life'
  | 'bess_rte_decay'
  | 'bess_cell_imbalance_trend';

// Asset type for distinguishing PV vs BESS faults
export type FaultAssetType = 'pv' | 'bess';

/**
 * Loss computation methodology metadata - explains how fault losses are calculated.
 */
export interface LossComputationMetadata {
  method: 'reactive_factor' | 'physics_model' | 'digital_twin' | 'rul_prediction';
  power_formula: string;
  energy_formula: string;
  factors: {
    rated_ac_power_kw?: number;
    n_strings?: number;
    loss_factor_pct?: number;
    affected_strings?: number;
    per_string_capacity_kw?: number;
    duration_hours?: number;
    rationale: string;
    [key: string]: any;
  };
  reference?: string;
}

/**
 * Reactive fault - currently happening, detected by rule-based thresholds.
 */
export interface ReactiveFault {
  id: string;
  fault_type: ReactiveFaultType;
  severity: FaultSeverity;
  asset_type?: FaultAssetType;
  equipment_id: string;
  equipment_name: string;
  timestamp_start: string;
  timestamp_end?: string | null;
  value: number | null;
  threshold: number | null;
  message: string;
  duration_minutes: number;
  power_loss_kw: number;
  energy_loss_kwh: number;
  // Human-readable detection rule explanation
  detection_rule?: string;
  // Loss computation methodology
  loss_computation?: LossComputationMetadata;
  // Ticket integration
  ticket_id?: string;
}

/**
 * Predictive fault - forecasted by RUL models.
 */
export interface PredictiveFault {
  id: string;
  fault_type: PredictiveFaultType;
  display_name: string;
  urgency: FaultUrgency;
  asset_type?: FaultAssetType;
  equipment_id: string;
  equipment_name: string;
  days_to_fault: number;
  confidence: number;
  current_value: number | null;
  threshold: number;
  unit: string;
  recommended_action: string;
  estimated_date: string | null;
  projected_power_loss_kw: number;
  projected_energy_loss_kwh: number;
  // Loss computation methodology
  loss_computation?: LossComputationMetadata;
  // Ticket integration
  ticket_id?: string;
}

/**
 * Union type for any fault
 */
export type Fault = ReactiveFault | PredictiveFault;

/**
 * Summary statistics for fault detection results.
 */
export interface FaultSummary {
  current_loss_kwh: number;
  projected_loss_kwh: number;
  current_loss_value: number;
  projected_loss_value: number;
  currency: string;
  reactive_count: number;
  predictive_count: number;
  critical_count: number;
  urgent_count: number;
}

/**
 * Complete fault detection response from API.
 */
export interface FaultDetectionResponse {
  plant_id: string;
  timestamp: string;
  summary: FaultSummary;
  reactive_faults: ReactiveFault[];
  predictive_faults: PredictiveFault[];
  error?: string;
}

/**
 * Request parameters for fault detection API.
 */
export interface FaultDetectionRequest {
  plant_id: string;
  data_source: string;
  currency?: string;
  electricity_price?: number;
  rated_dc_power_kw?: number;
  rated_ac_power_kw?: number;
  n_strings_per_inverter?: number;
}

/**
 * Sort field options for fault table.
 */
export type FaultSortField =
  | 'fault_type'
  | 'equipment_name'
  | 'severity'
  | 'urgency'
  | 'energy_loss'
  | 'power_loss'
  | 'date'
  | 'duration'
  | 'days_to_fault';

/**
 * Sort direction.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Sort configuration for fault table.
 */
export interface FaultSortConfig {
  field: FaultSortField;
  direction: SortDirection;
}

/**
 * Power loss range for filtering.
 */
export interface PowerLossRange {
  min?: number; // kWh
  max?: number; // kWh
}

/**
 * Filter options for fault table.
 */
export interface FaultFilters {
  mode?: FaultMode | 'all';
  severity?: FaultSeverity;
  urgency?: FaultUrgency;
  fault_type?: string;
  equipment_id?: string;
  group_id?: string;
  search?: string;
  status?: FaultTemporalStatus;
  // NEW: Power loss range filter
  powerLossRange?: PowerLossRange;
  // Asset type filter (PV vs BESS)
  asset_type?: 'pv' | 'bess';
}

/**
 * Type guard to check if a fault is reactive.
 */
export function isReactiveFault(fault: Fault): fault is ReactiveFault {
  return 'severity' in fault && 'duration_minutes' in fault;
}

/**
 * Type guard to check if a fault is predictive.
 */
export function isPredictiveFault(fault: Fault): fault is PredictiveFault {
  return 'urgency' in fault && 'days_to_fault' in fault;
}

/**
 * Display names for fault types.
 */
export const FAULT_TYPE_DISPLAY_NAMES: Record<string, string> = {
  // Reactive - Inverter/Power Conversion
  inverter_offline: 'Inverter Offline',
  inverter_clipping: 'Inverter Clipping',
  inverter_overtemperature: 'Inverter Overtemperature',
  inverter_efficiency_degradation: 'Inverter Efficiency Degradation',
  dc_link_capacitor_aging: 'DC-Link Capacitor Aging',
  dc_overvoltage: 'DC Overvoltage',
  dc_undervoltage: 'DC Undervoltage',
  inverter_cooling_degradation: 'Inverter Cooling Degradation',
  // Reactive - String/MPPT
  string_open_circuit: 'String Open Circuit',
  string_short_circuit: 'String Short Circuit',
  string_mismatch_coarse: 'String Mismatch (Coarse)',
  mppt_imbalance: 'MPPT Imbalance',
  mppt_hunting: 'MPPT Hunting/Instability',
  dc_side_fault: 'DC-Side Fault',
  // Reactive - Tracker
  tracker_stuck: 'Tracker Stuck',
  tracker_misaligned: 'Tracker Misaligned',
  // Reactive - Grid
  grid_frequency_low: 'Grid Frequency Low',
  grid_frequency_high: 'Grid Frequency High',
  grid_voltage_sag: 'Grid Voltage Sag',
  grid_voltage_swell: 'Grid Voltage Swell',
  grid_curtailment: 'Grid Curtailment',
  export_cap_active: 'Export Cap Active',
  // Reactive - Module
  module_overtemperature: 'Module Overtemperature',
  module_current_degradation: 'Module Current Degradation',
  module_voltage_drop: 'Module Voltage Drop',
  bypass_diode_active: 'Bypass Diode Active',
  // Reactive - Communication/Sensors
  communication_loss: 'Communication Loss',
  communication_fault: 'Communication Fault',
  communication_partial: 'Partial Communication Loss',
  sensor_frozen: 'Sensor Frozen',
  irradiance_sensor_drift: 'Irradiance Sensor Drift',
  // Reactive - Plant-Level Soft Faults
  soiling_detected: 'Soiling Detected',
  vegetation_shading: 'Vegetation Shading',
  insulation_resistance_low: 'Low Insulation Resistance',
  unclassified_performance_loss: 'Unclassified Performance Loss',
  // Predictive
  string_degradation: 'String Degradation',
  module_degradation: 'Module Degradation',
  inverter_thermal: 'Inverter Thermal Risk',
  thermal_hotspot: 'Thermal Hotspot',
  mismatch: 'String Mismatch',
  bypass_diode: 'Bypass Diode Failure',
  insulation: 'Insulation Degradation',
};

/**
 * Severity colors for UI.
 */
export const SEVERITY_COLORS: Record<FaultSeverity, string> = {
  critical: 'destructive',
  warning: 'warning',
  info: 'secondary',
};

/**
 * Urgency colors for UI.
 */
export const URGENCY_COLORS: Record<FaultUrgency, string> = {
  urgent: 'destructive',
  soon: 'warning',
  planned: 'default',
  monitoring: 'secondary',
};

// ============================================================================
// Enhanced Fault Detection Types (RUL, Health Score, Loss Disaggregation)
// ============================================================================

/**
 * RUL (Remaining Useful Life) Prediction from predictive maintenance models.
 * Extends PredictiveFault with maintenance cost/ROI data.
 */
export interface RULPrediction {
  fault_type: PredictiveFaultType;
  display_name: string;
  inverter_id: string;
  days_to_fault: number;
  confidence: number;
  current_value: number | null;
  threshold: number;
  unit: string;
  trend: number | null;
  is_urgent: boolean;
  urgency: FaultUrgency;
  recommended_action: string;
  repair_cost_eur: number;
  revenue_at_risk_eur: number;
}

/**
 * Health score status levels.
 */
export type HealthStatus = 'healthy' | 'attention_needed' | 'degraded' | 'critical';

/**
 * Health score trend direction.
 */
export type HealthTrend = 'improving' | 'stable' | 'degrading';

/**
 * Plant health score from predictive maintenance pipeline.
 */
export interface HealthScore {
  value: number; // 0-100
  status: HealthStatus;
  anomaly_penalty: number;
  fault_penalty: number;
  rul_penalty: number;
  trend: HealthTrend;
}

/**
 * Urgency category count with revenue at risk.
 */
export interface UrgencyCategory {
  count: number;
  total_revenue_at_risk_eur: number;
}

/**
 * Summary of RUL predictions grouped by urgency.
 */
export interface UrgencySummary {
  urgent: UrgencyCategory;   // < 3 days
  soon: UrgencyCategory;     // 3-7 days
  planned: UrgencyCategory;  // 7-30 days
  monitoring: UrgencyCategory; // > 30 days
}

/**
 * Individual loss component with kWh and percentage.
 */
export interface LossComponent {
  kwh: number;
  pct: number;
}

/**
 * IEA PVPS Task 13 compliant loss disaggregation.
 * Sequential subtraction method with 7 loss categories.
 */
export interface IEALossDisaggregation {
  reference_energy_kwh: number;
  net_energy_kwh: number;
  losses: {
    soiling: LossComponent;      // Controllable - panel dirt
    temperature: LossComponent;  // Weather-dependent - cell temp coefficient
    spectral: LossComponent;     // Weather-dependent - air mass effects
    inverter: LossComponent;     // Equipment - load-dependent efficiency
    wiring_bop: LossComponent;   // Fixed system - wiring losses (~2%)
    degradation: LossComponent;  // Time-dependent - annual degradation (~0.5%/yr)
    curtailment: LossComponent;  // External/grid - power limits
  };
}

/**
 * Scheduled maintenance task.
 */
export interface ScheduledTask {
  fault_type: string;
  inverter_id: string;
  priority_score: number;
}

/**
 * Daily maintenance schedule.
 */
export interface DailySchedule {
  date: string;
  tasks: ScheduledTask[];
}

/**
 * Maintenance schedule with ROI metrics.
 */
export interface MaintenanceSchedule {
  next_7_days: DailySchedule[];
  total_repair_cost_eur: number;
  total_revenue_saved_eur: number;
  roi_pct: number;
}

/**
 * Enhanced fault summary with urgency breakdown.
 */
export interface EnhancedFaultSummary extends FaultSummary {
  urgent_count: number;
  soon_count: number;
  planned_count: number;
  monitoring_count: number;
}

/**
 * Complete enhanced fault detection data structure.
 * Includes RUL predictions, health score, and IEA loss disaggregation.
 */
export interface EnhancedFaultData {
  plant_id: string;
  generated_at: string;
  summary: EnhancedFaultSummary;
  health_score: HealthScore;
  rul_predictions: RULPrediction[];
  urgency_summary: UrgencySummary;
  maintenance_schedule: MaintenanceSchedule;
  loss_disaggregation: IEALossDisaggregation;
  reactive_faults: ReactiveFault[];
  predictive_faults: PredictiveFault[];
}

/**
 * Health status colors for UI.
 */
export const HEALTH_STATUS_COLORS: Record<HealthStatus, string> = {
  healthy: 'emerald',
  attention_needed: 'yellow',
  degraded: 'orange',
  critical: 'red',
};

/**
 * Health status thresholds.
 */
export const HEALTH_STATUS_THRESHOLDS = {
  healthy: 80,
  attention_needed: 60,
  degraded: 40,
  critical: 0,
} as const;
