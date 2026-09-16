import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';

export const runtime = 'nodejs';

/**
 * GET /api/soiling/plants/[plantId]/quality/deep-signals
 *
 * Deep sensor-quality research signals for a plant: long-horizon reference
 * coverage, outlier rate, max gap, seasonal coverage, cleaning-event
 * statistics and soiling drivers. Produced by the offline soiling-sensor
 * research analysis; served DB-artifact-first (kind 'quality_deep_signals'),
 * then the committed per-plant fixture. Plants without the analysis get an
 * honest `{ available: false }` 200 (not a 404) so dashboards stay
 * console-clean.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // DB artifact first (future per-plant runtime generation lands here).
    const plantUuid = readAccess.plant?.id;
    if (plantUuid) {
      const artifact = await readArtifact(plantUuid, 'quality_deep_signals');
      if (artifact) {
        return NextResponse.json({
          available: true,
          ...(artifact.payload as Record<string, unknown>),
          _source: 'artifact',
        });
      }
    }

    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const baseSubdir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    const dataPath = path.join(
      process.cwd(),
      'public',
      'data',
      baseSubdir,
      plantId,
      'quality',
      'deep_signals.json'
    );

    try {
      const raw = await fs.readFile(dataPath, 'utf-8');
      const data = JSON.parse(raw);
      return NextResponse.json({ available: true, ...data, _source: 'fixture' });
    } catch {
      return NextResponse.json({ available: false, plant_id: plantId });
    }
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/quality/deep-signals:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
