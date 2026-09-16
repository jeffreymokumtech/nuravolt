import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead, requireOrg } from '@/lib/api/tenant';

/**
 * GET /api/inverters/[inverterId]/anomalies
 *
 * Returns anomaly-style ticket events for a given inverter. Used by the
 * RankOverTimeChart to overlay markers on the inverter's percentile-rank
 * trajectory, so an operator can see whether each anomaly fired while the
 * inverter was actually underperforming (rank in the bottom quartile) or
 * sitting in normal territory (likely false positive).
 *
 * Query params:
 *   - plant_id (optional) — narrow to a single plant
 *   - days (optional, default 90) — trailing window
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { inverterId: string } }
) {
  const inverterId = decodeURIComponent(params.inverterId);
  const { searchParams } = new URL(request.url);
  const plantId = searchParams.get('plant_id') || undefined;
  const days = Math.max(1, Math.min(parseInt(searchParams.get('days') || '90', 10), 365));

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    // Tenancy: when a plant is named, org-owned plants need a session +
    // PlantAccess (demo/unaffiliated stay publicly readable). Without a plant
    // identifier the query spans plants, so require an org session and scope
    // the tickets to the caller's org (demo identity keeps existing behavior).
    let orgScopeClerkId: string | undefined;
    if (plantId) {
      const readAccess = await resolvePlantForRead(plantId);
      if (!readAccess.ok) return readAccess.response;
    } else {
      const orgResult = await requireOrg();
      if (!orgResult.ok) return orgResult.response;
      if (!orgResult.ctx.isDemo) {
        orgScopeClerkId = orgResult.ctx.authOrgId;
      }
    }

    // Resolve plant slug → id if needed.
    let plantUuid: string | undefined;
    if (plantId) {
      const plant = await prisma.plant.findFirst({
        where: { OR: [{ id: plantId }, { slug: plantId }] },
        select: { id: true },
      });
      plantUuid = plant?.id ?? undefined;
    }

    const tickets = await prisma.ticket.findMany({
      where: {
        inverter_id: inverterId,
        ...(plantUuid ? { plant_id: plantUuid } : {}),
        ...(orgScopeClerkId ? { org_clerk_id: orgScopeClerkId } : {}),
        trigger_type: { in: ['PERFORMANCE_ANOMALY', 'THRESHOLD_ALERT'] },
        created_at: { gte: since },
      },
      select: {
        id: true,
        title: true,
        priority: true,
        status: true,
        trigger_type: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
      take: 200,
    });

    const events = tickets.map((t) => ({
      date: t.created_at.toISOString().split('T')[0],
      ticketId: t.id,
      title: t.title,
      severity: t.priority,
      status: t.status,
      source: t.trigger_type,
    }));

    return NextResponse.json({
      inverterId,
      period: { since: since.toISOString(), days },
      count: events.length,
      events,
    });
  } catch (error) {
    console.error('Failed to fetch inverter anomalies:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inverter anomalies' },
      { status: 500 }
    );
  }
}
