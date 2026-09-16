import { NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { getOrgBilling, getOrgCapacityUsage } from '@/lib/billing/plan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/usage
 *
 * Effective limits + current usage for the active org — powers the billing
 * page usage meter and upgrade prompts.
 */
export async function GET() {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { ctx } = orgResult;

  const [billing, capacity, plantCount, connectionCount, memberCount] = await Promise.all([
    getOrgBilling(ctx.authOrgId),
    getOrgCapacityUsage(ctx.org.id),
    prisma.plant.count({ where: { organization_id: ctx.org.id } }),
    prisma.dataConnection.count({ where: { organization_id: ctx.org.id } }),
    prisma.member.count({ where: { organizationId: ctx.authOrgId } }).catch(() => 1),
  ]);

  const finite = (n: number) => (Number.isFinite(n) ? n : null);

  return NextResponse.json({
    plan: billing.plan,
    limits: {
      // The cap is measured in equivalent MW: max(rated MW, MWh / 4) per plant.
      mw: finite(billing.limits.mw),
      plants: finite(billing.limits.plants),
      seats: finite(billing.limits.seats),
      connections: finite(billing.limits.connections),
    },
    usage: {
      // `mw` stays the metered number so existing readers keep working;
      // rated_mw and mwh break it down for fleets that hold storage.
      mw: capacity.equivalentMw,
      rated_mw: capacity.mw,
      mwh: capacity.mwh,
      plants: plantCount,
      seats: memberCount,
      connections: connectionCount,
    },
  });
}
