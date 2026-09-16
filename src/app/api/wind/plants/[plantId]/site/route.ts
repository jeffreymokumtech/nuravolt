import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]/site
 *
 * Site climate + wake analysis for a wind plant:
 *   - rose: 16-sector wind rose (frequency, mean speed, speed classes) from
 *     one year of ERA5 hourly 100 m wind at the plant coordinates
 *   - wake: Jensen wake-model results (nuravolt.wind.wake_model) — per-sector
 *     and frequency-weighted annual wake loss per turbine + farm efficiency
 *
 * Fixtures are produced by scripts/generate_wind_site_analysis.py. Returns
 * 200 with `_source: 'empty'` when a plant has no site fixtures so demo-less
 * plants degrade quietly.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const base = path.join(process.cwd(), 'public', 'data', 'wind', plantId);
    const load = async (file: string) => {
      try {
        return JSON.parse(await fs.readFile(path.join(base, file), 'utf-8'));
      } catch {
        return null;
      }
    };

    const [rose, wake] = await Promise.all([
      load('wind_rose.json'),
      load('wake_analysis.json'),
    ]);

    if (!rose && !wake) {
      return NextResponse.json({ rose: null, wake: null, _source: 'empty' });
    }

    return NextResponse.json({ rose, wake, _source: 'static' });
  } catch (error) {
    console.error('[wind/site] error:', error);
    return NextResponse.json({ error: 'Failed to load site analysis' }, { status: 500 });
  }
}
