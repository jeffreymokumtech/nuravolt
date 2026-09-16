import { NextRequest, NextResponse } from 'next/server';
import { getPlantClassifications } from '@/lib/maintenance/computePlant';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/inverters/[inverterId]/classification?plant_id=<slugOrId>
 *
 * Classification for one inverter — served from the shared plant-wide
 * computation in src/lib/maintenance/computePlant.ts (cached per plant), so
 * the inverter tile and the Maintenance Horizon page can never disagree and
 * a page of tiles costs a single plant computation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { inverterId: string } },
) {
  const inverterId = decodeURIComponent(params.inverterId);
  const { searchParams } = new URL(request.url);
  const plantSlugOrId = searchParams.get('plant_id') || '';
  if (!plantSlugOrId) {
    return NextResponse.json({ error: 'plant_id is required' }, { status: 400 });
  }

  // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
  // plants stay publicly readable (showcase).
  const readAccess = await resolvePlantForRead(plantSlugOrId);
  if (!readAccess.ok) return readAccess.response;

  try {
    const payload = await getPlantClassifications(plantSlugOrId);
    if (!payload) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }
    if (payload.not_applicable) {
      return NextResponse.json(
        { error: 'Classification not applicable for this asset type' },
        { status: 404 },
      );
    }
    const result = payload.classifications.find((c) => c.inverterId === inverterId);
    if (!result) {
      return NextResponse.json({ error: 'No twin data for inverter' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error('classification error', err);
    return NextResponse.json(
      { error: 'Failed to classify inverter' },
      { status: 500 },
    );
  }
}
