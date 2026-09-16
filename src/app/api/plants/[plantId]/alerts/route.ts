import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/plants/[plantId]/alerts
 *
 * Active alerts + the last 30 days of resolved ones for the plant-overview
 * alert strip. Always 200 with empty arrays when the plant has none.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;
  if (!readAccess.plant) return NextResponse.json({ active: [], resolved: [] });

  const since = new Date(Date.now() - 30 * 86_400_000);
  const [active, resolved] = await Promise.all([
    prisma.plantAlert.findMany({
      where: { plant_id: readAccess.plant.id, status: 'ACTIVE' },
      orderBy: [{ severity: 'desc' }, { triggered_at: 'desc' }],
    }),
    prisma.plantAlert.findMany({
      where: { plant_id: readAccess.plant.id, status: 'RESOLVED', resolved_at: { gte: since } },
      orderBy: { resolved_at: 'desc' },
      take: 20,
    }),
  ]);

  const shape = (a: (typeof active)[number]) => ({
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    status: a.status,
    message: a.message,
    metric_value: a.metric_value,
    threshold: a.threshold,
    triggered_at: a.triggered_at,
    resolved_at: a.resolved_at,
    acknowledged_at: a.acknowledged_at,
    acknowledged_by: a.acknowledged_by,
    // "Per the manual" action distilled from equipment docs, when available.
    manual_guidance:
      (a.context as { manual_guidance?: unknown } | null)?.manual_guidance ?? null,
  });

  return NextResponse.json({ active: active.map(shape), resolved: resolved.map(shape) });
}
