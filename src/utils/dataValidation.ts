/**
 * Data validation utilities for the HeliosIQ dashboard
 */

/**
 * Validates if a value is a valid number and not NaN
 */
export function isValidNumber(value: any): value is number {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

/**
 * Safely converts a value to a number, returning a default if invalid
 */
export function safeNumber(value: any, defaultValue: number = 0): number {
  if (isValidNumber(value)) return value;
  
  const parsed = parseFloat(value);
  return isValidNumber(parsed) ? parsed : defaultValue;
}

/**
 * Validates prediction data structure
 */
export interface PredictionDataPoint {
  timestamp: string;
  truePower?: number;
  predictedPower?: number;
  irradiance?: number;
  inverterId?: string;
}

export function isValidPredictionData(data: any): data is PredictionDataPoint {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.timestamp === 'string' &&
    data.timestamp.length > 0
  );
}

/**
 * Validates and cleans prediction data array
 */
export function validatePredictionDataArray(data: any[]): PredictionDataPoint[] {
  if (!Array.isArray(data)) return [];
  
  return data.filter(isValidPredictionData).map((point: any) => ({
    timestamp: point.timestamp,
    truePower: safeNumber(point.truePower || (point as any).true_power),
    predictedPower: safeNumber(point.predictedPower || (point as any).predicted_power),
    irradiance: safeNumber(point.irradiance),
    inverterId: point.inverterId || (point as any).inverter_id || 'unknown'
  }));
}

/**
 * Validates alert data structure
 */
export interface AlertMetrics {
  actualPower: number;
  expectedPower: number;
  performanceRatio: number;
  underperformancePercent: number;
  rollingAverage24h?: number;
  rollingAverage7d?: number;
}

export function isValidAlertMetrics(metrics: any): metrics is AlertMetrics {
  return (
    metrics &&
    typeof metrics === 'object' &&
    isValidNumber(metrics.actualPower) &&
    isValidNumber(metrics.expectedPower) &&
    isValidNumber(metrics.performanceRatio) &&
    isValidNumber(metrics.underperformancePercent)
  );
}

/**
 * Validates time series data for charts
 */
export function validateTimeSeriesData(data: any[]): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  
  // Check if data points have required timestamp field
  return data.every(point => 
    point && 
    (point.timestamp || point.period) &&
    typeof (point.timestamp || point.period) === 'string'
  );
}

/**
 * Sanitizes data to prevent XSS and other security issues
 */
export function sanitizeString(value: any): string {
  if (typeof value !== 'string') {
    return String(value || '');
  }
  
  // Basic sanitization - remove potentially dangerous characters
  return value
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/data:/gi, '')
    .trim();
}

/**
 * Validates API response structure
 */
export function isValidAPIResponse(response: any): boolean {
  return (
    response &&
    typeof response === 'object' &&
    !response.error
  );
}

/**
 * Safe array access with fallback
 */
export function safeArrayAccess<T>(array: T[] | undefined | null, index: number, fallback: T): T {
  if (!Array.isArray(array) || index < 0 || index >= array.length) {
    return fallback;
  }
  return array[index];
}

/**
 * Safe object property access with fallback
 */
export function safePropertyAccess<T>(obj: any, property: string, fallback: T): T {
  if (!obj || typeof obj !== 'object') return fallback;
  
  const value = obj[property];
  return value !== undefined && value !== null ? value : fallback;
}

/**
 * Validates percentage values (0-100)
 */
export function isValidPercentage(value: any): boolean {
  return isValidNumber(value) && value >= 0 && value <= 100;
}

/**
 * Validates power values (non-negative)
 */
export function isValidPowerValue(value: any): boolean {
  return isValidNumber(value) && value >= 0;
}

/**
 * Validates performance ratio (0-2, allowing for over-performance)
 */
export function isValidPerformanceRatio(value: any): boolean {
  return isValidNumber(value) && value >= 0 && value <= 2;
}