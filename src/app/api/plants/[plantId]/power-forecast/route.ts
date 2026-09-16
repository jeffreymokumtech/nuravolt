import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

export const dynamic = 'force-dynamic';

/**
 * GET /api/plants/[plantId]/power-forecast
 *
 * Forward physics power forecast for the plant overview panel. Reads the
 * analysis_results rows written by nuravolt/pipeline/power_forecast.py
 * (domain='power_forecast', model_version='forecast-physics-v1'):
 *   metric='expected_power_kw'    hourly plant kW, now -> now+7d
 *   metric='expected_energy_kwh'  daily kWh at local-day noon UTC
 *
 *   metric='ghi_wm2' / 'poa_wm2'  hourly irradiance forecast (W/m²)
 *
 * Always 200 with empty arrays when no forecast exists yet — the overview
 * panel hides itself on empty (demo-safe).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(params.plantId);
    if (!readAccess.ok) return readAccess.response;
    const plant = readAccess.plant;
    if (!plant) {
      return NextResponse.json({
        data: { hourly: [], daily: [], irradiance: [], _source: 'empty' },
      });
    }

    const rows = await prisma.$queryRawUnsafe<
      { time: Date; metric: string; value: number }[]
    >(
      `SELECT time, metric, value FROM analysis_results
       WHERE plant_id::text = $1 AND domain = 'power_forecast'
         AND time >= now() - interval '1 hour'
       ORDER BY time`,
      plant.id,
    );

    const hourly: { time: string; kw: number }[] = [];
    const daily: { date: string; kwh: number }[] = [];
    const irradianceByTime = new Map<string, { time: string; ghi?: number; poa?: number }>();
    for (const row of rows) {
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;
      const iso = new Date(row.time).toISOString();
      if (row.metric === 'expected_power_kw') {
        hourly.push({ time: iso, kw: value });
      } else if (row.metric === 'expected_energy_kwh') {
        daily.push({ date: iso.slice(0, 10), kwh: value });
      } else if (row.metric === 'ghi_wm2' || row.metric === 'poa_wm2') {
        const entry = irradianceByTime.get(iso) ?? { time: iso };
        if (row.metric === 'ghi_wm2') entry.ghi = value;
        else entry.poa = value;
        irradianceByTime.set(iso, entry);
      }
    }
    const irradiance = Array.from(irradianceByTime.values());

    return NextResponse.json({
      data: {
        hourly,
        daily,
        irradiance,
        _source: hourly.length || daily.length ? 'database' : 'empty',
      },
    });
  } catch (error) {
    console.error('Failed to fetch power forecast:', error);
    // Contract: always 200; the panel treats empty as "hide".
    return NextResponse.json({
      data: { hourly: [], daily: [], irradiance: [], _source: 'empty' },
    });
  }
}
