import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';

/**
 * GET /api/notifications
 *
 * Recent active plant alerts across the org (newest first) for the in-app
 * notification bell. Org-scoped, matching the fleet alert strip. Read-only.
 * Returns 401 for unauthenticated contexts (public demo); the bell treats that
 * as "no notifications".
 */
export async function GET(_request: NextRequest) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;

  const alerts = await prisma.plantAlert.findMany({
    where: { org_clerk_id: orgResult.ctx.authOrgId, status: 'ACTIVE' },
    orderBy: [{ triggered_at: 'desc' }],
    take: 30,
    include: { plant: { select: { slug: true, name: true } } },
  });

  const items = alerts.map((a) => ({
    id: a.id,
    plant_slug: a.plant.slug,
    plant_name: a.plant.name,
    kind: a.kind,
    severity: a.severity,
    message: a.message,
    created_at: a.triggered_at.toISOString(),
    acknowledged_at: a.acknowledged_at ? a.acknowledged_at.toISOString() : null,
  }));

  return NextResponse.json({
    items,
    count: items.length,
    unacknowledged: items.filter((i) => !i.acknowledged_at).length,
  });
}
