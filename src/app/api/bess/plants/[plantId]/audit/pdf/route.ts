import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { readArtifact } from '@/lib/analysis/artifacts';
import { presignGetObject } from '@/lib/services/s3-objects';

export const dynamic = 'force-dynamic';

const KIND_BY_FILE: Record<string, string> = {
  optimizer: 'bess_optimizer_audit',
  dossier: 'bess_warranty_dossier',
};

/**
 * GET /api/bess/plants/[plantId]/audit/pdf?file=optimizer|dossier
 *
 * Redirects to a short-lived presigned URL for the audit PDF rendered by the
 * weekly artifact job. 404 when the job hasn't produced one — there is no
 * on-request generation (no Python/reportlab at Vercel request time).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const file = new URL(request.url).searchParams.get('file') ?? 'dossier';
    const kind = KIND_BY_FILE[file];
    if (!kind) {
      return NextResponse.json(
        { error: 'invalid_file', allowed: Object.keys(KIND_BY_FILE) },
        { status: 400 }
      );
    }

    const readAccess = await resolvePlantForRead(params.plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }
    if (!readAccess.plant) {
      return NextResponse.json({ error: 'no_audit_pdf' }, { status: 404 });
    }

    const artifact = await readArtifact<{ pdf_s3_key?: string }>(readAccess.plant.id, kind);
    const key = artifact?.payload?.pdf_s3_key;
    if (!key) {
      return NextResponse.json({ error: 'no_audit_pdf' }, { status: 404 });
    }

    const url = await presignGetObject(key, {
      expiresInSeconds: 300,
      downloadFilename: key.split('/').pop(),
    });
    return NextResponse.redirect(url, 302);
  } catch (error) {
    console.error('Error in GET /api/bess/plants/[plantId]/audit/pdf:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
