import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import {
  IRRADIANCE_SOURCES,
  SOILING_REFERENCES,
  mergeSettings,
  type PlantSettings,
} from '@/lib/plants/settings';

/**
 * Plant-level settings, persisted on Plant.metadata.settings (no dedicated
 * table — these are a handful of thresholds and toggles). The alert
 * evaluator (src/lib/alerts/evaluate.ts) reads the same shape via
 * src/lib/plants/settings.ts.
 *
 * GET  /api/plants/[plantId]/settings          → { settings } (VIEW access)
 * PUT  /api/plants/[plantId]/settings  { ... } → { settings } (MANAGE access)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'VIEW');
  if (!plantResult.ok) return plantResult.response;

  const metadata = (plantResult.plant.metadata ?? {}) as Record<string, unknown>;
  return NextResponse.json({ settings: mergeSettings(metadata.settings) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
  if (!plantResult.ok) return plantResult.response;

  let body: Partial<PlantSettings>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Reject unknown source enum values outright (a typo'd source silently
  // falling back to auto would misreport what the pipeline will do).
  if (
    body.dataSources?.irradianceSource !== undefined &&
    !IRRADIANCE_SOURCES.includes(body.dataSources.irradianceSource)
  ) {
    return NextResponse.json(
      { error: `irradianceSource must be one of ${IRRADIANCE_SOURCES.join('|')}` },
      { status: 400 },
    );
  }
  if (
    body.dataSources?.soilingReference !== undefined &&
    !SOILING_REFERENCES.includes(body.dataSources.soilingReference)
  ) {
    return NextResponse.json(
      { error: `soilingReference must be one of ${SOILING_REFERENCES.join('|')}` },
      { status: 400 },
    );
  }

  const current = (plantResult.plant.metadata ?? {}) as Record<string, unknown>;
  const stored = mergeSettings(current.settings);
  const merged = mergeSettings({
    alerts: { ...stored.alerts, ...(body.alerts ?? {}) },
    notifications: { ...stored.notifications, ...(body.notifications ?? {}) },
    dataSources: { ...stored.dataSources, ...(body.dataSources ?? {}) },
  });

  // Numeric sanity: thresholds are percentages.
  merged.alerts.soilingLossPct = Math.min(50, Math.max(0, Number(merged.alerts.soilingLossPct) || 0));
  merged.alerts.performanceRatioPct = Math.min(
    100,
    Math.max(0, Number(merged.alerts.performanceRatioPct) || 0)
  );

  await prisma.plant.update({
    where: { id: plantResult.plant.id },
    data: { metadata: { ...current, settings: merged } },
  });

  return NextResponse.json({ settings: merged });
}
