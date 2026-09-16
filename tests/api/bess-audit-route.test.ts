/**
 * The BESS audit route's file-to-artifact-kind chain.
 *
 * `?file=safety` used to 400 with "invalid_file". The state-of-safety panel
 * fetches exactly that URL, so a computed composite could sit in the database
 * and the console would still say "not published". These tests drive GET
 * directly (the map itself cannot be exported: a route module may only export
 * Next's own route fields) and pin the three outcomes that matter:
 *
 *   known file + artifact present  -> 200 with the payload
 *   known file + no artifact       -> 404, so the panel keeps its honest
 *                                     "not published, connect a source" state
 *                                     for an asset nobody has analysed yet
 *   unknown file                   -> 400, with the allowed list
 *
 * Tenancy, billing and artifact reads are mocked: this file is about the
 * routing decision, not about who may see it.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readArtifact = vi.fn();
const requireFeature = vi.fn(async () => null);
const resolvePlantForRead = vi.fn(async () => ({
  ok: true as const,
  access: 'demo' as const,
  ctx: { authOrgId: 'org-1' },
  plant: { id: 'plant-uuid-1', slug: 'ribera' },
}));

vi.mock('@/lib/analysis/artifacts', () => ({ readArtifact }));
vi.mock('@/lib/billing/gate', () => ({ requireFeature }));
vi.mock('@/lib/api/tenant', () => ({ resolvePlantForRead }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GET } = await import('@/app/api/bess/plants/[plantId]/audit/route');

const call = (file: string | null) =>
  GET(
    new NextRequest(
      `http://localhost/api/bess/plants/ribera/audit${file ? `?file=${file}` : ''}`,
    ),
    { params: { plantId: 'ribera' } },
  );

const SAFETY_PAYLOAD = {
  disclosure:
    'State of safety is a trend and margin indicator computed from 60 minute ' +
    'cloud telemetry. It is not a protection system and must not be relied on ' +
    'for emergency response. Your BMS and fire detection system are.',
  provisional: true,
  readings: [
    {
      asset_id: 'asset-uuid-1',
      device_id: 'BESS bess-ribera-001',
      score: 62,
      band: 'MODERATE',
      limiting_index: 'dwell_exposure',
      unavailable: ['imbalance', 'protection_status'],
    },
  ],
};

beforeEach(() => {
  readArtifact.mockReset();
  requireFeature.mockClear();
  resolvePlantForRead.mockClear();
});

describe('GET /api/bess/plants/[plantId]/audit', () => {
  it('serves the state-of-safety artifact for file=safety', async () => {
    readArtifact.mockResolvedValue({
      payload: SAFETY_PAYLOAD,
      source: 'computed',
      modelVersion: 'bess-state-of-safety-v1',
      generatedAt: new Date('2026-07-31T06:00:00Z'),
    });

    const res = await call('safety');
    expect(res.status).toBe(200);
    // The mapping under test: file=safety resolves to the kind the pipeline
    // writes and src/lib/alerts/evaluate.ts evaluates.
    expect(readArtifact).toHaveBeenCalledWith('plant-uuid-1', 'bess_state_of_safety');

    const body = await res.json();
    expect(body.readings[0].limiting_index).toBe('dwell_exposure');
    expect(body.provisional).toBe(true);
    expect(body._source).toBe('database');
  });

  it('keeps the existing optimizer and dossier mappings', async () => {
    readArtifact.mockResolvedValue({
      payload: {},
      source: 'computed',
      modelVersion: 'bess-audit-v1',
      generatedAt: new Date(),
    });

    await call('optimizer');
    expect(readArtifact).toHaveBeenLastCalledWith('plant-uuid-1', 'bess_optimizer_audit');
    await call('dossier');
    expect(readArtifact).toHaveBeenLastCalledWith('plant-uuid-1', 'bess_warranty_dossier');
    // The default when no file is given must not move either.
    await call(null);
    expect(readArtifact).toHaveBeenLastCalledWith('plant-uuid-1', 'bess_warranty_dossier');
  });

  it('404s for a known file with no artifact, so the panel can say not published', async () => {
    readArtifact.mockResolvedValue(null);
    const res = await call('safety');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_audit_artifact');
  });

  it('still 400s on a genuinely unknown file and lists what is allowed', async () => {
    const res = await call('sabotage');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_file');
    expect(body.allowed).toEqual(['optimizer', 'dossier', 'safety']);
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
