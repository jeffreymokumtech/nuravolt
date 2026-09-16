import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantId, queryAnalysisResults } from '@/lib/db/timeseries';
import type { AnalysisRow } from '@/lib/db/timeseries';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/soiling/plants/[plantId]/history
 *
 * Returns historical soiling data with calculated rates:
 * - Soiling ratio time series
 * - Calculated soiling rate (%/day)
 * - Cleaning event detection
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
    const inverterId = searchParams.get('inverterId') || 'INV 01.001'; // Default to first inverter

    // DB-first: try TimescaleDB, fallback to static JSON
    try {
      const plantUuid = await resolvePlantId(plantId);
      if (plantUuid) {
        const rows = await queryAnalysisResults({
          plantId: plantUuid,
          domain: 'soiling',
          metrics: ['soiling_ratio'],
          deviceId: inverterId,
          limit: 10_000,
        }) as AnalysisRow[];

        if (rows.length > 0) {
          // Sort ascending by time
          const sorted = rows
            .map(r => ({
              time: new Date(r.time),
              sr: r.value,
            }))
            .sort((a, b) => a.time.getTime() - b.time.getTime());

          // Calculate soiling rate and detect cleaning events
          const processedData = sorted.map((d, idx) => {
            let soilingRate = 0;
            let cleaningEvent = false;

            if (idx > 0) {
              const prevSR = sorted[idx - 1].sr;
              const currentSR = d.sr;
              const rateDiff = prevSR - currentSR;

              if (currentSR > prevSR + 0.1) {
                cleaningEvent = true;
                soilingRate = 0;
              } else if (rateDiff > 0) {
                soilingRate = rateDiff;
              }
            }

            return {
              timestamp: d.time.toISOString().split('T')[0],
              soilingRatio: parseFloat(d.sr.toFixed(4)),
              soilingRate: parseFloat(soilingRate.toFixed(6)),
              cleaningEvent,
            };
          });

          return NextResponse.json({
            plantId,
            inverterId,
            dataPoints: processedData.length,
            period: {
              from: processedData[0].timestamp,
              to: processedData[processedData.length - 1].timestamp,
            },
            data: processedData,
            _source: 'database',
          });
        }
      }
    } catch (dbError) {
      console.warn('DB query failed for history, falling back to JSON:', dbError);
    }

    // Fallback: Load daily soiling ratio data from static JSON files
    const dataPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'time_series',
      'daily_soiling_ratio.json'
    );

    // Check if file exists
    try {
      await fs.access(dataPath);
    } catch {
      return NextResponse.json(
        { error: `Historical data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    // Read data file
    const fileData = await fs.readFile(dataPath, 'utf-8');
    const jsonData = JSON.parse(fileData);

    // Filter by inverter ID and sort by date
    const inverterData = jsonData.data
      .filter((d: any) => d.inverterId === inverterId)
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (inverterData.length === 0) {
      return NextResponse.json(
        { error: `No data found for inverter: ${inverterId}` },
        { status: 404 }
      );
    }

    // Calculate soiling rate and detect cleaning events
    const processedData = inverterData.map((d: any, idx: number) => {
      let soilingRate = 0;
      let cleaningEvent = false;

      if (idx > 0) {
        const prevSR = inverterData[idx - 1].sr;
        const currentSR = d.sr;
        const daysDiff = 1; // Daily data

        // Calculate rate (negative = soiling, positive = cleaning)
        const rateDiff = (prevSR - currentSR) / daysDiff;

        // Detect cleaning event (large positive jump in SR)
        if (currentSR > prevSR + 0.1) {
          cleaningEvent = true;
          soilingRate = 0; // Reset rate on cleaning
        } else if (rateDiff > 0) {
          // Normal soiling accumulation
          soilingRate = rateDiff;
        }
      }

      return {
        timestamp: d.date,
        soilingRatio: parseFloat(d.sr.toFixed(4)),
        soilingRate: parseFloat(soilingRate.toFixed(6)),
        cleaningEvent,
      };
    });

    // Build response
    const response = {
      plantId,
      inverterId,
      dataPoints: processedData.length,
      period: {
        from: processedData[0].timestamp,
        to: processedData[processedData.length - 1].timestamp,
      },
      data: processedData,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/history:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
