/**
 * Formatting Utilities
 * Common formatters for currency, numbers, percentages, and dates
 */

/**
 * Format currency (USD by default)
 */
export function formatCurrency(
  value: number,
  options: {
    currency?: string;
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {}
): string {
  const {
    currency = 'USD',
    locale = 'en-US',
    minimumFractionDigits = 0,
    maximumFractionDigits = 0
  } = options;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits,
    maximumFractionDigits
  }).format(value);
}

/**
 * Format large currency values with K/M suffix
 */
export function formatCompactCurrency(value: number, currency: string = 'USD'): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return formatCurrency(value, { currency });
}

/**
 * Format number with thousand separators
 */
export function formatNumber(
  value: number,
  options: {
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {}
): string {
  const {
    locale = 'en-US',
    minimumFractionDigits = 0,
    maximumFractionDigits = 2
  } = options;

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits
  }).format(value);
}

/**
 * Format percentage
 */
export function formatPercentage(
  value: number,
  options: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    includeSign?: boolean;
  } = {}
): string {
  const {
    minimumFractionDigits = 0,
    maximumFractionDigits = 1,
    includeSign = false
  } = options;

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits,
    maximumFractionDigits
  }).format(value / 100);

  if (includeSign && value > 0) {
    return `+${formatted}`;
  }

  return formatted;
}

/**
 * Format energy (kWh, MWh, GWh)
 */
export function formatEnergy(kWh: number): string {
  if (kWh >= 1_000_000) {
    return `${(kWh / 1_000_000).toFixed(2)} GWh`;
  }
  if (kWh >= 1_000) {
    return `${(kWh / 1_000).toFixed(1)} MWh`;
  }
  return `${kWh.toFixed(0)} kWh`;
}

/**
 * Format capacity (kW, MW, GW)
 */
export function formatCapacity(kW: number): string {
  if (kW >= 1_000_000) {
    return `${(kW / 1_000_000).toFixed(2)} GW`;
  }
  if (kW >= 1_000) {
    return `${(kW / 1_000).toFixed(1)} MW`;
  }
  return `${kW.toFixed(0)} kW`;
}

/**
 * Format duration in months/years
 */
export function formatDuration(months: number): string {
  if (months < 12) {
    return `${Math.round(months)} ${months === 1 ? 'month' : 'months'}`;
  }
  const years = months / 12;
  if (years < 2) {
    return `${years.toFixed(1)} years`;
  }
  return `${Math.round(years)} years`;
}

/**
 * Format payback period (emphasize < 1 year)
 */
export function formatPaybackPeriod(months: number): string {
  if (months < 6) {
    return `${Math.round(months)} months`;
  }
  if (months < 12) {
    return `${months.toFixed(1)} months`;
  }
  if (months < 18) {
    return `${(months / 12).toFixed(1)} years`;
  }
  return `${Math.round(months / 12)} years`;
}

/**
 * Format ROI ratio (e.g., "3.2x" or "320%")
 */
export function formatROI(ratio: number, format: 'multiplier' | 'percentage' = 'multiplier'): string {
  if (format === 'multiplier') {
    return `${ratio.toFixed(1)}x`;
  }
  return formatPercentage((ratio - 1) * 100);
}

/**
 * Format date range
 */
export function formatDateRange(start: Date, end: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  };
  const startStr = start.toLocaleDateString('en-US', options);
  const endStr = end.toLocaleDateString('en-US', options);
  return `${startStr} - ${endStr}`;
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return `${diffDay} ${diffDay === 1 ? 'day' : 'days'} ago`;
  }
  if (diffHour > 0) {
    return `${diffHour} ${diffHour === 1 ? 'hour' : 'hours'} ago`;
  }
  if (diffMin > 0) {
    return `${diffMin} ${diffMin === 1 ? 'minute' : 'minutes'} ago`;
  }
  return 'Just now';
}

/**
 * Format file size (bytes to KB/MB/GB)
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(2)} KB`;
  }
  return `${bytes} bytes`;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Format phone number (US format)
 */
export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

/**
 * Format region name for display
 */
export function formatRegionName(region: string): string {
  const regionMap: Record<string, string> = {
    'uae': 'United Arab Emirates',
    'gcc': 'GCC Region',
    'netherlands': 'Netherlands',
    'spain': 'Spain',
    'europe': 'Central Europe',
    'africa': 'Sub-Saharan Africa'
  };
  return regionMap[region.toLowerCase()] || region;
}

/**
 * Format metric value with appropriate suffix
 */
export function formatMetricValue(
  value: number,
  type: 'currency' | 'energy' | 'capacity' | 'percentage' | 'number'
): string {
  switch (type) {
    case 'currency':
      return formatCompactCurrency(value);
    case 'energy':
      return formatEnergy(value);
    case 'capacity':
      return formatCapacity(value);
    case 'percentage':
      return formatPercentage(value);
    case 'number':
      return formatNumber(value);
    default:
      return String(value);
  }
}
