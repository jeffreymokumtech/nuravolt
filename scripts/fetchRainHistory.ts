/**
 * Script to fetch historical rain data from Open-Meteo API
 * and save as JSON for the soiling intelligence feature.
 *
 * Usage: npx ts-node scripts/fetchRainHistory.ts
 */

const OPEN_METEO_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const CLEANING_THRESHOLD_MM = 5.0;
const HEAVY_RAIN_THRESHOLD_MM = 10.0;

interface RainDataPoint {
  date: string;
  precipitation_mm: number;
  is_cleaning_event: boolean;
  is_heavy_rain: boolean;
}

interface RainCleaningEvent {
  date: string;
  amount_mm: number;
  type: 'moderate' | 'heavy';
  expected_sr_recovery: number;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  daily: {
    time: string[];
    precipitation_sum: number[];
  };
}

interface RainHistoryData {
  metadata: {
    plant_id: string;
    latitude: number;
    longitude: number;
    period: { start: string; end: string };
    source: string;
    cleaning_threshold_mm: number;
    generated_at: string;
  };
  daily_data: RainDataPoint[];
  cleaning_events: RainCleaningEvent[];
  statistics: {
    total_days: number;
    rain_days: number;
    cleaning_events_count: number;
    heavy_rain_count: number;
    avg_monthly_precipitation: number;
  };
}

async function fetchRainData(
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

  console.log(`Fetching rain data from ${startDate} to ${endDate}...`);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
  }

  const data: OpenMeteoResponse = await response.json();

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
}

function extractCleaningEvents(rainData: RainDataPoint[]): RainCleaningEvent[] {
  return rainData
    .filter(d => d.is_cleaning_event)
    .map(d => ({
      date: d.date,
      amount_mm: d.precipitation_mm,
      type: d.is_heavy_rain ? 'heavy' as const : 'moderate' as const,
      expected_sr_recovery: d.is_heavy_rain ? 0.05 : 0.02,
    }));
}

function calculateStatistics(rainData: RainDataPoint[]) {
  const totalDays = rainData.length;
  const rainDays = rainData.filter(d => d.precipitation_mm > 0).length;
  const cleaningEvents = rainData.filter(d => d.is_cleaning_event).length;
  const heavyRainDays = rainData.filter(d => d.is_heavy_rain).length;

  const totalPrecip = rainData.reduce((sum, d) => sum + d.precipitation_mm, 0);
  const months = totalDays / 30.44;
  const avgMonthlyPrecip = months > 0 ? totalPrecip / months : 0;

  return {
    total_days: totalDays,
    rain_days: rainDays,
    cleaning_events_count: cleaningEvents,
    heavy_rain_count: heavyRainDays,
    avg_monthly_precipitation: parseFloat(avgMonthlyPrecip.toFixed(1)),
  };
}

async function main() {
  // ALPHA1 plant configuration
  const plantId = 'alpha1';
  const latitude = 37.8145;
  const longitude = -3.8047;
  const startDate = '2019-01-01';
  const endDate = '2025-12-08';

  console.log(`\nFetching rain history for ${plantId}`);
  console.log(`Location: ${latitude}, ${longitude} (Andalusia, Spain)`);
  console.log(`Period: ${startDate} to ${endDate}\n`);

  try {
    // Fetch all rain data
    const dailyData = await fetchRainData(latitude, longitude, startDate, endDate);

    console.log(`Received ${dailyData.length} days of data`);

    // Extract cleaning events
    const cleaningEvents = extractCleaningEvents(dailyData);
    console.log(`Found ${cleaningEvents.length} natural cleaning events (>5mm)`);

    // Calculate statistics
    const statistics = calculateStatistics(dailyData);

    // Build final structure
    const rainHistory: RainHistoryData = {
      metadata: {
        plant_id: plantId,
        latitude,
        longitude,
        period: { start: startDate, end: endDate },
        source: 'Open-Meteo Historical Weather API',
        cleaning_threshold_mm: CLEANING_THRESHOLD_MM,
        generated_at: new Date().toISOString(),
      },
      daily_data: dailyData,
      cleaning_events: cleaningEvents,
      statistics,
    };

    // Save to file
    const fs = await import('fs');
    const path = await import('path');

    const outputDir = path.join(process.cwd(), 'public/data/soiling', plantId);
    const outputPath = path.join(outputDir, 'rain_history.json');

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(rainHistory, null, 2));

    console.log(`\nRain history saved to: ${outputPath}`);
    console.log('\nStatistics:');
    console.log(`  Total days: ${statistics.total_days}`);
    console.log(`  Rain days: ${statistics.rain_days}`);
    console.log(`  Cleaning events (>5mm): ${statistics.cleaning_events_count}`);
    console.log(`  Heavy rain days (>10mm): ${statistics.heavy_rain_count}`);
    console.log(`  Avg monthly precipitation: ${statistics.avg_monthly_precipitation}mm`);

    // Also create empty labels file
    const labelsPath = path.join(outputDir, 'labels.json');
    const emptyLabels = {
      plantId,
      labels: [],
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
    };
    fs.writeFileSync(labelsPath, JSON.stringify(emptyLabels, null, 2));
    console.log(`\nEmpty labels file created: ${labelsPath}`);

  } catch (error) {
    console.error('Error fetching rain data:', error);
    process.exit(1);
  }
}

main();
