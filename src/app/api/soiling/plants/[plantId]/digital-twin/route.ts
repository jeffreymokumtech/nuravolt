import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import type { DigitalTwinResponse } from '@/types/soiling';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { resolvePlantId, queryAnalysisResults } from '@/lib/db/timeseries';

/** Build the {forecasts:[...]} shape DB-first from soiling_ratio analysis rows
 *  (today forward). Returns null when the plant has no DB forecast, so the
 *  caller falls back to the demo fixture. */
async function forecastFromDb(plantId: string): Promise<{ forecast: any; capacity_MW: number } | null> {
  const plantUuid = await resolvePlantId(plantId);
  if (!plantUuid) return null;
  const rows = await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'soiling',
    metrics: ['soiling_ratio', 'soiling_ratio_lower', 'soiling_ratio_upper'],
    from: new Date(),
    limit: 20000,
  });
  if (!rows.length) return null;
  const byDate: Record<string, any> = {};
  for (const r of rows as any[]) {
    const d = new Date((r as any).bucket ?? r.time).toISOString().slice(0, 10);
    (byDate[d] ??= { date: d });
    const v = (r as any).avg_value ?? r.value;
    if (r.metric === 'soiling_ratio') byDate[d].soilingRatio = v;
    else if (r.metric === 'soiling_ratio_lower') byDate[d].lowerBound = v;
    else if (r.metric === 'soiling_ratio_upper') byDate[d].upperBound = v;
  }
  const forecasts = Object.values(byDate)
    .filter((f: any) => typeof f.soilingRatio === 'number')
    .sort((a: any, b: any) => a.date.localeCompare(b.date));
  if (!forecasts.length) return null;
  return {
    forecast: {
      forecasts,
      forecastPeriod: { start: (forecasts[0] as any).date, end: (forecasts[forecasts.length - 1] as any).date },
      modelInfo: { version: 'coldstart-v1' },
    },
    capacity_MW: 9.0,
  };
}

/**
 * GET /api/soiling/plants/[plantId]/digital-twin
 *
 * Get 365-day digital twin forecast with energy production estimates.
 * Uses existing forecast data and enriches with energy calculations.
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

    // Get data source from query parameter (default to 'sensor')
    const { searchParams } = new URL(request.url);
    const dataSource = searchParams.get('source') || 'sensor';

    // DB-first: build the forecast from the plant's own soiling rows. Real
    // (dashboard) plants have no fixture, so this is the live path; demo plants
    // fall through to the richer fixture below.
    const dbForecast = await forecastFromDb(plantId);
    let forecast: any = dbForecast?.forecast ?? null;
    let capacity_MW = dbForecast?.capacity_MW ?? 9.0;

    if (!forecast) {
    // Load forecast data - use different file based on data source.
    // Showcase plants live under public/data/showcase/soiling/{plantId}/.
    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const baseSubdir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    const dataDir = path.join(process.cwd(), 'public', 'data', baseSubdir, plantId);
    const forecastFileName = dataSource === 'ml_model'
      ? 'ml_forecast_365d.json'
      : 'forecast_365d.json';
    let forecastPath = path.join(dataDir, forecastFileName);

    // Check if forecast file exists. For showcase plants (which don't ship
    // sensor-based forecast files), fall back to the ML forecast.
    try {
      await fs.access(forecastPath);
    } catch {
      if (dataSource !== 'ml_model') {
        const fallback = path.join(dataDir, 'ml_forecast_365d.json');
        try {
          await fs.access(fallback);
          forecastPath = fallback;
        } catch {
          return NextResponse.json(
            {
              error: `Forecast data not found for plant: ${plantId}`,
              details: `Missing file: ${forecastFileName} (source: ${dataSource})`
            },
            { status: 404 }
          );
        }
      } else {
        return NextResponse.json(
          {
            error: `Forecast data not found for plant: ${plantId}`,
            details: `Missing file: ${forecastFileName} (source: ${dataSource})`
          },
          { status: 404 }
        );
      }
    }

    // Read forecast data
    const forecastData = await fs.readFile(forecastPath, 'utf-8');
    forecast = JSON.parse(forecastData);

    // Load fleet summary for capacity
    const summaryPath = path.join(dataDir, 'fleet_summary.json');
    try {
      const summaryData = await fs.readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(summaryData);
      capacity_MW = summary.plantInfo?.capacity_MW || 9.0;
    } catch {
      console.warn(`Fleet summary not found for ${plantId}, using default capacity`);
    }
    } // end fixture fallback (DB forecast absent)

    // Monthly sun hours pattern (can be derived from historical data or use defaults)
    const monthly_sun_hours: Record<number, number> = {
      1: 5.5, 2: 6.5, 3: 7.5, 4: 8.5, 5: 9.5, 6: 10.5,
      7: 10.5, 8: 9.5, 9: 8.5, 10: 7.5, 11: 6.5, 12: 5.5
    };

    // Enrich forecast data with energy calculations
    const daily_forecasts = forecast.forecasts?.map((day: any) => {
      const date = new Date(day.date);
      const month = date.getMonth() + 1;
      const sun_hours = monthly_sun_hours[month] || 6.5;

      // Calculate energy if clean (daily)
      const energy_if_clean_MWh = capacity_MW * sun_hours;

      // Calculate energy with soiling
      const sr = day.soilingRatio || day.sr_predicted || 1.0;
      const energy_with_soiling_MWh = energy_if_clean_MWh * sr;

      // Calculate loss percentage
      const soiling_loss_pct = ((1 - sr) * 100);

      return {
        date: day.date,
        sr_predicted: sr,
        soiling_loss_pct: soiling_loss_pct,
        energy_if_clean_MWh: parseFloat(energy_if_clean_MWh.toFixed(3)),
        energy_with_soiling_MWh: parseFloat(energy_with_soiling_MWh.toFixed(3)),
        sun_hours: parseFloat(sun_hours.toFixed(2)),
        rainfall_mm: day.rainfall_mm || 0
      };
    }) || [];

    // Build response
    const response: DigitalTwinResponse = {
      plant_id: plantId,
      capacity_MW: capacity_MW,
      forecast_period: {
        start: forecast.forecastPeriod?.start || daily_forecasts[0]?.date,
        end: forecast.forecastPeriod?.end || daily_forecasts[daily_forecasts.length - 1]?.date,
        days: daily_forecasts.length
      },
      daily_forecasts: daily_forecasts,
      metadata: {
        generated_at: new Date().toISOString(),
        model_version: forecast.modelInfo?.version || 'v1.0',
        data_source: dataSource
      }
    };

    // Return digital twin forecast
    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
      }
    });

  } catch (error) {
    console.error('Digital twin API error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

/**
 * OPTIONS handler for CORS
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
