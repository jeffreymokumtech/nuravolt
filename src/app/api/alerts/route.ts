import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';

/**
 * GET /api/alerts?status=active|resolved
 *
 * Org-wide plant alerts (newest first), grouped per plant — feeds the fleet
 * home's needs-attention strip.
 */
export async function GET(request: NextRequest) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') === 'resolved' ? 'RESOLVED' : 'ACTIVE';

  const alerts = await prisma.plantAlert.findMany({
    where: { org_clerk_id: orgResult.ctx.authOrgId, status },
    orderBy: [{ severity: 'desc' }, { triggered_at: 'desc' }],
    take: 200,
    include: { plant: { select: { slug: true, name: true } } },
  });

  const byPlant = new Map<string, { slug: string; name: string; critical: number; warning: number; alerts: unknown[] }>();
  for (const a of alerts) {
    const entry = byPlant.get(a.plant_id) ?? {
      slug: a.plant.slug,
      name: a.plant.name,
      critical: 0,
      warning: 0,
      alerts: [],
    };
    if (a.severity === 'CRITICAL') entry.critical++;
    else entry.warning++;
    entry.alerts.push({
      id: a.id,
      kind: a.kind,
      severity: a.severity,
      message: a.message,
      metric_value: a.metric_value,
      threshold: a.threshold,
      triggered_at: a.triggered_at,
    });
    byPlant.set(a.plant_id, entry);
  }

  return NextResponse.json({
    status: status.toLowerCase(),
    total: alerts.length,
    plants: Array.from(byPlant.values()).sort((a, b) => b.critical - a.critical || b.warning - a.warning),
  });
}
