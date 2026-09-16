/**
 * Utility functions for consistent number formatting across the dashboard
 */

/**
 * Format a number to a maximum of 2 decimal places
 * Removes unnecessary trailing zeros
 */
export function formatNumber(value: number | string | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined) return '0';
  
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  
  // Round to specified decimal places and remove trailing zeros
  return parseFloat(num.toFixed(decimals)).toString();
}

/**
 * Format power values with appropriate units (W, kW, MW)
 */
export function formatPower(watts: number | string | null | undefined): string {
  const num = typeof watts === 'string' ? parseFloat(watts) : (watts || 0);
  if (isNaN(num)) return '0 W';
  
  if (num >= 1000000) {
    return `${formatNumber(num / 1000000)} MW`;
  } else if (num >= 1000) {
    return `${formatNumber(num / 1000)} kW`;
  } else {
    return `${formatNumber(num)} W`;
  }
}

/**
 * Format energy values with appropriate units (Wh, kWh, MWh)
 */
export function formatEnergy(wattHours: number | string | null | undefined): string {
  const num = typeof wattHours === 'string' ? parseFloat(wattHours) : (wattHours || 0);
  if (isNaN(num)) return '0 Wh';
  
  if (num >= 1000000) {
    return `${formatNumber(num / 1000000)} MWh`;
  } else if (num >= 1000) {
    return `${formatNumber(num / 1000)} kWh`;
  } else {
    return `${formatNumber(num)} Wh`;
  }
}

/**
 * Format percentage values
 */
export function formatPercentage(value: number | string | null | undefined, decimals: number = 1): string {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  if (isNaN(num)) return '0%';
  
  return `${formatNumber(num, decimals)}%`;
}

/**
 * Format currency values
 */
export function formatCurrency(value: number | string | null | undefined, currency: string = '€'): string {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  if (isNaN(num)) return `${currency}0`;
  
  // Use locale-appropriate number formatting
  return `${currency}${formatNumber(num, 2)}`;
}

/**
 * Format metric values (R², MAPE, etc.)
 */
export function formatMetric(value: number | string | null | undefined, decimals: number = 3): string {
  return formatNumber(value, decimals);
}

/**
 * Truncate long text to fit in cards
 */
export function truncateText(text: string, maxLength: number = 20): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}