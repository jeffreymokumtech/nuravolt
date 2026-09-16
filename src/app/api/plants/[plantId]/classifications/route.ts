import { NextRequest, NextResponse } from 'next/server';
import { getPlantClassifications } from '@/lib/maintenance/computePlant';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/plants/[plantId]/classifications
 *
 * Plant-wide maintenance classifications for the Maintenance Horizon page.
 * Computation + caching live in src/lib/maintenance/computePlant.ts, shared
 * with the per-inverter classification route so both surfaces always agree.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase). Kept inside the try so the
    // DB-down fallback below still applies when Postgres is unreachable.
    const readAccess = await resolvePlantForRead(params.plantId);
    if (!readAccess.ok) return readAccess.response;

    const payload = await getPlantClassifications(params.plantId);
    if (!payload) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (err) {
    // The classification pipeline needs Prisma. When Postgres is down
    // (typical in dev or static-only deploys) return an empty-but-shaped
    // payload so consumers like the Faults page Predictive panel can render
    // a clean empty state instead of a 500.
    const message = err instanceof Error ? err.message : String(err);
    const isDbDown =
      /Can't reach database|ECONNREFUSED|P1001|P1002|database server at|PrismaClient/i.test(
        message,
      );
    if (isDbDown) {
      return NextResponse.json({
        plantId: params.plantId,
        summary: null,
        classifications: [],
        coverage: 'persistence_not_yet_applied',
      });
    }
    console.error('plant classifications error', err);
    return NextResponse.json(
      { error: 'Failed to classify plant inverters' },
      { status: 500 },
    );
  }
}
