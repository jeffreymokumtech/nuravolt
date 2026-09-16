/**
 * Field Mapping Intelligence Service
 *
 * AI-assisted field mapping with confidence scoring for auto-detecting
 * column mappings from diverse SCADA systems with minimal user input.
 */

import { DataFieldType } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

export interface FieldPattern {
  regex: RegExp;
  fieldType: DataFieldType;
  baseConfidence: number;
  unit?: string;
  scalingFactor?: number;
  validationRules?: { min?: number; max?: number };
  description?: string;
}

export interface FieldMappingResult {
  originalField: string;
  mappedType: DataFieldType;
  confidence: number;
  unit?: string;
  scalingFactor?: number;
  offset?: number;
  validationRules?: { min?: number; max?: number };
  sampleValues?: any[];
  detectedUnit?: string;
  confidenceFactors?: ConfidenceFactors;
}

export interface ConfidenceFactors {
  patternMatch: number;
  unitMatch: number;
  valueRange: number;
  uniqueness: number;
}

export interface HierarchyPattern {
  vendor: string;
  pattern: RegExp;
  extractors: {
    plant?: number;
    group?: number;
    inverter?: number;
    string?: number;
    field?: number;
  };
  description: string;
}

export interface DetectedHierarchy {
  pattern: HierarchyPattern | null;
  plants: string[];
  groups: Map<string, string[]>;  // plant -> groups
  inverters: Map<string, string[]>;  // plant or group -> inverters
  hierarchyString?: string;
}

export interface TimestampFormat {
  name: string;
  regex: RegExp;
  strptime: string;  // Python strptime format
  jsFormat?: string;  // JavaScript date format
}

export interface TimestampDetectionResult {
  column: string;
  format: TimestampFormat;
  confidence: number;
  sampleParsed?: Date[];
}

export interface ColumnStatistics {
  column: string;
  type: 'numeric' | 'string' | 'datetime' | 'boolean' | 'unknown';
  count: number;
  nullCount: number;
  uniqueCount: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  sampleValues: any[];
}

export interface DataStructureResult {
  format: 'wide' | 'long' | 'mixed';  // wide = one column per inverter, long = inverter_id column, mixed = unclear
  timestampColumn?: string;
  timestampFormat?: TimestampFormat;
  columns: ColumnStatistics[];
  hierarchy?: DetectedHierarchy;
  fieldMappings: FieldMappingResult[];
  qualityScore: number;
  recommendations: string[];
}

// ============================================================================
// Pattern Libraries
// ============================================================================

/**
 * Comprehensive field patterns for auto-detection
 * Patterns are ordered by specificity (most specific first)
 */
export const FIELD_PATTERNS: FieldPattern[] = [
  // ========== Power AC (high confidence patterns) ==========
  { regex: /inverter[_\s]?power[_\s]?normalized/i, fieldType: 'power_ac', baseConfidence: 0.98, unit: 'kW/kWp', description: 'Normalized inverter power' },
  { regex: /power[_\s]?ac[_\s]?(?:output)?/i, fieldType: 'power_ac', baseConfidence: 0.95, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /pac\s*\(?kw\)?/i, fieldType: 'power_ac', baseConfidence: 0.95, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /active[_\s]?power/i, fieldType: 'power_ac', baseConfidence: 0.92, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /p[_\s]?ac(?![a-z])/i, fieldType: 'power_ac', baseConfidence: 0.90, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /output[_\s]?power/i, fieldType: 'power_ac', baseConfidence: 0.85, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /grid[_\s]?power/i, fieldType: 'power_ac', baseConfidence: 0.85, unit: 'kW', validationRules: { min: 0, max: 50000 } },

  // ========== Power DC ==========
  { regex: /power[_\s]?dc/i, fieldType: 'power_dc', baseConfidence: 0.95, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /pdc\s*\(?kw\)?/i, fieldType: 'power_dc', baseConfidence: 0.95, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /dc[_\s]?power/i, fieldType: 'power_dc', baseConfidence: 0.92, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /p[_\s]?dc(?![a-z])/i, fieldType: 'power_dc', baseConfidence: 0.90, unit: 'kW', validationRules: { min: 0, max: 50000 } },
  { regex: /input[_\s]?power/i, fieldType: 'power_dc', baseConfidence: 0.80, unit: 'kW', validationRules: { min: 0, max: 50000 } },

  // ========== Reactive Power ==========
  { regex: /reactive[_\s]?power/i, fieldType: 'reactive_power', baseConfidence: 0.95, unit: 'kVAr', validationRules: { min: -50000, max: 50000 } },
  { regex: /q[_\s]?(?:ac)?(?![a-z])/i, fieldType: 'reactive_power', baseConfidence: 0.75, unit: 'kVAr' },

  // ========== Voltage DC ==========
  { regex: /voltage[_\s]?dc/i, fieldType: 'voltage_dc', baseConfidence: 0.95, unit: 'V', validationRules: { min: 0, max: 2000 } },
  { regex: /u[_\s]?dc[_\s]?\d*/i, fieldType: 'voltage_dc', baseConfidence: 0.92, unit: 'V', validationRules: { min: 0, max: 2000 } },
  { regex: /v[_\s]?dc/i, fieldType: 'voltage_dc', baseConfidence: 0.90, unit: 'V', validationRules: { min: 0, max: 2000 } },
  { regex: /dc[_\s]?voltage/i, fieldType: 'voltage_dc', baseConfidence: 0.90, unit: 'V', validationRules: { min: 0, max: 2000 } },
  { regex: /mppt[_\s]?\d*[_\s]?voltage/i, fieldType: 'voltage_dc', baseConfidence: 0.88, unit: 'V', validationRules: { min: 0, max: 2000 } },
  { regex: /string[_\s]?\d*[_\s]?voltage/i, fieldType: 'voltage_dc', baseConfidence: 0.85, unit: 'V', validationRules: { min: 0, max: 2000 } },

  // ========== Voltage AC (3-phase) ==========
  { regex: /voltage[_\s]?(?:ac[_\s]?)?l1|u[_\s]?l1|v[_\s]?l1/i, fieldType: 'voltage_ac_l1', baseConfidence: 0.92, unit: 'V', validationRules: { min: 0, max: 1000 } },
  { regex: /voltage[_\s]?(?:ac[_\s]?)?l2|u[_\s]?l2|v[_\s]?l2/i, fieldType: 'voltage_ac_l2', baseConfidence: 0.92, unit: 'V', validationRules: { min: 0, max: 1000 } },
  { regex: /voltage[_\s]?(?:ac[_\s]?)?l3|u[_\s]?l3|v[_\s]?l3/i, fieldType: 'voltage_ac_l3', baseConfidence: 0.92, unit: 'V', validationRules: { min: 0, max: 1000 } },

  // ========== Current DC ==========
  { regex: /current[_\s]?dc/i, fieldType: 'current_dc', baseConfidence: 0.95, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /i[_\s]?dc[_\s]?\d*/i, fieldType: 'current_dc', baseConfidence: 0.92, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /dc[_\s]?current/i, fieldType: 'current_dc', baseConfidence: 0.90, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /input[_\s]?current[_\s]?\d*/i, fieldType: 'current_dc', baseConfidence: 0.88, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /mppt[_\s]?\d*[_\s]?current/i, fieldType: 'current_dc', baseConfidence: 0.88, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /string[_\s]?\d*[_\s]?current/i, fieldType: 'current_dc', baseConfidence: 0.85, unit: 'A', validationRules: { min: 0, max: 5000 } },

  // ========== Current AC (3-phase) ==========
  { regex: /current[_\s]?(?:ac[_\s]?)?l1|i[_\s]?l1/i, fieldType: 'current_ac_l1', baseConfidence: 0.92, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /current[_\s]?(?:ac[_\s]?)?l2|i[_\s]?l2/i, fieldType: 'current_ac_l2', baseConfidence: 0.92, unit: 'A', validationRules: { min: 0, max: 5000 } },
  { regex: /current[_\s]?(?:ac[_\s]?)?l3|i[_\s]?l3/i, fieldType: 'current_ac_l3', baseConfidence: 0.92, unit: 'A', validationRules: { min: 0, max: 5000 } },

  // ========== Irradiance POA ==========
  { regex: /irradiation[_\s]?average/i, fieldType: 'irradiance_poa', baseConfidence: 0.92, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /poa[_\s]?irradiance/i, fieldType: 'irradiance_poa', baseConfidence: 0.95, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /plane[_\s]?of[_\s]?array/i, fieldType: 'irradiance_poa', baseConfidence: 0.90, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /tilted[_\s]?irradiance/i, fieldType: 'irradiance_poa', baseConfidence: 0.88, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /module[_\s]?irradiance/i, fieldType: 'irradiance_poa', baseConfidence: 0.85, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },

  // ========== Irradiance GHI ==========
  { regex: /ghi[_\s]?(?:irradiance)?/i, fieldType: 'irradiance_ghi', baseConfidence: 0.95, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /global[_\s]?horizontal/i, fieldType: 'irradiance_ghi', baseConfidence: 0.92, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /horizontal[_\s]?irradiance/i, fieldType: 'irradiance_ghi', baseConfidence: 0.88, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },

  // ========== Irradiance DNI ==========
  { regex: /dni[_\s]?(?:irradiance)?/i, fieldType: 'irradiance_dni', baseConfidence: 0.95, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },
  { regex: /direct[_\s]?normal/i, fieldType: 'irradiance_dni', baseConfidence: 0.92, unit: 'W/m²', validationRules: { min: 0, max: 1500 } },

  // ========== Temperature Module ==========
  { regex: /module[_\s]?temp(?:erature)?/i, fieldType: 'temp_module', baseConfidence: 0.95, unit: '°C', validationRules: { min: -20, max: 90 } },
  { regex: /cell[_\s]?temp(?:erature)?/i, fieldType: 'temp_module', baseConfidence: 0.95, unit: '°C', validationRules: { min: -20, max: 90 } },
  { regex: /pv[_\s]?temp(?:erature)?/i, fieldType: 'temp_module', baseConfidence: 0.90, unit: '°C', validationRules: { min: -20, max: 90 } },
  { regex: /panel[_\s]?temp(?:erature)?/i, fieldType: 'temp_module', baseConfidence: 0.88, unit: '°C', validationRules: { min: -20, max: 90 } },
  { regex: /back[_\s]?(?:of[_\s]?)?module/i, fieldType: 'temp_module', baseConfidence: 0.85, unit: '°C', validationRules: { min: -20, max: 90 } },

  // ========== Temperature Ambient ==========
  { regex: /ambient[_\s]?temp(?:erature)?/i, fieldType: 'temp_ambient', baseConfidence: 0.95, unit: '°C', validationRules: { min: -40, max: 60 } },
  { regex: /air[_\s]?temp(?:erature)?/i, fieldType: 'temp_ambient', baseConfidence: 0.92, unit: '°C', validationRules: { min: -40, max: 60 } },
  { regex: /outdoor[_\s]?temp(?:erature)?/i, fieldType: 'temp_ambient', baseConfidence: 0.90, unit: '°C', validationRules: { min: -40, max: 60 } },
  { regex: /env(?:ironment)?[_\s]?temp/i, fieldType: 'temp_ambient', baseConfidence: 0.85, unit: '°C', validationRules: { min: -40, max: 60 } },

  // ========== Temperature Inverter ==========
  { regex: /inverter[_\s]?temp(?:erature)?/i, fieldType: 'temp_inverter', baseConfidence: 0.95, unit: '°C', validationRules: { min: -20, max: 100 } },
  { regex: /cabinet[_\s]?temp(?:erature)?/i, fieldType: 'temp_inverter', baseConfidence: 0.88, unit: '°C', validationRules: { min: -20, max: 100 } },
  { regex: /internal[_\s]?temp(?:erature)?/i, fieldType: 'temp_inverter', baseConfidence: 0.80, unit: '°C', validationRules: { min: -20, max: 100 } },

  // ========== Energy ==========
  { regex: /energy[_\s]?daily|daily[_\s]?energy|daily[_\s]?yield/i, fieldType: 'energy_daily', baseConfidence: 0.95, unit: 'kWh', validationRules: { min: 0 } },
  { regex: /energy[_\s]?(?:total|cumulative)|total[_\s]?(?:energy|yield)/i, fieldType: 'energy_total', baseConfidence: 0.95, unit: 'kWh', validationRules: { min: 0 } },
  { regex: /e[_\s]?day/i, fieldType: 'energy_daily', baseConfidence: 0.85, unit: 'kWh', validationRules: { min: 0 } },
  { regex: /e[_\s]?total/i, fieldType: 'energy_total', baseConfidence: 0.85, unit: 'kWh', validationRules: { min: 0 } },

  // ========== Wind Speed ==========
  { regex: /wind[_\s]?(?:speed|geschwindigkeit)/i, fieldType: 'wind_speed', baseConfidence: 0.95, unit: 'm/s', validationRules: { min: 0, max: 50 } },
  { regex: /wind[_\s]?velocity/i, fieldType: 'wind_speed', baseConfidence: 0.92, unit: 'm/s', validationRules: { min: 0, max: 50 } },
  { regex: /anemometer/i, fieldType: 'wind_speed', baseConfidence: 0.85, unit: 'm/s', validationRules: { min: 0, max: 50 } },

  // ========== Humidity ==========
  { regex: /humidity|rel(?:ative)?[_\s]?hum(?:idity)?/i, fieldType: 'humidity', baseConfidence: 0.95, unit: '%', validationRules: { min: 0, max: 100 } },
  { regex: /rh(?![a-z])/i, fieldType: 'humidity', baseConfidence: 0.80, unit: '%', validationRules: { min: 0, max: 100 } },

  // ========== Precipitation ==========
  { regex: /precipitation|rainfall|rain/i, fieldType: 'precipitation', baseConfidence: 0.92, unit: 'mm', validationRules: { min: 0 } },

  // ========== Soiling ==========
  { regex: /soiling[_\s]?ratio/i, fieldType: 'soiling_ratio', baseConfidence: 0.98, unit: '%', validationRules: { min: 0, max: 100 } },
  { regex: /soiling[_\s]?loss/i, fieldType: 'soiling_ratio', baseConfidence: 0.95, unit: '%', validationRules: { min: 0, max: 100 } },
  { regex: /dust[_\s]?iq/i, fieldType: 'soiling_ratio', baseConfidence: 0.92, unit: '%', validationRules: { min: 0, max: 100 } },
  { regex: /transmission[_\s]?loss/i, fieldType: 'soiling_ratio', baseConfidence: 0.85, unit: '%', validationRules: { min: 0, max: 100 } },
  { regex: /cleanliness/i, fieldType: 'soiling_ratio', baseConfidence: 0.80, unit: '%', validationRules: { min: 0, max: 100 } },

  // ========== Electrical Parameters ==========
  { regex: /frequency|freq(?![a-z])/i, fieldType: 'frequency', baseConfidence: 0.92, unit: 'Hz', validationRules: { min: 45, max: 65 } },
  { regex: /power[_\s]?factor|pf(?![a-z])|cos[_\s]?phi/i, fieldType: 'power_factor', baseConfidence: 0.92, unit: '', validationRules: { min: -1, max: 1 } },

  // ========== Status Codes ==========
  { regex: /status[_\s]?(?:code)?|state(?![a-z])/i, fieldType: 'status_code', baseConfidence: 0.85, unit: '' },
  { regex: /operating[_\s]?(?:state|mode)/i, fieldType: 'status_code', baseConfidence: 0.82, unit: '' },
  { regex: /alarm[_\s]?(?:code)?|fault[_\s]?(?:code)?|error[_\s]?(?:code)?/i, fieldType: 'alarm_code', baseConfidence: 0.88, unit: '' },

  // ========== Identifiers ==========
  { regex: /^plant[_\s]?(?:id|name|code)$/i, fieldType: 'plant_id', baseConfidence: 0.90, unit: '' },
  { regex: /^(?:inverter|inv)[_\s]?(?:id|name|serial)$/i, fieldType: 'inverter_id', baseConfidence: 0.90, unit: '' },
  { regex: /^string[_\s]?(?:id|name)$/i, fieldType: 'string_id', baseConfidence: 0.90, unit: '' },

  // ========== Timestamp ==========
  { regex: /^(?:timestamp|time|datetime|date_time|_time)$/i, fieldType: 'timestamp', baseConfidence: 0.98, unit: '' },
  { regex: /^(?:created_at|updated_at|recorded_at)$/i, fieldType: 'timestamp', baseConfidence: 0.95, unit: '' },
];

/**
 * Hierarchy patterns for detecting plant/inverter structure from column names
 */
export const HIERARCHY_PATTERNS: HierarchyPattern[] = [
  // Pattern: "Eta (ES): INV 01.001 / Inverter Power Normalized"
  {
    vendor: 'Generic SCADA (European)',
    pattern: /^(.+?)\s*\([A-Z]{2}\):\s*(INV\s*\d+\.\d+)\s*\/\s*(.+)$/,
    extractors: { plant: 1, inverter: 2, field: 3 },
    description: 'Plant (Country): Inverter / Field format',
  },
  // Pattern: "Eta (ES): Plant / Field"
  {
    vendor: 'Generic SCADA (Plant-level)',
    pattern: /^(.+?)\s*\([A-Z]{2}\):\s*Plant\s*\/\s*(.+)$/,
    extractors: { plant: 1, field: 2 },
    description: 'Plant (Country): Plant / Field format',
  },
  // Pattern: "Plant_001_INV_01_Power"
  {
    vendor: 'Generic (Underscore)',
    pattern: /^(?:Plant[_\s]?)(\d+)[_\s]?(?:INV|Inverter)[_\s]?(\d+)[_\s]?(.+)$/i,
    extractors: { plant: 1, inverter: 2, field: 3 },
    description: 'Plant_X_INV_Y_Field format',
  },
  // Pattern: "SMA_Inverter1_PAC" or "SMA Inverter 1 PAC"
  {
    vendor: 'SMA',
    pattern: /^SMA[_\s]?(?:Inverter|INV)[_\s]?(\d+)[_\s]?(.+)$/i,
    extractors: { inverter: 1, field: 2 },
    description: 'SMA Inverter naming',
  },
  // Pattern: "Huawei_INV01_ActivePower"
  {
    vendor: 'Huawei',
    pattern: /^Huawei[_\s]?(?:INV|Inverter)?[_\s]?(\d+)[_\s]?(.+)$/i,
    extractors: { inverter: 1, field: 2 },
    description: 'Huawei inverter naming',
  },
  // Pattern: "Fronius_Symo_001_P"
  {
    vendor: 'Fronius',
    pattern: /^Fronius[_\s]?(?:Symo|Primo|Eco)?[_\s]?(\d+)[_\s]?(.+)$/i,
    extractors: { inverter: 1, field: 2 },
    description: 'Fronius inverter naming',
  },
  // Pattern: "INV-01-PAC" or "INV_01_PAC"
  {
    vendor: 'Generic (INV prefix)',
    pattern: /^(?:INV|Inverter)[-_\s]?(\d+)[-_\s]?(.+)$/i,
    extractors: { inverter: 1, field: 2 },
    description: 'INV-X-Field format',
  },
  // Pattern: "CB01_String01_Current"
  {
    vendor: 'Generic (Combiner Box)',
    pattern: /^(?:CB|Combiner)[_\s]?(\d+)[_\s]?(?:String|STR)[_\s]?(\d+)[_\s]?(.+)$/i,
    extractors: { group: 1, string: 2, field: 3 },
    description: 'Combiner box string naming',
  },
];

/**
 * Timestamp format patterns
 */
export const TIMESTAMP_FORMATS: TimestampFormat[] = [
  { name: 'ISO 8601', regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, strptime: '%Y-%m-%dT%H:%M:%S' },
  { name: 'ISO 8601 with Z', regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/, strptime: '%Y-%m-%dT%H:%M:%SZ' },
  { name: 'ISO 8601 with timezone', regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/, strptime: '%Y-%m-%dT%H:%M:%S%z' },
  { name: 'European (dot)', regex: /^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/, strptime: '%d.%m.%Y %H:%M' },
  { name: 'European (slash)', regex: /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/, strptime: '%d/%m/%Y %H:%M' },
  { name: 'US (slash)', regex: /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/, strptime: '%m/%d/%Y %H:%M' },
  { name: 'Year.Month.Day', regex: /^\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}/, strptime: '%Y.%m.%d %H:%M' },
  { name: 'Year/Month/Day', regex: /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/, strptime: '%Y/%m/%d %H:%M' },
  { name: 'Date only (ISO)', regex: /^\d{4}-\d{2}-\d{2}$/, strptime: '%Y-%m-%d' },
  { name: 'Unix timestamp (seconds)', regex: /^\d{10}$/, strptime: 'unix' },
  { name: 'Unix timestamp (milliseconds)', regex: /^\d{13}$/, strptime: 'unix_ms' },
];

// ============================================================================
// Field Mapping Intelligence Service
// ============================================================================

export class FieldMappingIntelligence {
  private existingMappings: Map<DataFieldType, string> = new Map();
  private fieldPatterns: FieldPattern[] = FIELD_PATTERNS;
  private hierarchyPatterns: HierarchyPattern[] = HIERARCHY_PATTERNS;

  constructor(customPatterns?: FieldPattern[]) {
    if (customPatterns) {
      // Prepend custom patterns (higher priority)
      this.fieldPatterns = [...customPatterns, ...FIELD_PATTERNS];
    }
  }

  /**
   * Map a single field to a standard type with confidence scoring
   */
  mapField(
    fieldName: string,
    sampleValues: any[] = [],
    contextHints?: { vendor?: string; dataFormat?: 'wide' | 'long' | 'mixed' }
  ): FieldMappingResult {
    const normalizedField = fieldName.toLowerCase();

    // Find best matching pattern
    let bestMatch: FieldMappingResult | null = null;
    let highestConfidence = 0;

    for (const pattern of this.fieldPatterns) {
      if (pattern.regex.test(fieldName)) {
        let confidence = pattern.baseConfidence;
        const factors: ConfidenceFactors = {
          patternMatch: pattern.baseConfidence,
          unitMatch: 0,
          valueRange: 0,
          uniqueness: 0,
        };

        // Boost: Unit in column name matches expected unit
        if (pattern.unit) {
          const unitPatterns = [
            pattern.unit.toLowerCase(),
            pattern.unit.replace('°', '').toLowerCase(),
            pattern.unit === 'W/m²' ? 'w/m2' : '',
            pattern.unit === 'kW' ? 'kw' : '',
          ].filter(Boolean);

          if (unitPatterns.some(u => normalizedField.includes(u))) {
            confidence += 0.05;
            factors.unitMatch = 0.05;
          }
        }

        // Boost: Sample values in expected range
        if (sampleValues.length > 0 && pattern.validationRules) {
          const numericValues = sampleValues
            .filter(v => typeof v === 'number' && !isNaN(v));

          if (numericValues.length > 0) {
            const inRange = numericValues.every(v =>
              (pattern.validationRules!.min === undefined || v >= pattern.validationRules!.min) &&
              (pattern.validationRules!.max === undefined || v <= pattern.validationRules!.max)
            );
            if (inRange) {
              confidence += 0.03;
              factors.valueRange = 0.03;
            } else {
              confidence -= 0.10; // Penalty for out of range
              factors.valueRange = -0.10;
            }
          }
        }

        // Penalty: Field type already mapped with high confidence
        if (this.existingMappings.has(pattern.fieldType)) {
          const existingField = this.existingMappings.get(pattern.fieldType)!;
          if (existingField !== fieldName && confidence < 0.95) {
            confidence -= 0.10;
            factors.uniqueness = -0.10;
          }
        }

        // Vendor-specific boost
        if (contextHints?.vendor) {
          const vendorPatterns = this.hierarchyPatterns.filter(
            hp => hp.vendor.toLowerCase().includes(contextHints.vendor!.toLowerCase())
          );
          if (vendorPatterns.length > 0) {
            confidence += 0.02;
          }
        }

        // Cap confidence at 1.0
        confidence = Math.min(Math.max(confidence, 0), 1.0);

        if (confidence > highestConfidence) {
          highestConfidence = confidence;
          bestMatch = {
            originalField: fieldName,
            mappedType: pattern.fieldType,
            confidence,
            unit: pattern.unit,
            scalingFactor: pattern.scalingFactor,
            validationRules: pattern.validationRules,
            sampleValues: sampleValues.slice(0, 5),
            confidenceFactors: factors,
          };
        }
      }
    }

    // If no pattern matched, return unmapped with low confidence
    if (!bestMatch) {
      bestMatch = {
        originalField: fieldName,
        mappedType: 'unmapped',
        confidence: 0.0,
        sampleValues: sampleValues.slice(0, 5),
        confidenceFactors: {
          patternMatch: 0,
          unitMatch: 0,
          valueRange: 0,
          uniqueness: 0,
        },
      };
    }

    // Track mapping
    if (bestMatch.confidence >= 0.85) {
      this.existingMappings.set(bestMatch.mappedType, fieldName);
    }

    return bestMatch;
  }

  /**
   * Map multiple fields at once
   */
  mapFields(
    fields: Array<{ name: string; sampleValues?: any[] }>,
    contextHints?: { vendor?: string; dataFormat?: 'wide' | 'long' | 'mixed' }
  ): FieldMappingResult[] {
    // Reset existing mappings for fresh analysis
    this.existingMappings.clear();

    // Sort fields to process high-confidence patterns first
    const sortedFields = [...fields].sort((a, b) => {
      const aMatch = this.fieldPatterns.find(p => p.regex.test(a.name));
      const bMatch = this.fieldPatterns.find(p => p.regex.test(b.name));
      return (bMatch?.baseConfidence || 0) - (aMatch?.baseConfidence || 0);
    });

    const results: FieldMappingResult[] = [];

    for (const field of sortedFields) {
      const result = this.mapField(field.name, field.sampleValues || [], contextHints);
      results.push(result);
    }

    // Return in original order
    return fields.map(f => results.find(r => r.originalField === f.name)!);
  }

  /**
   * Detect component hierarchy from column names
   */
  detectHierarchy(columns: string[]): DetectedHierarchy {
    // Try each hierarchy pattern
    for (const hp of this.hierarchyPatterns) {
      const matches = columns.filter(c => hp.pattern.test(c));

      // If pattern matches >30% of columns, it's likely the right one
      if (matches.length > columns.length * 0.1 && matches.length >= 3) {
        const plants = new Set<string>();
        const groups = new Map<string, Set<string>>();
        const inverters = new Map<string, Set<string>>();

        for (const col of matches) {
          const match = col.match(hp.pattern);
          if (match) {
            const plant = hp.extractors.plant ? match[hp.extractors.plant] : 'default';
            const group = hp.extractors.group ? match[hp.extractors.group] : undefined;
            const inv = hp.extractors.inverter ? match[hp.extractors.inverter] : undefined;

            plants.add(plant);

            if (group) {
              if (!groups.has(plant)) groups.set(plant, new Set());
              groups.get(plant)!.add(group);
            }

            if (inv) {
              const parent = group || plant;
              if (!inverters.has(parent)) inverters.set(parent, new Set());
              inverters.get(parent)!.add(inv);
            }
          }
        }

        return {
          pattern: hp,
          plants: Array.from(plants),
          groups: new Map(Array.from(groups).map(([p, g]) => [p, Array.from(g)])),
          inverters: new Map(Array.from(inverters).map(([p, i]) => [p, Array.from(i)])),
          hierarchyString: hp.description,
        };
      }
    }

    return {
      pattern: null,
      plants: [],
      groups: new Map(),
      inverters: new Map(),
    };
  }

  /**
   * Detect timestamp column and format
   */
  detectTimestamp(
    columns: Array<{ name: string; sampleValues: any[] }>
  ): TimestampDetectionResult | null {
    // First, look for obvious timestamp column names
    const timestampCandidates = columns.filter(c => {
      const name = c.name.toLowerCase();
      return (
        name === 'timestamp' ||
        name === 'time' ||
        name === 'datetime' ||
        name === '_time' ||
        name === 'date_time' ||
        name.endsWith('_at') ||
        name.includes('timestamp')
      );
    });

    // If no obvious candidates, look at all columns
    const candidates = timestampCandidates.length > 0 ? timestampCandidates : columns;

    for (const col of candidates) {
      if (col.sampleValues.length === 0) continue;

      // Try each timestamp format
      for (const format of TIMESTAMP_FORMATS) {
        const samples = col.sampleValues.map(v => String(v));
        const matchCount = samples.filter(s => format.regex.test(s)).length;

        if (matchCount >= samples.length * 0.8) {
          return {
            column: col.name,
            format,
            confidence: matchCount / samples.length,
            sampleParsed: [], // Could parse here if needed
          };
        }
      }
    }

    return null;
  }

  /**
   * Analyze column to determine its type
   */
  analyzeColumn(name: string, values: any[]): ColumnStatistics {
    const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
    const nullCount = values.length - nonNullValues.length;

    // Determine type
    let type: ColumnStatistics['type'] = 'unknown';
    const numericValues = nonNullValues.filter(v => typeof v === 'number' || !isNaN(Number(v)));
    const dateValues = nonNullValues.filter(v => {
      if (v instanceof Date) return true;
      const str = String(v);
      return TIMESTAMP_FORMATS.some(f => f.regex.test(str));
    });
    const booleanValues = nonNullValues.filter(v =>
      typeof v === 'boolean' ||
      ['true', 'false', '0', '1', 'yes', 'no'].includes(String(v).toLowerCase())
    );

    if (dateValues.length > nonNullValues.length * 0.8) {
      type = 'datetime';
    } else if (numericValues.length > nonNullValues.length * 0.8) {
      type = 'numeric';
    } else if (booleanValues.length > nonNullValues.length * 0.8) {
      type = 'boolean';
    } else {
      type = 'string';
    }

    // Calculate statistics
    const stats: ColumnStatistics = {
      column: name,
      type,
      count: values.length,
      nullCount,
      uniqueCount: new Set(nonNullValues.map(v => String(v))).size,
      sampleValues: nonNullValues.slice(0, 5),
    };

    if (type === 'numeric' && numericValues.length > 0) {
      const nums = numericValues.map(v => Number(v));
      stats.min = Math.min(...nums);
      stats.max = Math.max(...nums);
      stats.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    }

    return stats;
  }

  /**
   * Detect if data is in wide format (one column per inverter) or long format
   */
  detectDataFormat(columns: string[], hierarchy: DetectedHierarchy): 'wide' | 'long' | 'mixed' {
    // If many columns contain inverter IDs, it's likely wide format
    const inverterColumns = columns.filter(c => {
      return (
        /INV[_\s]?\d+/i.test(c) ||
        /Inverter[_\s]?\d+/i.test(c) ||
        hierarchy.pattern?.pattern.test(c)
      );
    });

    if (inverterColumns.length > 5) {
      return 'wide';
    }

    // If there's an inverter_id column, it's long format
    if (columns.some(c => /^(?:inverter|inv)[_\s]?id$/i.test(c))) {
      return 'long';
    }

    // If hierarchy detected many inverters in column names, it's wide
    let totalInverters = 0;
    hierarchy.inverters.forEach(invs => totalInverters += invs.length);
    if (totalInverters > 3) {
      return 'wide';
    }

    return 'mixed';
  }

  /**
   * Comprehensive data structure analysis
   */
  analyzeDataStructure(
    columns: Array<{ name: string; sampleValues: any[] }>,
    options?: { vendor?: string }
  ): DataStructureResult {
    // Analyze each column
    const columnStats = columns.map(c => this.analyzeColumn(c.name, c.sampleValues));

    // Detect hierarchy
    const hierarchy = this.detectHierarchy(columns.map(c => c.name));

    // Detect data format
    const format = this.detectDataFormat(columns.map(c => c.name), hierarchy);

    // Detect timestamp
    const timestampResult = this.detectTimestamp(columns);

    // Map fields
    const fieldMappings = this.mapFields(columns, {
      vendor: options?.vendor || hierarchy.pattern?.vendor,
      dataFormat: format,
    });

    // Calculate quality score
    const qualityScore = this.calculateQualityScore(fieldMappings, columnStats, timestampResult);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      fieldMappings,
      columnStats,
      timestampResult,
      format
    );

    return {
      format,
      timestampColumn: timestampResult?.column,
      timestampFormat: timestampResult?.format,
      columns: columnStats,
      hierarchy,
      fieldMappings,
      qualityScore,
      recommendations,
    };
  }

  /**
   * Calculate overall data quality score (0-100)
   */
  private calculateQualityScore(
    mappings: FieldMappingResult[],
    columnStats: ColumnStatistics[],
    timestamp: TimestampDetectionResult | null
  ): number {
    let score = 100;

    // Deduct for missing critical fields
    const criticalTypes: DataFieldType[] = ['power_ac', 'irradiance_poa'];
    for (const type of criticalTypes) {
      const mapping = mappings.find(m => m.mappedType === type && m.confidence >= 0.7);
      if (!mapping) {
        score -= 15;
      }
    }

    // Deduct for missing timestamp
    if (!timestamp) {
      score -= 20;
    }

    // Deduct for low-confidence mappings
    const lowConfidenceMappings = mappings.filter(
      m => m.confidence > 0 && m.confidence < 0.6 && m.mappedType !== 'unmapped'
    );
    score -= lowConfidenceMappings.length * 2;

    // Deduct for unmapped important fields
    const unmapped = mappings.filter(m => m.mappedType === 'unmapped');
    score -= Math.min(unmapped.length, 5) * 3;

    // Deduct for high null rates
    for (const col of columnStats) {
      const nullRate = col.nullCount / col.count;
      if (nullRate > 0.2) {
        score -= 3;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(
    mappings: FieldMappingResult[],
    columnStats: ColumnStatistics[],
    timestamp: TimestampDetectionResult | null,
    format: 'wide' | 'long' | 'mixed'
  ): string[] {
    const recommendations: string[] = [];

    // Missing critical fields
    const hasPowerAc = mappings.some(m => m.mappedType === 'power_ac' && m.confidence >= 0.7);
    const hasIrradiance = mappings.some(
      m => (m.mappedType === 'irradiance_poa' || m.mappedType === 'irradiance_ghi') && m.confidence >= 0.7
    );
    const hasTemperature = mappings.some(
      m => (m.mappedType === 'temp_module' || m.mappedType === 'temp_ambient') && m.confidence >= 0.7
    );

    if (!hasPowerAc) {
      recommendations.push('⚠️ Missing power_ac field - required for performance analysis');
    }
    if (!hasIrradiance) {
      recommendations.push('⚠️ Missing irradiance field - required for PR calculation');
    }
    if (!hasTemperature) {
      recommendations.push('ℹ️ Missing temperature field - recommended for accurate modeling');
    }

    // Timestamp issues
    if (!timestamp) {
      recommendations.push('⚠️ Could not detect timestamp column - manual mapping required');
    }

    // Low confidence mappings
    const lowConfidence = mappings.filter(m => m.confidence > 0.3 && m.confidence < 0.7);
    if (lowConfidence.length > 0) {
      recommendations.push(
        `ℹ️ ${lowConfidence.length} field(s) have medium confidence - please review mappings`
      );
    }

    // Unmapped fields
    const unmapped = mappings.filter(m => m.mappedType === 'unmapped');
    if (unmapped.length > 5) {
      recommendations.push(
        `ℹ️ ${unmapped.length} columns could not be auto-mapped - may contain custom data`
      );
    }

    // Data format specific
    if (format === 'wide') {
      recommendations.push(
        'ℹ️ Wide format detected (one column per inverter) - data will be transformed to long format'
      );
    }

    // High null rates
    const highNullCols = columnStats.filter(c => c.nullCount / c.count > 0.2);
    if (highNullCols.length > 0) {
      recommendations.push(
        `⚠️ ${highNullCols.length} column(s) have >20% missing values - check data quality`
      );
    }

    return recommendations;
  }

  /**
   * Add vendor-specific patterns from ConnectionTemplate
   */
  addVendorPatterns(vendorPatterns: Array<{
    regex: string;
    fieldType: DataFieldType;
    confidence: number;
    unit?: string;
  }>): void {
    const patterns = vendorPatterns.map(vp => ({
      regex: new RegExp(vp.regex, 'i'),
      fieldType: vp.fieldType,
      baseConfidence: vp.confidence,
      unit: vp.unit,
    }));

    // Prepend vendor patterns (higher priority)
    this.fieldPatterns = [...patterns, ...this.fieldPatterns];
  }

  /**
   * Reset for fresh analysis
   */
  reset(): void {
    this.existingMappings.clear();
  }
}

// Export singleton instance
export const fieldMappingIntelligence = new FieldMappingIntelligence();

// Export utility functions
export function mapFieldsAuto(
  fields: Array<{ name: string; sampleValues?: any[] }>,
  options?: { vendor?: string }
): FieldMappingResult[] {
  const intelligence = new FieldMappingIntelligence();
  return intelligence.mapFields(fields, options);
}

export function analyzeDataStructureAuto(
  columns: Array<{ name: string; sampleValues: any[] }>,
  options?: { vendor?: string }
): DataStructureResult {
  const intelligence = new FieldMappingIntelligence();
  return intelligence.analyzeDataStructure(columns, options);
}
