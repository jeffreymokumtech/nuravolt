import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { ScadaTimeSeriesResponse, WindScadaPoint, LabeledFaultEvent } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]/scada
 *
 * Returns SCADA time-series data for a specific turbine.
 * Query params:
 *   - turbineId: Required - turbine identifier (e.g., T001)
 *   - start: ISO date string for start of range
 *   - end: ISO date string for end of range
 *   - resolution: 10min | hourly | daily (default: 10min)
 *   - signals: comma-separated list of signals to include
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

    const turbineId = searchParams.get('turbineId');
    const start = searchParams.get('start');
    const end = searchParams.get('end');
    const resolution = searchParams.get('resolution') || '10min';
    const signalsParam = searchParams.get('signals');

    if (!turbineId) {
      return NextResponse.json(
        { error: 'turbineId query parameter is required' },
        { status: 400 }
      );
    }

    const basePath = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId
    );

    // Try to load SCADA data from monthly files or fallback to generating synthetic
    const scadaPath = path.join(basePath, 'scada');
    let points: WindScadaPoint[] = [];

    try {
      await fs.access(scadaPath);

      // Look for monthly files matching the turbine
      const files = await fs.readdir(scadaPath);
      const turbineFiles = files.filter(
        (f) => f.startsWith(turbineId) && f.endsWith('.json')
      );

      for (const file of turbineFiles) {
        const filePath = path.join(scadaPath, file);
        const data = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        points.push(...(parsed.points || parsed));
      }
    } catch {
      // No SCADA directory - generate synthetic data
      points = generateSyntheticScadaData(turbineId, start, end);
    }

    // Filter by date range
    if (start) {
      const startDate = new Date(start);
      points = points.filter((p) => new Date(p.timestamp) >= startDate);
    }
    if (end) {
      const endDate = new Date(end);
      points = points.filter((p) => new Date(p.timestamp) <= endDate);
    }

    // Apply resolution downsampling
    if (resolution === 'hourly') {
      points = downsampleToHourly(points);
    } else if (resolution === 'daily') {
      points = downsampleToDaily(points);
    }

    // Filter signals if specified
    const signals = signalsParam ? signalsParam.split(',') : getAllSignals();

    // Load labeled events that overlap with the date range
    let labeledEvents: LabeledFaultEvent[] = [];
    try {
      const eventsPath = path.join(basePath, 'labeled_events.json');
      const eventsData = await fs.readFile(eventsPath, 'utf-8');
      const allEvents: LabeledFaultEvent[] = JSON.parse(eventsData);

      // Filter to events for this turbine
      labeledEvents = allEvents.filter(
        (e) => e.turbineId === turbineId
      );

      // Filter to events that overlap with the requested date range
      if (start || end) {
        const startDate = start ? new Date(start) : new Date(0);
        const endDate = end ? new Date(end) : new Date();

        labeledEvents = labeledEvents.filter((e) => {
          const eventStart = new Date(e.eventStart);
          const eventEnd = new Date(e.eventEnd);
          return eventStart <= endDate && eventEnd >= startDate;
        });
      }
    } catch {
      // No labeled events file
    }

    // Detect anomaly highlights based on z-score analysis
    const anomalyHighlights = detectAnomalies(points, signals);

    const response: ScadaTimeSeriesResponse = {
      turbineId,
      plantId,
      period: {
        start: points.length > 0 ? points[0].timestamp : start || '',
        end:
          points.length > 0
            ? points[points.length - 1].timestamp
            : end || '',
      },
      resolution,
      points,
      signals,
      labeledEvents,
      anomalyHighlights,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/scada:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function getAllSignals(): string[] {
  return [
    'windSpeed',
    'activePower',
    'gearboxOilTemp',
    'gearboxBearingTemp',
    'generatorBearingTempDE',
    'generatorBearingTempNDE',
    'mainBearingTemp',
    'pitchAngle',
    'rotorRpm',
    'nacelleTemp',
  ];
}

function generateSyntheticScadaData(
  turbineId: string,
  startStr: string | null,
  endStr: string | null
): WindScadaPoint[] {
  const start = startStr ? new Date(startStr) : new Date('2019-06-01');
  const end = endStr ? new Date(endStr) : new Date('2019-06-07');
  const points: WindScadaPoint[] = [];

  // Generate 10-minute intervals
  const intervalMs = 10 * 60 * 1000;
  let current = start.getTime();

  while (current <= end.getTime()) {
    const timestamp = new Date(current);
    const hour = timestamp.getHours();
    const dayOfYear = Math.floor(
      (current - new Date(timestamp.getFullYear(), 0, 0).getTime()) /
        (1000 * 60 * 60 * 24)
    );

    // Simulate realistic wind patterns
    const baseWind = 7 + 3 * Math.sin((hour * Math.PI) / 12);
    const windSpeed = Math.max(
      3,
      baseWind + (Math.random() - 0.5) * 4
    );

    // Power based on wind speed (simplified power curve)
    const ratedPower = 2000;
    let activePower = 0;
    if (windSpeed >= 3 && windSpeed < 12) {
      activePower =
        ratedPower * Math.pow((windSpeed - 3) / 9, 3);
    } else if (windSpeed >= 12 && windSpeed < 25) {
      activePower = ratedPower;
    }
    activePower *= 0.95 + Math.random() * 0.1;

    // Temperature correlations
    const ambientTemp = 15 + 10 * Math.sin((dayOfYear * Math.PI) / 183);
    const gearboxOilTemp = 45 + activePower / 100 + (Math.random() - 0.5) * 5;
    const gearboxBearingTemp = gearboxOilTemp + 8 + (Math.random() - 0.5) * 3;

    points.push({
      timestamp: timestamp.toISOString(),
      turbineId,
      windSpeed: Math.round(windSpeed * 10) / 10,
      windDirection: Math.round(180 + (Math.random() - 0.5) * 60),
      activePower: Math.round(activePower * 10) / 10,
      reactivePower: Math.round(activePower * 0.1),
      rotorRpm: Math.round(
        12 + (windSpeed / 25) * 6 + (Math.random() - 0.5)
      ),
      generatorRpm: Math.round(
        1200 + (windSpeed / 25) * 400 + (Math.random() - 0.5) * 20
      ),
      nacelleTemp: Math.round(ambientTemp + 5 + (Math.random() - 0.5) * 2),
      gearboxOilTemp: Math.round(gearboxOilTemp * 10) / 10,
      gearboxBearingTemp: Math.round(gearboxBearingTemp * 10) / 10,
      generatorBearingTempDE:
        Math.round((50 + activePower / 80 + (Math.random() - 0.5) * 4) * 10) / 10,
      generatorBearingTempNDE:
        Math.round((48 + activePower / 90 + (Math.random() - 0.5) * 4) * 10) / 10,
      mainBearingTemp:
        Math.round((35 + activePower / 150 + (Math.random() - 0.5) * 3) * 10) / 10,
      pitchAngle: Math.round(
        windSpeed < 12 ? 0 : Math.min(25, (windSpeed - 12) * 3)
      ),
      yawAngle: 180 + (Math.random() - 0.5) * 10,
      ambientTemp: Math.round(ambientTemp * 10) / 10,
      availability: 1.0,
      gridFrequency: 50.0,
      turbineStatus: 'OPERATING',
    });

    current += intervalMs;
  }

  return points;
}

function downsampleToHourly(points: WindScadaPoint[]): WindScadaPoint[] {
  const hourlyMap = new Map<string, WindScadaPoint[]>();

  for (const point of points) {
    const date = new Date(point.timestamp);
    const hourKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
    if (!hourlyMap.has(hourKey)) {
      hourlyMap.set(hourKey, []);
    }
    hourlyMap.get(hourKey)!.push(point);
  }

  return Array.from(hourlyMap.values()).map((hourPoints) =>
    averagePoints(hourPoints)
  );
}

function downsampleToDaily(points: WindScadaPoint[]): WindScadaPoint[] {
  const dailyMap = new Map<string, WindScadaPoint[]>();

  for (const point of points) {
    const date = new Date(point.timestamp);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, []);
    }
    dailyMap.get(dayKey)!.push(point);
  }

  return Array.from(dailyMap.values()).map((dayPoints) =>
    averagePoints(dayPoints)
  );
}

function averagePoints(points: WindScadaPoint[]): WindScadaPoint {
  const first = points[0];
  const avg = (key: keyof WindScadaPoint) => {
    const values = points
      .map((p) => p[key] as number)
      .filter((v) => typeof v === 'number' && !isNaN(v));
    return values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;
  };

  return {
    ...first,
    windSpeed: Math.round(avg('windSpeed') * 10) / 10,
    activePower: Math.round(avg('activePower') * 10) / 10,
    gearboxOilTemp: Math.round(avg('gearboxOilTemp') * 10) / 10,
    gearboxBearingTemp: Math.round(avg('gearboxBearingTemp') * 10) / 10,
    generatorBearingTempDE: Math.round(avg('generatorBearingTempDE') * 10) / 10,
    generatorBearingTempNDE: Math.round(avg('generatorBearingTempNDE') * 10) / 10,
    mainBearingTemp: Math.round(avg('mainBearingTemp') * 10) / 10,
    rotorRpm: Math.round(avg('rotorRpm')),
    generatorRpm: Math.round(avg('generatorRpm')),
  };
}

function detectAnomalies(
  points: WindScadaPoint[],
  signals: string[]
): Array<{ start: string; end: string; signal: string; zScore: number }> {
  const anomalies: Array<{
    start: string;
    end: string;
    signal: string;
    zScore: number;
  }> = [];

  // For each temperature signal, detect periods where z-score > 2.5
  const tempSignals = signals.filter((s) => s.toLowerCase().includes('temp'));

  for (const signal of tempSignals) {
    const values = points
      .map((p) => (p as Record<string, unknown>)[signal] as number)
      .filter((v) => typeof v === 'number' && !isNaN(v));

    if (values.length < 10) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(
      values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
    );

    if (std < 0.1) continue;

    let inAnomaly = false;
    let anomalyStart = '';
    let maxZScore = 0;

    for (const point of points) {
      const value = (point as Record<string, unknown>)[signal] as number;
      if (typeof value !== 'number') continue;

      const zScore = Math.abs((value - mean) / std);

      if (zScore > 2.5 && !inAnomaly) {
        inAnomaly = true;
        anomalyStart = point.timestamp;
        maxZScore = zScore;
      } else if (zScore > 2.5 && inAnomaly) {
        maxZScore = Math.max(maxZScore, zScore);
      } else if (zScore <= 2.5 && inAnomaly) {
        anomalies.push({
          start: anomalyStart,
          end: point.timestamp,
          signal,
          zScore: Math.round(maxZScore * 100) / 100,
        });
        inAnomaly = false;
      }
    }
  }

  return anomalies;
}
