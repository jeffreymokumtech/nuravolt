/**
 * Dust Data Fetcher - Fetch PM10, PM2.5, and dust data from Open-Meteo Air Quality API
 *
 * Uses Open-Meteo Air Quality API which derives data from CAMS (Copernicus Atmosphere Monitoring Service).
 * Free to use, no API key required.
 *
 * API Docs: https://open-meteo.com/en/docs/air-quality-api
 *
 * Limitations:
 * - Historical data limited to ~92 days
 * - Forecast data up to 5 days
 * - 4-day European forecasts, global coverage available
 */

export interface DustDataPoint {
  date: string;
  pm10: number | null;          // μg/m³
  pm2_5: number | null;         // μg/m³
  dust: number | null;          // μg/m³ (Saharan dust at 10m)
  aqi_eu: number | null;        // European AQI
  aqi_us: number | null;        // US AQI
}

export interface DustHistoryData {
  metadata: {
    latitude: number;
    longitude: number;
    timezone: string;
    generated_at: string;
    source: string;
    period: {
      start: string;
      end: string;
    };
  };
  statistics?: {
    total_days: number;
    high_dust_days: number;     // Days with dust > 50 μg/m³
    very_high_dust_days: number; // Days with dust > 100 μg/m³
    avg_pm10: number;
    avg_pm2_5: number;
    max_dust: number;
    max_dust_date: string;
  };
  daily_data: DustDataPoint[];
}

interface OpenMeteoAirQualityResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  hourly: {
    time: string[];
    pm10?: (number | null)[];
    pm2_5?: (number | null)[];
    dust?: (number | null)[];
    european_aqi?: (number | null)[];
    us_aqi?: (number | null)[];
  };
}

/**
 * Fetch dust/air quality data from Open-Meteo
 */
export async function fetchDustData(
  latitude: number,
  longitude: number,
  pastDays: number = 92,  // Maximum historical days available
  forecastDays: number = 5
): Promise<DustHistoryData> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    hourly: 'pm10,pm2_5,dust,european_aqi,us_aqi',
    past_days: pastDays.toString(),
    forecast_days: forecastDays.toString(),
    timezone: 'Europe/Madrid',
  });

  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch dust data: ${response.statusText}`);
  }

  const data: OpenMeteoAirQualityResponse = await response.json();

  // Aggregate hourly data to daily
  const dailyData = aggregateToDaily(data);

  // Calculate statistics
  const statistics = calculateStatistics(dailyData);

  // Get date range
  const dates = dailyData.map(d => d.date).sort();
  const period = {
    start: dates[0] || '',
    end: dates[dates.length - 1] || '',
  };

  return {
    metadata: {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      generated_at: new Date().toISOString(),
      source: 'Open-Meteo Air Quality API (CAMS)',
      period,
    },
    statistics,
    daily_data: dailyData,
  };
}

/**
 * Aggregate hourly air quality data to daily values
 */
function aggregateToDaily(data: OpenMeteoAirQualityResponse): DustDataPoint[] {
  const hourlyData = data.hourly;
  if (!hourlyData.time || hourlyData.time.length === 0) {
    return [];
  }

  // Group by date
  const dailyGroups = new Map<string, {
    pm10: number[];
    pm2_5: number[];
    dust: number[];
    aqi_eu: number[];
    aqi_us: number[];
  }>();

  for (let i = 0; i < hourlyData.time.length; i++) {
    const dateTime = hourlyData.time[i];
    const date = dateTime.split('T')[0];

    if (!dailyGroups.has(date)) {
      dailyGroups.set(date, {
        pm10: [],
        pm2_5: [],
        dust: [],
        aqi_eu: [],
        aqi_us: [],
      });
    }

    const group = dailyGroups.get(date)!;

    if (hourlyData.pm10?.[i] != null) group.pm10.push(hourlyData.pm10[i]!);
    if (hourlyData.pm2_5?.[i] != null) group.pm2_5.push(hourlyData.pm2_5[i]!);
    if (hourlyData.dust?.[i] != null) group.dust.push(hourlyData.dust[i]!);
    if (hourlyData.european_aqi?.[i] != null) group.aqi_eu.push(hourlyData.european_aqi[i]!);
    if (hourlyData.us_aqi?.[i] != null) group.aqi_us.push(hourlyData.us_aqi[i]!);
  }

  // Calculate daily averages/max
  const dailyData: DustDataPoint[] = [];

  for (const [date, group] of dailyGroups) {
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const max = (arr: number[]) => arr.length > 0 ? Math.max(...arr) : null;

    dailyData.push({
      date,
      pm10: avg(group.pm10) ? Math.round(avg(group.pm10)! * 10) / 10 : null,
      pm2_5: avg(group.pm2_5) ? Math.round(avg(group.pm2_5)! * 10) / 10 : null,
      dust: max(group.dust) ? Math.round(max(group.dust)! * 10) / 10 : null, // Use max for dust events
      aqi_eu: max(group.aqi_eu),
      aqi_us: max(group.aqi_us),
    });
  }

  return dailyData.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calculate statistics from daily dust data
 */
function calculateStatistics(dailyData: DustDataPoint[]): DustHistoryData['statistics'] {
  if (dailyData.length === 0) {
    return undefined;
  }

  const dustValues = dailyData.filter(d => d.dust != null).map(d => d.dust!);
  const pm10Values = dailyData.filter(d => d.pm10 != null).map(d => d.pm10!);
  const pm2_5Values = dailyData.filter(d => d.pm2_5 != null).map(d => d.pm2_5!);

  const highDustThreshold = 50;  // μg/m³
  const veryHighDustThreshold = 100; // μg/m³

  const highDustDays = dustValues.filter(v => v > highDustThreshold).length;
  const veryHighDustDays = dustValues.filter(v => v > veryHighDustThreshold).length;

  const maxDust = dustValues.length > 0 ? Math.max(...dustValues) : 0;
  const maxDustDate = dailyData.find(d => d.dust === maxDust)?.date || '';

  return {
    total_days: dailyData.length,
    high_dust_days: highDustDays,
    very_high_dust_days: veryHighDustDays,
    avg_pm10: pm10Values.length > 0 ? Math.round(pm10Values.reduce((a, b) => a + b, 0) / pm10Values.length * 10) / 10 : 0,
    avg_pm2_5: pm2_5Values.length > 0 ? Math.round(pm2_5Values.reduce((a, b) => a + b, 0) / pm2_5Values.length * 10) / 10 : 0,
    max_dust: Math.round(maxDust * 10) / 10,
    max_dust_date: maxDustDate,
  };
}

/**
 * Classify dust event severity
 */
export function classifyDustEvent(dustLevel: number): 'none' | 'light' | 'moderate' | 'heavy' | 'severe' {
  if (dustLevel < 10) return 'none';
  if (dustLevel < 50) return 'light';
  if (dustLevel < 100) return 'moderate';
  if (dustLevel < 200) return 'heavy';
  return 'severe';
}

/**
 * Get dust level description and color
 */
export function getDustLevelInfo(dustLevel: number): { label: string; color: string; impact: string } {
  const severity = classifyDustEvent(dustLevel);

  switch (severity) {
    case 'none':
      return { label: 'Clean', color: '#10B981', impact: 'No soiling impact expected' };
    case 'light':
      return { label: 'Light Dust', color: '#FBBF24', impact: 'Minor soiling accumulation' };
    case 'moderate':
      return { label: 'Moderate Dust', color: '#F97316', impact: 'Noticeable soiling, may warrant attention' };
    case 'heavy':
      return { label: 'Heavy Dust', color: '#EF4444', impact: 'Significant soiling, cleaning recommended' };
    case 'severe':
      return { label: 'Severe Dust Storm', color: '#7C2D12', impact: 'Major soiling event, cleaning required' };
  }
}
