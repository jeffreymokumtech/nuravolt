import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { presignGetObject } from '@/lib/services/s3-objects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/plants/[plantId]/contracts/[contractId]/document
 *
 * Redirects to a short-lived (5 min) presigned URL for the original
 * contract PDF. 404 when no source document was stored.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string; contractId: string } }
) {
  try {
    const readAccess = await resolvePlantForRead(params.plantId);
    if (!readAccess.ok) return readAccess.response;
    if (!readAccess.plant) {
      return NextResponse.json({ error: 'no_source_document' }, { status: 404 });
    }

    const contract = await prisma.contract.findFirst({
      where: { id: params.contractId, plant_id: readAccess.plant.id },
    });
    if (!contract || !contract.source_s3_key) {
      return NextResponse.json({ error: 'no_source_document' }, { status: 404 });
    }

    const url = await presignGetObject(contract.source_s3_key, {
      expiresInSeconds: 300,
      downloadFilename: `${contract.title.replace(/[^\w.-]+/g, '_')}.pdf`,
    });
    return NextResponse.redirect(url, 302);
  } catch (error) {
    console.error('Error in GET /contracts/[contractId]/document:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
