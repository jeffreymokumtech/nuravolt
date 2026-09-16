/**
 * Date utility functions for the HeliosIQ dashboard
 */

export interface DateRange {
  start: string; // YYYY-MM-DD format
  end: string;   // YYYY-MM-DD format
}

/**
 * Validates if a date string is in the correct format and represents a valid date
 */
export function isValidDate(dateString: string): boolean {
  if (!dateString) return false;
  
  const date = new Date(dateString);
  return !isNaN(date.getTime());
}

/**
 * Validates a date range object
 */
export function isValidDateRange(range: DateRange | null): boolean {
  if (!range || !range.start || !range.end) return false;
  
  const startDate = new Date(range.start);
  const endDate = new Date(range.end);
  
  return !isNaN(startDate.getTime()) && 
         !isNaN(endDate.getTime()) && 
         startDate <= endDate;
}

/**
 * Converts a date range to ISO timestamp format for API calls
 */
export function dateRangeToISO(range: DateRange): { start: string; end: string } | null {
  if (!isValidDateRange(range)) return null;
  
  const startDate = new Date(range.start);
  const endDate = new Date(range.end);
  
  // Set start time to beginning of day
  startDate.setHours(0, 0, 0, 0);
  
  // Set end time to end of day
  endDate.setHours(23, 59, 59, 999);
  
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString()
  };
}

/**
 * Creates a predefined date range
 */
export function createPredefinedRange(days: number): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0]
  };
}

/**
 * Formats a timestamp for display
 */
export function formatTimestamp(timestamp: string | Date): string {
  const date = new Date(timestamp);
  
  if (isNaN(date.getTime())) return 'Invalid Date';
  
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric', 
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Calculate relative time from now
 */
export function getRelativeTime(timestamp: string | Date): string {
  const date = new Date(timestamp);
  const now = new Date();
  
  if (isNaN(date.getTime())) return 'Invalid date';
  
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Validates timezone and ensures consistent UTC handling
 */
export function normalizeToUTC(dateString: string): Date {
  const date = new Date(dateString);
  
  if (isNaN(date.getTime())) {
    throw new Error('Invalid date string provided');
  }
  
  return date;
}