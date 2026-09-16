import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { fetchRainForecast } from '@/lib/soiling/rainForecast';

/**
 * GET /api/soiling/plants/[plantId]/rain-forecast
 *
 * 16-day daily precipitation forecast at the plant coordinates (Open-Meteo),
 * proxied server-side because the browser CSP does not allow direct calls to
 * external APIs. Returns { data: null } when coords are missing or the
 * upstream is unreachable; callers degrade to rain-blind behaviour.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;
  const plant = readAccess.plant;
  if (!plant || plant.latitude == null || plant.longitude == null) {
    return NextResponse.json({ data: null });
  }
  const forecast = await fetchRainForecast(Number(plant.latitude), Number(plant.longitude));
  return NextResponse.json(
    { data: forecast },
    { headers: { 'Cache-Control': 'private, max-age=1800' } },
  );
}
