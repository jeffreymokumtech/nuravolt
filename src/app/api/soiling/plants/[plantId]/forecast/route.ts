import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantId, queryAnalysisResults } from '@/lib/db/timeseries';
import type { AnalysisRow } from '@/lib/db/timeseries';
import { getExcludedStreamIds } from '@/libs/quality/exclusions';
import { resolvePlantForRead } from '@/lib/api/tenant';

// Plant coordinates for weather forecast
const PLANT_COORDINATES: Record<string, { lat: number; lon: number }> = {
  alpha1: { lat: 37.5, lon: -6.0 }, // legacy code for alpha
  // Showcase plants (anonymised for public demo at /showcase)
  helios: { lat: 37.9, lon: -1.1 },
  zephyr: { lat: 56.0, lon: 9.5 },
};

// Weather adjustment constants
const RAIN_RECOVERY_HEAVY = 0.05; // 5% SR recovery for heavy rain (>5mm)
const RAIN_RECOVERY_MODERATE = 0.02; // 2% SR recovery for moderate rain

/**
 * Derive per-day confidence from the forecast's own uncertainty band when the
 * source carries no explicit confidence. Wider CI -> lower confidence. Never
 * returns a flat constant: the band width varies day to day.
 */
function confidenceFromBounds(lower: number, upper: number): number {
  const width = Math.max(0, upper - lower);
  return Math.round(Math.max(0.3, Math.min(0.95, 1 - width / 0.2)) * 1000) / 1000;
}

interface WeatherForecast {
  date: string;
  precipitation_mm: number;
  precipitation_probability: number;
  is_rain_event: boolean;
  expected_recovery: number;
}

/**
 * Fetch 7-day weather forecast from Open-Meteo
 */
async function fetchWeatherForecast(lat: number, lon: number): Promise<WeatherForecast[]> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toString());
  url.searchParams.set('longitude', lon.toString());
  url.searchParams.set('daily', 'precipitation_sum,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.status}`);
  }

  const data = await response.json();

  return data.daily.time.map((date: string, i: number) => {
    const precip = data.daily.precipitation_sum[i] ?? 0;
    const prob = data.daily.precipitation_probability_max[i] ?? 0;
    const isRainEvent = prob >= 50 && precip >= 5.0;
    return {
      date,
      precipitation_mm: precip,
      precipitation_probability: prob,
      is_rain_event: isRainEvent,
      expected_recovery: isRainEvent ? (precip >= 10 ? RAIN_RECOVERY_HEAVY : RAIN_RECOVERY_MODERATE) : 0,
    };
  });
}

/**
 * GET /api/soiling/plants/[plantId]/forecast?days=365&weather=true
 *
 * Returns 365-day soiling ratio forecast with:
 * - Daily soiling ratio predictions
 * - Confidence intervals (upper/lower bounds)
 * - Cleaning recommendations
 * - Model metadata
 * - Weather-adjusted predictions (if weather=true)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get('days');
    const days = daysParam ? parseInt(daysParam, 10) : 365;
    const includeWeather = searchParams.get('weather') === 'true';

    // Stream-level exclusions for SR. This rollup is computed from precomputed
    // per-date aggregates (DB pivot by date or fixture JSON), not per-stream
    // raw data, so we cannot drop streams from the aggregate here. We surface
    // the count of active exclusions so the UI can flag stale rollups and so
    // ops knows their toggle was registered. Fail-safe to 0 on any error.
    let excludedStreamsApplied = 0;
    let excludedStreamsNote: string | undefined;
    try {
      const excludedSet = await getExcludedStreamIds(plantId, undefined, 'SR');
      excludedStreamsApplied = excludedSet.size;
      if (excludedStreamsApplied > 0) {
        excludedStreamsNote =
          'stream-level exclusions registered but not applied: this route aggregates per-date precomputed SR, not per-stream raw data';
      }
    } catch {
      // Helper returns [] on missing table; any other failure is non-fatal here.
    }

    // DB-first: try TimescaleDB, fallback to static JSON
    try {
      const plantUuid = await resolvePlantId(plantId);
      if (plantUuid) {
        // A forecast means the NEXT `days` days: filter from today, otherwise
        // the DESC-ordered query returns the tail of a long horizon (the
        // farthest-future rows) instead of the upcoming window.
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const rows = await queryAnalysisResults({
          plantId: plantUuid,
          domain: 'soiling',
          metrics: ['soiling_ratio', 'soiling_ratio_lower', 'soiling_ratio_upper', 'soiling_loss_pct'],
          from: todayStart,
          to: new Date(todayStart.getTime() + days * 86_400_000),
          limit: days * 4, // 4 metrics per day
        }) as AnalysisRow[];

        if (rows.length > 0) {
          // Pivot from long format (one row per metric per day) to wide format.
          // Keep the row-level confidence + model_version — coldstart rows
          // carry confidence 0.5 and the UI must not dress them up as 0.95.
          const byDate = new Map<string, Record<string, number>>();
          const confByDate = new Map<string, number>();
          let modelVersion: string | null = null;
          for (const row of rows) {
            const dateKey = new Date(row.time).toISOString().split('T')[0];
            if (!byDate.has(dateKey)) byDate.set(dateKey, {});
            byDate.get(dateKey)![row.metric] = row.value;
            if (row.metric === 'soiling_ratio') {
              if (row.confidence != null) confByDate.set(dateKey, Number(row.confidence));
              if (row.model_version) modelVersion = row.model_version;
            }
          }

          // Sort dates ascending and limit
          const sortedDates = Array.from(byDate.keys()).sort();
          const limitedDates = sortedDates.slice(0, days);

          let dbForecasts = limitedDates.map((date) => {
            const m = byDate.get(date)!;
            const sr = m['soiling_ratio'] ?? 0.95;
            const lowerBound = m['soiling_ratio_lower'] ?? sr - 0.02;
            const upperBound = m['soiling_ratio_upper'] ?? sr + 0.02;
            return {
              date,
              soilingRatio: sr,
              lowerBound,
              upperBound,
              soilingLossPct: m['soiling_loss_pct'] ?? (1 - sr) * 100,
              cleaningRecommended: sr < 0.92,
              // Real row confidence (coldstart rows carry 0.5); else derive
              // from the row's own CI width — never a flat constant.
              confidence: confByDate.get(date) ?? confidenceFromBounds(lowerBound, upperBound),
              weatherAdjusted: false,
              rainEvent: false,
              expectedPrecipitation: undefined as number | undefined,
            };
          });

          // Fetch weather forecast if requested
          let weatherForecast: WeatherForecast[] = [];
          if (includeWeather && PLANT_COORDINATES[plantId]) {
            try {
              const { lat, lon } = PLANT_COORDINATES[plantId];
              weatherForecast = await fetchWeatherForecast(lat, lon);
              dbForecasts = dbForecasts.map((f) => {
                const weather = weatherForecast.find(w => w.date === f.date);
                if (weather?.is_rain_event) {
                  const adjustedSR = Math.min(1.0, f.soilingRatio + weather.expected_recovery);
                  return {
                    ...f,
                    soilingRatio: adjustedSR,
                    weatherAdjusted: true,
                    rainEvent: true,
                    expectedPrecipitation: weather.precipitation_mm,
                  };
                }
                return f;
              });
            } catch {
              // Continue without weather adjustment
            }
          }

          const meanSR = dbForecasts.reduce((s, f) => s + f.soilingRatio, 0) / dbForecasts.length;
          const meanLoss = dbForecasts.reduce((s, f) => s + f.soilingLossPct, 0) / dbForecasts.length;

          return NextResponse.json({
            forecastPeriod: {
              start: dbForecasts[0]?.date,
              end: dbForecasts[dbForecasts.length - 1]?.date,
              days: dbForecasts.length,
            },
            forecasts: dbForecasts,
            weatherForecast: includeWeather ? weatherForecast : undefined,
            modelInfo: {
              type: modelVersion ?? 'timescaledb',
              version: '2.0.0',
              lastTrainedAt: new Date().toISOString(),
              // Coldstart/low-confidence forecasts are provisional — surface
              // that instead of implying a converged model.
              provisional:
                dbForecasts.reduce((s, f) => s + f.confidence, 0) / dbForecasts.length < 0.7,
            },
            statistics: {
              meanSoilingRatio: meanSR,
              meanLossPct: meanLoss,
              cleaningsRecommended: dbForecasts.filter(f => f.cleaningRecommended).length,
              rainEventsNext7Days: weatherForecast.filter(w => w.is_rain_event).length,
            },
            excluded_streams_applied: 0,
            excluded_streams_registered: excludedStreamsApplied,
            note: excludedStreamsNote,
            _source: 'database',
          });
        }
      }
    } catch (dbError) {
      console.warn('DB query failed for forecast, falling back to JSON:', dbError);
    }

    // Fallback: Load forecast data from static JSON files.
    // Showcase plants live under public/data/showcase/soiling/{plantId}/.
    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const baseSubdir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    const forecastPath = path.join(
      process.cwd(),
      'public',
      'data',
      baseSubdir,
      plantId,
      'forecast_365d.json'
    );

    // Check if file exists, try alternative path
    let forecastData: string;
    try {
      await fs.access(forecastPath);
      forecastData = await fs.readFile(forecastPath, 'utf-8');
    } catch {
      // Try seasonal forecast path (then ml forecast as final fallback)
      const seasonalPath = path.join(
        process.cwd(),
        'public',
        'data',
        baseSubdir,
        plantId,
        'seasonal_forecast_365d.json'
      );
      try {
        await fs.access(seasonalPath);
        forecastData = await fs.readFile(seasonalPath, 'utf-8');
      } catch {
        // Final fallback: ml_forecast_365d.json (what showcase ships)
        const mlPath = path.join(
          process.cwd(),
          'public',
          'data',
          baseSubdir,
          plantId,
          'ml_forecast_365d.json'
        );
        try {
          await fs.access(mlPath);
          forecastData = await fs.readFile(mlPath, 'utf-8');
        } catch {
          return NextResponse.json(
            { error: `Forecast data not found for plantId: ${plantId}` },
            { status: 404 }
          );
        }
      }
    }

    const forecast = JSON.parse(forecastData);

    // Get forecast array (handle both formats)
    const forecasts = forecast.forecasts || forecast.forecast || [];

    // Limit to requested number of days
    let limitedForecasts = forecasts.slice(0, days);

    // Fetch weather forecast if requested
    let weatherForecast: WeatherForecast[] = [];
    if (includeWeather && PLANT_COORDINATES[plantId]) {
      try {
        const { lat, lon } = PLANT_COORDINATES[plantId];
        weatherForecast = await fetchWeatherForecast(lat, lon);

        // Apply weather adjustments to first 7 days
        limitedForecasts = limitedForecasts.map((f: any) => {
          const weather = weatherForecast.find(w => w.date === f.date);
          if (weather?.is_rain_event) {
            // Adjust SR upward for rain recovery
            const adjustedSR = Math.min(1.0, (f.sr_predicted || f.sr_forecast || 0.9) + weather.expected_recovery);
            return {
              ...f,
              sr_predicted: adjustedSR,
              sr_forecast: adjustedSR,
              weather_adjusted: true,
              rain_event: true,
              expected_precipitation_mm: weather.precipitation_mm,
            };
          }
          return f;
        });
      } catch (error) {
        console.warn('Failed to fetch weather forecast:', error);
        // Continue without weather adjustment
      }
    }

    // Build response (handle both old and new format)
    const response = {
      forecastPeriod: {
        start: forecast.metadata?.forecast_period?.start || forecast.metadata?.forecast_start || limitedForecasts[0]?.date,
        end: limitedForecasts[limitedForecasts.length - 1]?.date || forecast.metadata?.forecast_period?.end,
        days: limitedForecasts.length,
      },
      forecasts: limitedForecasts.map((f: any) => {
        const sr = f.sr_predicted || f.sr_forecast;
        const lowerBound = f.sr_lower_bound || f.sr_lower_95;
        const upperBound = f.sr_upper_bound || f.sr_upper_95;
        return {
          date: f.date,
          soilingRatio: sr,
          lowerBound,
          upperBound,
          soilingLossPct: f.soiling_loss_pct || (1 - sr) * 100,
          cleaningRecommended: f.is_cleaning_needed || false,
          // Derived from the fixture's own CI band, not a flat constant.
          confidence:
            lowerBound != null && upperBound != null
              ? confidenceFromBounds(lowerBound, upperBound)
              : 0.5,
          weatherAdjusted: f.weather_adjusted || false,
          rainEvent: f.rain_event || false,
          expectedPrecipitation: f.expected_precipitation_mm,
        };
      }),
      weatherForecast: includeWeather ? weatherForecast : undefined,
      modelInfo: {
        type: forecast.metadata?.model_type || forecast.metadata?.method || 'seasonal',
        version: forecast.metadata?.version || '1.0.0',
        lastTrainedAt: forecast.metadata?.generated_at || new Date().toISOString(),
      },
      statistics: {
        meanSoilingRatio: limitedForecasts.reduce((sum: number, f: any) =>
          sum + (f.sr_predicted || f.sr_forecast || 0), 0) / limitedForecasts.length,
        meanLossPct: limitedForecasts.reduce((sum: number, f: any) =>
          sum + (f.soiling_loss_pct || (1 - (f.sr_predicted || f.sr_forecast || 0.9)) * 100), 0) / limitedForecasts.length,
        cleaningsRecommended: limitedForecasts.filter((f: any) => f.is_cleaning_needed).length,
        rainEventsNext7Days: weatherForecast.filter(w => w.is_rain_event).length,
      },
      backtest: forecast.backtest_validation ? {
        avgRmse: forecast.backtest_validation.avg_rmse,
        avgMae: forecast.backtest_validation.avg_mae,
        avgRSquared: forecast.backtest_validation.avg_r_squared,
        yearsTested: forecast.backtest_validation.years_tested,
      } : undefined,
      excluded_streams_applied: 0,
      excluded_streams_registered: excludedStreamsApplied,
      note: excludedStreamsNote,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/forecast:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
