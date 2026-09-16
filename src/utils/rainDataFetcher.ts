/**
 * Rain Data Fetcher - Open-Meteo Historical Weather API Integration
 *
 * Fetches historical precipitation data for soiling analysis.
 * Uses Open-Meteo's free API (no authentication required).
 *
 * @see https://open-meteo.com/en/docs/historical-weather-api
 */

import type {
  RainDataPoint,
  RainCleaningEvent,
  RainHistoryData,
} from '@/types/soiling';

// Configuration constants
const OPEN_METEO_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CLEANING_THRESHOLD_MM = 5.0;  // >5mm = natural cleaning event
const HEAVY_RAIN_THRESHOLD_MM = 10.0;  // >10mm = very effective cleaning

/**
 * Rain forecast data point
 */
export interface RainForecastPoint {
  date: string;
  precipitation_mm: number;
  precipitation_probability: number;  // 0-100%
  is_rain_expected: boolean;
  is_heavy_rain_expected: boolean;
}

/**
 * Open-Meteo forecast API response structure
 */
interface OpenMeteoForecastResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  daily: {
    time: string[];
    precipitation_sum: number[];
    precipitation_probability_max: number[];
  };
}

/**
 * Fetch 7-day rain forecast from Open-Meteo API
 *
 * @param lat - Latitude of the location
 * @param lon - Longitude of the location
 * @returns Array of daily rain forecast points
 */
export async function fetchRainForecast(
  lat: number,
  lon: number
): Promise<RainForecastPoint[]> {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', lat.toString());
  url.searchParams.set('longitude', lon.toString());
  url.searchParams.set('daily', 'precipitation_sum,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Open-Meteo Forecast API error: ${response.status} ${response.statusText}`);
    }

    const data: OpenMeteoForecastResponse = await response.json();

    // Transform to RainForecastPoint array
    const forecastData: RainForecastPoint[] = data.daily.time.map((date, index) => {
      const precipitation = data.daily.precipitation_sum[index] ?? 0;
      const probability = data.daily.precipitation_probability_max[index] ?? 0;
      return {
        date,
        precipitation_mm: parseFloat(precipitation.toFixed(1)),
        precipitation_probability: probability,
        is_rain_expected: probability >= 50 && precipitation >= 1.0,
        is_heavy_rain_expected: probability >= 60 && precipitation >= CLEANING_THRESHOLD_MM,
      };
    });

    return forecastData;
  } catch (error) {
    console.error('Error fetching rain forecast from Open-Meteo:', error);
    throw error;
  }
}

/**
 * Check if a cleaning date conflicts with upcoming rain
 *
 * @param cleaningDate - Proposed cleaning date (YYYY-MM-DD)
 * @param forecast - Rain forecast data
 * @param daysToCheck - Days before/after to check for rain (default: 3)
 * @returns Warning info if conflict exists
 */
export function checkRainConflict(
  cleaningDate: string,
  forecast: RainForecastPoint[],
  daysToCheck: number = 3
): { hasConflict: boolean; message: string; rainDays: RainForecastPoint[] } {
  const cleaningDateObj = new Date(cleaningDate);
  const conflictingDays = forecast.filter(f => {
    const forecastDate = new Date(f.date);
    const daysDiff = (forecastDate.getTime() - cleaningDateObj.getTime()) / (1000 * 60 * 60 * 24);
    // Check if rain is expected within daysToCheck days after cleaning
    return daysDiff >= 0 && daysDiff <= daysToCheck && f.is_rain_expected;
  });

  if (conflictingDays.length === 0) {
    return { hasConflict: false, message: '', rainDays: [] };
  }

  const heavyRainDays = conflictingDays.filter(d => d.is_heavy_rain_expected);
  if (heavyRainDays.length > 0) {
    return {
      hasConflict: true,
      message: `Heavy rain (${heavyRainDays[0].precipitation_mm}mm) expected on ${heavyRainDays[0].date}. Consider postponing cleaning.`,
      rainDays: conflictingDays,
    };
  }

  return {
    hasConflict: true,
    message: `Rain expected within ${daysToCheck} days (${conflictingDays[0].precipitation_probability}% probability). Cleaning may be less effective.`,
    rainDays: conflictingDays,
  };
}

/**
 * Open-Meteo API response structure
 */
interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  daily: {
    time: string[];
    precipitation_sum: number[];
  };
  daily_units: {
    time: string;
    precipitation_sum: string;
  };
}

/**
 * Fetch historical rain data from Open-Meteo API
 *
 * @param lat - Latitude of the location
 * @param lon - Longitude of the location
 * @param startDate - Start date (YYYY-MM-DD)
 * @param endDate - End date (YYYY-MM-DD)
 * @returns Array of daily rain data points
 */
export async function fetchHistoricalRainData(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string
): Promise<RainDataPoint[]> {
  const url = new URL(OPEN_METEO_BASE_URL);
  url.searchParams.set('latitude', lat.toString());
  url.searchParams.set('longitude', lon.toString());
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('timezone', 'auto');

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
    }

    const data: OpenMeteoResponse = await response.json();

    // Transform to RainDataPoint array
    const rainData: RainDataPoint[] = data.daily.time.map((date, index) => {
      const precipitation = data.daily.precipitation_sum[index] ?? 0;
      return {
        date,
        precipitation_mm: parseFloat(precipitation.toFixed(1)),
        is_cleaning_event: precipitation >= CLEANING_THRESHOLD_MM,
        is_heavy_rain: precipitation >= HEAVY_RAIN_THRESHOLD_MM,
      };
    });

    return rainData;
  } catch (error) {
    console.error('Error fetching rain data from Open-Meteo:', error);
    throw error;
  }
}

/**
 * Extract cleaning events from rain data
 *
 * @param rainData - Array of daily rain data points
 * @returns Array of cleaning events (days with >5mm precipitation)
 */
export function extractCleaningEvents(rainData: RainDataPoint[]): RainCleaningEvent[] {
  return rainData
    .filter(d => d.is_cleaning_event)
    .map(d => ({
      date: d.date,
      amount_mm: d.precipitation_mm,
      type: d.is_heavy_rain ? 'heavy' as const : 'moderate' as const,
      // Estimate SR recovery based on rain amount
      // Heavy rain (>10mm): ~5% recovery, Moderate (5-10mm): ~2% recovery
      expected_sr_recovery: d.is_heavy_rain ? 0.05 : 0.02,
    }));
}

/**
 * Calculate rain statistics
 */
export function calculateRainStatistics(rainData: RainDataPoint[]) {
  const totalDays = rainData.length;
  const rainDays = rainData.filter(d => d.precipitation_mm > 0).length;
  const cleaningEvents = rainData.filter(d => d.is_cleaning_event).length;
  const heavyRainDays = rainData.filter(d => d.is_heavy_rain).length;

  // Calculate average monthly precipitation
  const totalPrecip = rainData.reduce((sum, d) => sum + d.precipitation_mm, 0);
  const months = totalDays / 30.44; // Average days per month
  const avgMonthlyPrecip = months > 0 ? totalPrecip / months : 0;

  return {
    total_days: totalDays,
    rain_days: rainDays,
    cleaning_events_count: cleaningEvents,
    heavy_rain_count: heavyRainDays,
    avg_monthly_precipitation: parseFloat(avgMonthlyPrecip.toFixed(1)),
  };
}

/**
 * Build complete rain history data structure
 *
 * @param plantId - Plant identifier
 * @param lat - Latitude
 * @param lon - Longitude
 * @param startDate - Start date
 * @param endDate - End date
 * @returns Complete rain history data structure
 */
export async function buildRainHistoryData(
  plantId: string,
  lat: number,
  lon: number,
  startDate: string,
  endDate: string
): Promise<RainHistoryData> {
  // Fetch raw data
  const dailyData = await fetchHistoricalRainData(lat, lon, startDate, endDate);

  // Extract cleaning events
  const cleaningEvents = extractCleaningEvents(dailyData);

  // Calculate statistics
  const statistics = calculateRainStatistics(dailyData);

  return {
    metadata: {
      plant_id: plantId,
      latitude: lat,
      longitude: lon,
      period: { start: startDate, end: endDate },
      source: 'Open-Meteo Historical Weather API',
      cleaning_threshold_mm: CLEANING_THRESHOLD_MM,
      generated_at: new Date().toISOString(),
    },
    daily_data: dailyData,
    cleaning_events: cleaningEvents,
    statistics,
  };
}

/**
 * Load rain history from JSON file (client-side)
 *
 * @param plantId - Plant identifier
 * @returns Rain history data or null if not found
 */
export async function loadRainHistory(
  plantId: string,
  dataRoot: string = '/data',
): Promise<RainHistoryData | null> {
  try {
    const response = await fetch(`${dataRoot}/soiling/${plantId}/rain_history.json`);
    if (!response.ok) {
      console.warn(`Rain history not found for plant ${plantId}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('Error loading rain history:', error);
    return null;
  }
}

/**
 * Load CHIRPS Preliminary recent data from JSON file (client-side)
 *
 * @param plantId - Plant identifier
 * @returns Array of recent rain data points (last 60 days)
 */
export async function loadRainRecent(
  plantId: string,
  dataRoot: string = '/data',
): Promise<RainDataPoint[]> {
  try {
    const response = await fetch(`${dataRoot}/soiling/${plantId}/rain_recent.json`);
    if (!response.ok) return [];

    const data = await response.json();
    return data.daily_data || [];
  } catch (error) {
    console.error(`Failed to load recent rain data for ${plantId}:`, error);
    return [];
  }
}

/**
 * Load CHIRPS-GEFS rain forecast from JSON file (client-side)
 *
 * @param plantId - Plant identifier
 * @returns Array of forecast rain data points (16-day forecast)
 */
export async function loadRainForecast(
  plantId: string,
  dataRoot: string = '/data',
): Promise<RainDataPoint[]> {
  try {
    const response = await fetch(`${dataRoot}/soiling/${plantId}/rain_forecast.json`);
    if (!response.ok) {
      console.warn(`Rain forecast not found for ${plantId}, using empty forecast`);
      return [];
    }

    const data = await response.json();
    return data.daily_forecast || [];
  } catch (error) {
    console.error(`Failed to load rain forecast for ${plantId}:`, error);
    return [];
  }
}

/**
 * Load and merge all rain data sources (CHIRPS Final + Preliminary + GEFS)
 *
 * Merges historical, recent, and forecast data with proper prioritization:
 * - CHIRPS Final (highest quality) - historical training data
 * - CHIRPS Preliminary (medium quality) - recent monitoring data
 * - CHIRPS-GEFS (forecast quality) - 16-day forecast
 *
 * @param plantId - Plant identifier
 * @returns Complete timeline of rain data points
 */
export async function loadCompleteRainData(plantId: string): Promise<RainDataPoint[]> {
  const [historyData, recent, forecast] = await Promise.all([
    loadRainHistory(plantId),   // CHIRPS Final (2019-2024)
    loadRainRecent(plantId),    // CHIRPS Preliminary (last 60 days)
    loadRainForecast(plantId),  // CHIRPS-GEFS (next 16 days)
  ]);

  // Extract daily data from history
  const history = historyData?.daily_data || [];

  // Merge with priority: history (highest quality) > recent > forecast
  // Remove duplicates, preferring earlier source
  const dataMap = new Map<string, RainDataPoint>();

  // Add forecast first (lowest priority)
  forecast.forEach(d => dataMap.set(d.date, d));

  // Add recent (medium priority, overwrites forecast if overlap)
  recent.forEach(d => dataMap.set(d.date, d));

  // Add history (highest priority, overwrites all)
  history.forEach(d => dataMap.set(d.date, d));

  // Sort by date and return
  return Array.from(dataMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

/**
 * Get rain data for a specific date range (from loaded history)
 *
 * @param history - Full rain history data
 * @param startDate - Filter start date
 * @param endDate - Filter end date
 * @returns Filtered rain data points
 */
export function filterRainDataByDateRange(
  history: RainHistoryData,
  startDate: string,
  endDate: string
): RainDataPoint[] {
  return history.daily_data.filter(d => d.date >= startDate && d.date <= endDate);
}

/**
 * Find nearest rain event before a given date
 * Useful for analyzing SR recovery patterns
 */
export function findPreviousRainEvent(
  history: RainHistoryData,
  date: string,
  maxDaysBack: number = 30
): RainCleaningEvent | null {
  const targetDate = new Date(date);
  const minDate = new Date(targetDate);
  minDate.setDate(minDate.getDate() - maxDaysBack);

  const events = history.cleaning_events
    .filter(e => {
      const eventDate = new Date(e.date);
      return eventDate < targetDate && eventDate >= minDate;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return events[0] || null;
}

/**
 * Calculate days since last cleaning event
 */
export function daysSinceLastRainCleaning(
  history: RainHistoryData,
  date: string
): number | null {
  const lastEvent = findPreviousRainEvent(history, date, 365);
  if (!lastEvent) return null;

  const targetDate = new Date(date);
  const eventDate = new Date(lastEvent.date);
  const diffTime = targetDate.getTime() - eventDate.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}
