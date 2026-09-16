import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { readArtifact } from '@/lib/analysis/artifacts';

export const dynamic = 'force-dynamic';

// Not exported: a route module may only export Next's own route fields, so the
// contract test in tests/api/bess-audit-route.test.ts drives GET instead of
// reading this map.
const KIND_BY_FILE: Record<string, string> = {
  optimizer: 'bess_optimizer_audit',
  dossier: 'bess_warranty_dossier',
  // Worst-of state-of-safety composite, published by the BESS pipeline
  // (nuravolt/pipeline/bess_intelligence.py::state_of_safety_payload) on the
  // same artifact kind src/lib/alerts/evaluate.ts evaluates. Before this
  // mapping existed the panel's fetch 400'd and the console could only ever
  // say "not published", however recently the pipeline had run.
  safety: 'bess_state_of_safety',
};

/**
 * GET /api/bess/plants/[plantId]/audit?file=optimizer|dossier|safety
 *
 * Live audit bundle from AnalysisArtifact, written weekly by
 * scripts/generate_bess_audit_artifacts.py (payload shape = the Python
 * dossier/audit dicts the Audit UI already renders; provenance block marks
 * the modelled-twin basis). 404 when no artifact exists — the client falls
 * back to the static specimen fixtures for demo plants.
 *
 * An unknown `file` stays a 400 with the allowed list, and a known file with
 * no artifact stays an honest 404: the state-of-safety panel renders its
 * "not published, connect a telemetry source" state off that 404, and an
 * asset that has never been analysed must keep reaching it.
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
      return NextResponse.json({ error: 'no_audit_artifact' }, { status: 404 });
    }

    const artifact = await readArtifact(readAccess.plant.id, kind);
    if (!artifact) {
      return NextResponse.json({ error: 'no_audit_artifact' }, { status: 404 });
    }

    return NextResponse.json({
      ...(artifact.payload as object),
      _source: 'database',
      _generatedAt: artifact.generatedAt.toISOString(),
    });
  } catch (error) {
    console.error('Error in GET /api/bess/plants/[plantId]/audit:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
