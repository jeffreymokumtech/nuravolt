/**
 * Data Quality Validator Service
 *
 * Pre-import validation for solar PV data, including:
 * - Required field checks
 * - Gap detection
 * - Outlier identification
 * - Timezone validation
 * - Quality scoring
 */

import { DataFieldType } from '@prisma/client';
import type { FieldMappingResult } from './field-mapping-intelligence';

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  isValid: boolean;
  qualityScore: number;  // 0-100
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  fieldValidation: FieldValidationResult[];
  temporalValidation: TemporalValidationResult;
  valueValidation: ValueValidationResult;
  recommendations: string[];
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  field?: string;
  details?: Record<string, any>;
}

export interface FieldValidationResult {
  field: string;
  mappedType: DataFieldType | 'unmapped';
  isRequired: boolean;
  isPresent: boolean;
  nullRate: number;
  issues: ValidationIssue[];
}

export interface TemporalValidationResult {
  hasTimestamp: boolean;
  timestampField?: string;
  timestampFormat?: string;
  timeRange?: {
    start: Date;
    end: Date;
    durationDays: number;
  };
  resolution?: {
    detected: string;  // e.g., "15min", "1h"
    expectedPoints: number;
    actualPoints: number;
    completeness: number;
  };
  gaps: Array<{
    start: Date;
    end: Date;
    durationHours: number;
  }>;
  timezone?: {
    detected?: string;
    hasIssues: boolean;
    issues: string[];
  };
}

export interface ValueValidationResult {
  outliers: Array<{
    field: string;
    count: number;
    percentage: number;
    examples: Array<{ timestamp?: string; value: number }>;
  }>;
  impossibleValues: Array<{
    field: string;
    rule: string;
    count: number;
    examples: Array<{ timestamp?: string; value: number }>;
  }>;
  correlationIssues: Array<{
    field1: string;
    field2: string;
    issue: string;
  }>;
}

export interface DataRow {
  [key: string]: any;
}

export interface ValidationOptions {
  strictMode?: boolean;  // Fail on warnings
  requiredFields?: DataFieldType[];  // Override default required fields
  maxGapHours?: number;  // Max gap before flagging
  outlierThreshold?: number;  // Std devs for outlier detection
  checkCorrelations?: boolean;  // Check field correlations
}

// ============================================================================
// Validation Rules
// ============================================================================

/**
 * Physical limits for solar PV data
 */
const PHYSICAL_LIMITS: Record<DataFieldType, { min: number; max: number; unit: string }> = {
  power_ac: { min: 0, max: 100000, unit: 'kW' },
  power_dc: { min: 0, max: 100000, unit: 'kW' },
  reactive_power: { min: -100000, max: 100000, unit: 'kVAr' },
  voltage_dc: { min: 0, max: 2000, unit: 'V' },
  voltage_ac_l1: { min: 0, max: 1000, unit: 'V' },
  voltage_ac_l2: { min: 0, max: 1000, unit: 'V' },
  voltage_ac_l3: { min: 0, max: 1000, unit: 'V' },
  current_dc: { min: 0, max: 10000, unit: 'A' },
  current_ac_l1: { min: 0, max: 10000, unit: 'A' },
  current_ac_l2: { min: 0, max: 10000, unit: 'A' },
  current_ac_l3: { min: 0, max: 10000, unit: 'A' },
  irradiance_poa: { min: 0, max: 1500, unit: 'W/m²' },
  irradiance_ghi: { min: 0, max: 1500, unit: 'W/m²' },
  irradiance_dni: { min: 0, max: 1500, unit: 'W/m²' },
  temp_module: { min: -40, max: 100, unit: '°C' },
  temp_ambient: { min: -50, max: 60, unit: '°C' },
  temp_inverter: { min: -20, max: 120, unit: '°C' },
  energy_daily: { min: 0, max: 1000000, unit: 'kWh' },
  energy_total: { min: 0, max: 100000000, unit: 'kWh' },
  power_loss: { min: 0, max: 100000, unit: 'kW' },
  financial_impact: { min: -1000000, max: 1000000, unit: 'EUR' },
  wind_speed: { min: 0, max: 100, unit: 'm/s' },
  humidity: { min: 0, max: 100, unit: '%' },
  precipitation: { min: 0, max: 500, unit: 'mm' },
  soiling_ratio: { min: 0, max: 100, unit: '%' },
  frequency: { min: 40, max: 70, unit: 'Hz' },
  power_factor: { min: -1, max: 1, unit: '' },
  status_code: { min: -1000000, max: 1000000, unit: '' },
  alarm_code: { min: -1000000, max: 1000000, unit: '' },
  plant_id: { min: -Infinity, max: Infinity, unit: '' },
  inverter_id: { min: -Infinity, max: Infinity, unit: '' },
  string_id: { min: -Infinity, max: Infinity, unit: '' },
  timestamp: { min: -Infinity, max: Infinity, unit: '' },
  unmapped: { min: -Infinity, max: Infinity, unit: '' },
};

/**
 * Default required fields for solar PV analysis
 */
const DEFAULT_REQUIRED_FIELDS: DataFieldType[] = [
  'power_ac',
  'irradiance_poa',
];

/**
 * Recommended fields for better analysis
 */
const RECOMMENDED_FIELDS: DataFieldType[] = [
  'temp_module',
  'temp_ambient',
];

// ============================================================================
// Data Quality Validator Class
// ============================================================================

export class DataQualityValidator {
  private options: ValidationOptions;

  constructor(options?: ValidationOptions) {
    this.options = {
      strictMode: false,
      requiredFields: DEFAULT_REQUIRED_FIELDS,
      maxGapHours: 4,
      outlierThreshold: 3,
      checkCorrelations: true,
      ...options,
    };
  }

  /**
   * Validate data with field mappings
   */
  validate(
    data: DataRow[],
    mappings: FieldMappingResult[],
    timestampField?: string
  ): ValidationResult {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const info: ValidationIssue[] = [];

    // Validate data is present
    if (!data || data.length === 0) {
      return {
        isValid: false,
        qualityScore: 0,
        errors: [{
          code: 'NO_DATA',
          severity: 'error',
          message: 'No data provided for validation',
        }],
        warnings: [],
        info: [],
        fieldValidation: [],
        temporalValidation: {
          hasTimestamp: false,
          gaps: [],
        },
        valueValidation: {
          outliers: [],
          impossibleValues: [],
          correlationIssues: [],
        },
        recommendations: ['Upload or connect to a data source with actual data'],
      };
    }

    // Field validation
    const fieldValidation = this.validateFields(data, mappings);

    // Temporal validation
    const temporalValidation = this.validateTemporal(data, timestampField);

    // Value validation
    const valueValidation = this.validateValues(data, mappings);

    // Collect all issues
    for (const fv of fieldValidation) {
      for (const issue of fv.issues) {
        if (issue.severity === 'error') errors.push(issue);
        else if (issue.severity === 'warning') warnings.push(issue);
        else info.push(issue);
      }
    }

    if (!temporalValidation.hasTimestamp) {
      errors.push({
        code: 'NO_TIMESTAMP',
        severity: 'error',
        message: 'No timestamp field detected',
      });
    }

    if (temporalValidation.gaps.length > 0) {
      const largeGaps = temporalValidation.gaps.filter(g => g.durationHours >= this.options.maxGapHours!);
      if (largeGaps.length > 0) {
        warnings.push({
          code: 'DATA_GAPS',
          severity: 'warning',
          message: `Found ${largeGaps.length} data gaps >= ${this.options.maxGapHours} hours`,
          details: { gaps: largeGaps.slice(0, 5) },
        });
      }
    }

    if (temporalValidation.timezone?.hasIssues) {
      warnings.push({
        code: 'TIMEZONE_ISSUES',
        severity: 'warning',
        message: 'Potential timezone issues detected',
        details: { issues: temporalValidation.timezone.issues },
      });
    }

    for (const outlier of valueValidation.outliers) {
      if (outlier.percentage > 1) {
        warnings.push({
          code: 'OUTLIERS',
          severity: 'warning',
          message: `Field "${outlier.field}" has ${outlier.percentage.toFixed(1)}% outliers`,
          field: outlier.field,
          details: { count: outlier.count, examples: outlier.examples.slice(0, 3) },
        });
      }
    }

    for (const impossible of valueValidation.impossibleValues) {
      errors.push({
        code: 'IMPOSSIBLE_VALUES',
        severity: 'error',
        message: `Field "${impossible.field}" has ${impossible.count} physically impossible values (${impossible.rule})`,
        field: impossible.field,
        details: { examples: impossible.examples.slice(0, 3) },
      });
    }

    for (const corr of valueValidation.correlationIssues) {
      warnings.push({
        code: 'CORRELATION_ISSUE',
        severity: 'warning',
        message: `Potential data issue: ${corr.issue}`,
        details: { field1: corr.field1, field2: corr.field2 },
      });
    }

    // Calculate quality score
    const qualityScore = this.calculateQualityScore(
      data.length,
      fieldValidation,
      temporalValidation,
      valueValidation,
      errors.length,
      warnings.length
    );

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      fieldValidation,
      temporalValidation,
      valueValidation,
      errors,
      warnings
    );

    // Determine if valid
    const isValid = errors.length === 0 && (!this.options.strictMode || warnings.length === 0);

    return {
      isValid,
      qualityScore,
      errors,
      warnings,
      info,
      fieldValidation,
      temporalValidation,
      valueValidation,
      recommendations,
    };
  }

  /**
   * Validate required and recommended fields
   */
  private validateFields(
    data: DataRow[],
    mappings: FieldMappingResult[]
  ): FieldValidationResult[] {
    const results: FieldValidationResult[] = [];

    // Check required fields
    for (const reqType of this.options.requiredFields!) {
      const mapping = mappings.find(m => m.mappedType === reqType);

      if (!mapping) {
        results.push({
          field: reqType,
          mappedType: reqType,
          isRequired: true,
          isPresent: false,
          nullRate: 1,
          issues: [{
            code: 'MISSING_REQUIRED_FIELD',
            severity: 'error',
            message: `Required field "${reqType}" is not mapped`,
            field: reqType,
          }],
        });
        continue;
      }

      // Check null rate
      const nullCount = data.filter(row => {
        const value = row[mapping.originalField];
        return value === null || value === undefined || value === '';
      }).length;
      const nullRate = nullCount / data.length;

      const issues: ValidationIssue[] = [];

      if (nullRate > 0.5) {
        issues.push({
          code: 'HIGH_NULL_RATE',
          severity: 'error',
          message: `Required field "${mapping.originalField}" has ${(nullRate * 100).toFixed(1)}% null values`,
          field: mapping.originalField,
        });
      } else if (nullRate > 0.1) {
        issues.push({
          code: 'MODERATE_NULL_RATE',
          severity: 'warning',
          message: `Field "${mapping.originalField}" has ${(nullRate * 100).toFixed(1)}% null values`,
          field: mapping.originalField,
        });
      }

      results.push({
        field: mapping.originalField,
        mappedType: reqType,
        isRequired: true,
        isPresent: true,
        nullRate,
        issues,
      });
    }

    // Check recommended fields
    for (const recType of RECOMMENDED_FIELDS) {
      if (this.options.requiredFields!.includes(recType)) continue;

      const mapping = mappings.find(m => m.mappedType === recType);

      if (!mapping) {
        results.push({
          field: recType,
          mappedType: recType,
          isRequired: false,
          isPresent: false,
          nullRate: 1,
          issues: [{
            code: 'MISSING_RECOMMENDED_FIELD',
            severity: 'info',
            message: `Recommended field "${recType}" is not available - analysis may be less accurate`,
            field: recType,
          }],
        });
      }
    }

    return results;
  }

  /**
   * Validate temporal aspects of data
   */
  private validateTemporal(
    data: DataRow[],
    timestampField?: string
  ): TemporalValidationResult {
    // Find timestamp field
    let tsField = timestampField;
    if (!tsField) {
      const tsFields = ['timestamp', 'time', 'datetime', '_time', 'date_time'];
      for (const row of data.slice(0, 1)) {
        for (const key of Object.keys(row)) {
          if (tsFields.includes(key.toLowerCase())) {
            tsField = key;
            break;
          }
        }
      }
    }

    if (!tsField) {
      return {
        hasTimestamp: false,
        gaps: [],
      };
    }

    // Parse timestamps
    const timestamps: Date[] = [];
    for (const row of data) {
      const ts = row[tsField];
      if (ts) {
        const date = new Date(ts);
        if (!isNaN(date.getTime())) {
          timestamps.push(date);
        }
      }
    }

    if (timestamps.length === 0) {
      return {
        hasTimestamp: false,
        timestampField: tsField,
        gaps: [],
      };
    }

    // Sort timestamps
    timestamps.sort((a, b) => a.getTime() - b.getTime());

    // Calculate time range
    const start = timestamps[0];
    const end = timestamps[timestamps.length - 1];
    const durationMs = end.getTime() - start.getTime();
    const durationDays = durationMs / (1000 * 60 * 60 * 24);

    // Detect resolution
    const intervals: number[] = [];
    for (let i = 1; i < Math.min(timestamps.length, 100); i++) {
      intervals.push(timestamps[i].getTime() - timestamps[i - 1].getTime());
    }
    const medianInterval = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    const resolution = this.formatInterval(medianInterval);

    // Calculate expected points
    const expectedPoints = Math.floor(durationMs / medianInterval);
    const completeness = timestamps.length / expectedPoints;

    // Find gaps
    const gaps: TemporalValidationResult['gaps'] = [];
    const gapThreshold = medianInterval * 2;  // Consider >2x normal interval as gap

    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i].getTime() - timestamps[i - 1].getTime();
      if (gap > gapThreshold) {
        gaps.push({
          start: timestamps[i - 1],
          end: timestamps[i],
          durationHours: gap / (1000 * 60 * 60),
        });
      }
    }

    // Check for timezone issues
    const timezoneIssues: string[] = [];

    // Check for future timestamps
    const now = new Date();
    const futureTs = timestamps.filter(t => t > now);
    if (futureTs.length > 0) {
      timezoneIssues.push(`${futureTs.length} timestamps are in the future - possible timezone mismatch`);
    }

    // Check for timestamps before reasonable PV era (2000)
    const oldTs = timestamps.filter(t => t.getFullYear() < 2000);
    if (oldTs.length > 0) {
      timezoneIssues.push(`${oldTs.length} timestamps are before year 2000 - possible data issue`);
    }

    return {
      hasTimestamp: true,
      timestampField: tsField,
      timeRange: {
        start,
        end,
        durationDays,
      },
      resolution: {
        detected: resolution,
        expectedPoints,
        actualPoints: timestamps.length,
        completeness,
      },
      gaps,
      timezone: {
        hasIssues: timezoneIssues.length > 0,
        issues: timezoneIssues,
      },
    };
  }

  /**
   * Validate data values
   */
  private validateValues(
    data: DataRow[],
    mappings: FieldMappingResult[]
  ): ValueValidationResult {
    const outliers: ValueValidationResult['outliers'] = [];
    const impossibleValues: ValueValidationResult['impossibleValues'] = [];
    const correlationIssues: ValueValidationResult['correlationIssues'] = [];

    // Check each mapped field
    for (const mapping of mappings) {
      if (mapping.mappedType === 'unmapped') continue;

      const limits = PHYSICAL_LIMITS[mapping.mappedType];
      if (!limits) continue;

      const values: number[] = [];
      const timestampField = data[0] ? Object.keys(data[0]).find(k =>
        ['timestamp', 'time', 'datetime', '_time'].includes(k.toLowerCase())
      ) : undefined;

      // Collect numeric values
      for (const row of data) {
        const value = row[mapping.originalField];
        if (typeof value === 'number' && !isNaN(value)) {
          values.push(value);
        } else if (typeof value === 'string' && !isNaN(Number(value))) {
          values.push(Number(value));
        }
      }

      if (values.length === 0) continue;

      // Check physical limits
      const impossibleExamples: Array<{ timestamp?: string; value: number }> = [];
      for (let i = 0; i < data.length; i++) {
        const value = data[i][mapping.originalField];
        const numValue = Number(value);

        if (!isNaN(numValue) && (numValue < limits.min || numValue > limits.max)) {
          if (impossibleExamples.length < 10) {
            impossibleExamples.push({
              timestamp: timestampField ? String(data[i][timestampField]) : undefined,
              value: numValue,
            });
          }
        }
      }

      if (impossibleExamples.length > 0) {
        impossibleValues.push({
          field: mapping.originalField,
          rule: `${limits.min} <= value <= ${limits.max} ${limits.unit}`,
          count: impossibleExamples.length,
          examples: impossibleExamples,
        });
      }

      // Check for outliers using IQR method
      const sorted = [...values].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const lowerBound = q1 - (this.options.outlierThreshold! * iqr);
      const upperBound = q3 + (this.options.outlierThreshold! * iqr);

      const outlierExamples: Array<{ timestamp?: string; value: number }> = [];
      let outlierCount = 0;

      for (let i = 0; i < data.length; i++) {
        const value = Number(data[i][mapping.originalField]);
        if (!isNaN(value) && (value < lowerBound || value > upperBound)) {
          outlierCount++;
          if (outlierExamples.length < 5) {
            outlierExamples.push({
              timestamp: timestampField ? String(data[i][timestampField]) : undefined,
              value,
            });
          }
        }
      }

      if (outlierCount > 0) {
        outliers.push({
          field: mapping.originalField,
          count: outlierCount,
          percentage: (outlierCount / values.length) * 100,
          examples: outlierExamples,
        });
      }
    }

    // Check correlations if enabled
    if (this.options.checkCorrelations) {
      const powerMapping = mappings.find(m => m.mappedType === 'power_ac');
      const irradianceMapping = mappings.find(m =>
        m.mappedType === 'irradiance_poa' || m.mappedType === 'irradiance_ghi'
      );

      if (powerMapping && irradianceMapping) {
        // Check for power without irradiance (at night this is suspicious)
        let suspiciousCount = 0;
        for (const row of data) {
          const power = Number(row[powerMapping.originalField]);
          const irr = Number(row[irradianceMapping.originalField]);

          // Power > 10% capacity but irradiance < 10 W/m² is suspicious
          if (power > 0 && irr < 10) {
            suspiciousCount++;
          }
        }

        if (suspiciousCount > data.length * 0.01) {  // More than 1%
          correlationIssues.push({
            field1: powerMapping.originalField,
            field2: irradianceMapping.originalField,
            issue: `${suspiciousCount} records show power output but near-zero irradiance`,
          });
        }
      }
    }

    return {
      outliers,
      impossibleValues,
      correlationIssues,
    };
  }

  /**
   * Calculate overall quality score
   */
  private calculateQualityScore(
    dataCount: number,
    fieldValidation: FieldValidationResult[],
    temporalValidation: TemporalValidationResult,
    valueValidation: ValueValidationResult,
    errorCount: number,
    warningCount: number
  ): number {
    let score = 100;

    // Deduct for errors (major impact)
    score -= errorCount * 15;

    // Deduct for warnings (minor impact)
    score -= warningCount * 3;

    // Deduct for missing required fields
    const missingRequired = fieldValidation.filter(f => f.isRequired && !f.isPresent).length;
    score -= missingRequired * 20;

    // Deduct for high null rates
    for (const fv of fieldValidation) {
      if (fv.isRequired && fv.nullRate > 0.1) {
        score -= fv.nullRate * 20;
      }
    }

    // Deduct for low completeness
    if (temporalValidation.resolution) {
      const completeness = temporalValidation.resolution.completeness;
      if (completeness < 0.9) {
        score -= (1 - completeness) * 30;
      }
    }

    // Deduct for gaps
    const largeGaps = temporalValidation.gaps.filter(g => g.durationHours >= 4).length;
    score -= largeGaps * 2;

    // Deduct for impossible values
    for (const iv of valueValidation.impossibleValues) {
      score -= Math.min(iv.count / dataCount * 100, 10);
    }

    // Deduct for outliers
    for (const o of valueValidation.outliers) {
      if (o.percentage > 5) {
        score -= o.percentage * 0.5;
      }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Generate recommendations based on validation results
   */
  private generateRecommendations(
    fieldValidation: FieldValidationResult[],
    temporalValidation: TemporalValidationResult,
    valueValidation: ValueValidationResult,
    errors: ValidationIssue[],
    warnings: ValidationIssue[]
  ): string[] {
    const recommendations: string[] = [];

    // Missing required fields
    const missingRequired = fieldValidation.filter(f => f.isRequired && !f.isPresent);
    if (missingRequired.length > 0) {
      const fields = missingRequired.map(f => f.mappedType).join(', ');
      recommendations.push(`Map missing required fields: ${fields}`);
    }

    // High null rates
    const highNull = fieldValidation.filter(f => f.isRequired && f.nullRate > 0.1);
    if (highNull.length > 0) {
      recommendations.push('Check data source for missing values in critical fields');
    }

    // Data gaps
    if (temporalValidation.gaps.length > 5) {
      recommendations.push('Investigate data gaps - may indicate sensor or connectivity issues');
    }

    // Low completeness
    if (temporalValidation.resolution && temporalValidation.resolution.completeness < 0.8) {
      recommendations.push(
        `Data completeness is ${(temporalValidation.resolution.completeness * 100).toFixed(0)}% - ` +
        'consider filling gaps or adjusting analysis period'
      );
    }

    // Impossible values
    if (valueValidation.impossibleValues.length > 0) {
      recommendations.push('Review sensor calibration - some values exceed physical limits');
    }

    // Correlation issues
    if (valueValidation.correlationIssues.length > 0) {
      recommendations.push('Check sensor alignment - inconsistencies detected between related measurements');
    }

    // Missing recommended fields
    const missingRec = fieldValidation.filter(f => !f.isRequired && !f.isPresent);
    if (missingRec.length > 0) {
      recommendations.push(
        'Consider adding temperature measurements for more accurate performance analysis'
      );
    }

    return recommendations;
  }

  /**
   * Format interval in human-readable form
   */
  private formatInterval(ms: number): string {
    const minutes = ms / (1000 * 60);
    if (minutes < 60) return `${Math.round(minutes)}min`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }
}

// Export singleton and utility functions
export const dataQualityValidator = new DataQualityValidator();

export function validateData(
  data: DataRow[],
  mappings: FieldMappingResult[],
  options?: ValidationOptions
): ValidationResult {
  const validator = new DataQualityValidator(options);
  return validator.validate(data, mappings);
}

export function quickValidate(
  data: DataRow[],
  mappings: FieldMappingResult[]
): { isValid: boolean; score: number; issues: string[] } {
  const result = validateData(data, mappings);
  return {
    isValid: result.isValid,
    score: result.qualityScore,
    issues: [
      ...result.errors.map(e => `Error: ${e.message}`),
      ...result.warnings.map(w => `Warning: ${w.message}`),
    ],
  };
}
