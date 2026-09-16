import prisma from '@/libs/prisma';

/**
 * Read a per-plant nested-JSON artifact (soiling streams, enhanced faults, …)
 * written by the Python synthesis modules into `AnalysisArtifact`. One row per
 * (plant, kind). Section routes call this DB-first, then fall back to the demo
 * fixture, then an honest empty/"connect a source" state.
 *
 * `plantId` MUST be the resolved Plant UUID (artifacts are keyed by it), not a
 * slug — routes get it from `resolvePlantForRead(...).plant.id`.
 */
export interface Artifact<T = unknown> {
  payload: T;
  source: string; // 'synthetic' | 'computed' | 'ingested'
  modelVersion: string | null;
  generatedAt: Date;
}

export async function readArtifact<T = unknown>(
  plantUuid: string,
  kind: string,
): Promise<Artifact<T> | null> {
  try {
    const row = await prisma.analysisArtifact.findUnique({
      where: { plant_id_kind: { plant_id: plantUuid, kind } },
    });
    if (!row) return null;
    return {
      payload: row.payload as T,
      source: row.source,
      modelVersion: row.model_version,
      generatedAt: row.generated_at,
    };
  } catch {
    // DB down / table missing → let the caller fall back to fixtures.
    return null;
  }
}
