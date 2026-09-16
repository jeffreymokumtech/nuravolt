import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';

/**
 * GET /api/soiling/plants/[plantId]/streams
 *
 * Consolidated multi-source soiling history for the Data Explorer tab:
 * precipitation, dust/PM, AOD, DustIQ reference SR, ML + transfer predictions,
 * PR. Served DB-first from the synthesized `soiling_streams` artifact (labeled
 * `source`); absent → { available: false } so the UI shows a "connect a
 * source" state instead of a fixture 404.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;

  const plantUuid = readAccess.plant?.id;
  const art = plantUuid ? await readArtifact<any>(plantUuid, 'soiling_streams') : null;
  if (!art) {
    return NextResponse.json({ available: false, _source: 'none' });
  }
  return NextResponse.json({
    available: true,
    source: art.source,
    generatedAt: art.generatedAt,
    _source: 'database',
    ...art.payload,
  });
}
