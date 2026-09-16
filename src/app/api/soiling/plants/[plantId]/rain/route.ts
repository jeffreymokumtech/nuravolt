/**
 * API Route: /api/soiling/plants/[plantId]/rain
 *
 * Serves historical rain data for soiling analysis.
 * Data is pre-fetched from Open-Meteo and cached as JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';

interface RouteParams {
  params: Promise<{ plantId: string }>;
}

/**
 * GET /api/soiling/plants/[plantId]/rain
 *
 * Returns rain history data for a plant
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { plantId } = await params;

    // Validate plantId
    if (!plantId || typeof plantId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid plant ID' },
        { status: 400 }
      );
    }

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // Construct path to rain history file
    const rainHistoryPath = path.join(
      process.cwd(),
      'public/data/soiling',
      plantId,
      'rain_history.json'
    );

    // Check if file exists
    if (!fs.existsSync(rainHistoryPath)) {
      return NextResponse.json(
        { error: `Rain history not found for plant: ${plantId}` },
        { status: 404 }
      );
    }

    // Read and parse the file
    const fileContent = fs.readFileSync(rainHistoryPath, 'utf-8');
    const rainHistory = JSON.parse(fileContent);

    // Optional: Filter by date range if query params provided
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('start');
    const endDate = searchParams.get('end');

    if (startDate || endDate) {
      // Filter daily_data and cleaning_events by date range
      const start = startDate || '1900-01-01';
      const end = endDate || '2100-12-31';

      rainHistory.daily_data = rainHistory.daily_data.filter(
        (d: { date: string }) => d.date >= start && d.date <= end
      );

      rainHistory.cleaning_events = rainHistory.cleaning_events.filter(
        (e: { date: string }) => e.date >= start && e.date <= end
      );

      // Recalculate statistics for filtered data
      const totalDays = rainHistory.daily_data.length;
      const rainDays = rainHistory.daily_data.filter(
        (d: { precipitation_mm: number }) => d.precipitation_mm > 0
      ).length;
      const cleaningEvents = rainHistory.daily_data.filter(
        (d: { is_cleaning_event: boolean }) => d.is_cleaning_event
      ).length;
      const heavyRainDays = rainHistory.daily_data.filter(
        (d: { is_heavy_rain: boolean }) => d.is_heavy_rain
      ).length;
      const totalPrecip = rainHistory.daily_data.reduce(
        (sum: number, d: { precipitation_mm: number }) => sum + d.precipitation_mm,
        0
      );
      const months = totalDays / 30.44;

      rainHistory.statistics = {
        total_days: totalDays,
        rain_days: rainDays,
        cleaning_events_count: cleaningEvents,
        heavy_rain_count: heavyRainDays,
        avg_monthly_precipitation: parseFloat((totalPrecip / months).toFixed(1)),
      };

      // Update period in metadata
      if (rainHistory.daily_data.length > 0) {
        rainHistory.metadata.period = {
          start: rainHistory.daily_data[0].date,
          end: rainHistory.daily_data[rainHistory.daily_data.length - 1].date,
        };
      }
    }

    return NextResponse.json(rainHistory);
  } catch (error) {
    console.error('Error fetching rain history:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
