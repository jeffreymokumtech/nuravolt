import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import type { TicketStats, TicketStatus, TicketPriority, TicketTriggerType } from '@/types/tickets';

// GET /api/tickets/stats - Get ticket statistics.
// Optional ?plant_id=<Plant.id> scopes the counts to one plant (used by the
// per-plant overview KPI); omit it for the org-wide fleet total. Because every
// where also pins org_clerk_id, an out-of-org plant_id simply yields zeros.
export async function GET(request: Request) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const plantId = new URL(request.url).searchParams.get('plant_id') || undefined;
    const baseWhere = { org_clerk_id: authOrgId, ...(plantId ? { plant_id: plantId } : {}) };
    const plantCond = plantId ? Prisma.sql`AND plant_id = ${plantId}` : Prisma.empty;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get counts by status, priority, and trigger type
    const [
      statusCounts,
      priorityCounts,
      triggerCounts,
      total,
      createdToday,
      closedToday,
      avgResolutionTime,
    ] = await Promise.all([
      prisma.ticket.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.ticket.groupBy({
        by: ['priority'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.ticket.groupBy({
        by: ['trigger_type'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.ticket.count({
        where: baseWhere,
      }),
      prisma.ticket.count({
        where: { ...baseWhere, created_at: { gte: today } },
      }),
      prisma.ticket.count({
        where: { ...baseWhere, closed_at: { gte: today } },
      }),
      // Calculate average resolution time for closed tickets
      prisma.$queryRaw<{ avg_hours: number }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600) as avg_hours
        FROM "Ticket"
        WHERE org_clerk_id = ${authOrgId}
        ${plantCond}
        AND closed_at IS NOT NULL
        AND status IN ('DONE', 'WONT_FIX')
      `,
    ]);

    // Initialize with zeros for all enum values
    const byStatus: Record<TicketStatus, number> = {
      NEW: 0,
      VALIDATED: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      DONE: 0,
      WONT_FIX: 0,
    };
    const byPriority: Record<TicketPriority, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    const byTriggerType: Record<TicketTriggerType, number> = {
      SOILING_FORECAST: 0,
      PERFORMANCE_ANOMALY: 0,
      THRESHOLD_ALERT: 0,
      SCHEDULED_MAINTENANCE: 0,
      MANUAL_CREATION: 0,
    };

    // Fill in actual counts
    statusCounts.forEach((row) => {
      byStatus[row.status as TicketStatus] = row._count._all;
    });
    priorityCounts.forEach((row) => {
      byPriority[row.priority as TicketPriority] = row._count._all;
    });
    triggerCounts.forEach((row) => {
      byTriggerType[row.trigger_type as TicketTriggerType] = row._count._all;
    });

    const openCount = byStatus.NEW + byStatus.VALIDATED + byStatus.ASSIGNED + byStatus.IN_PROGRESS;
    const closedCount = byStatus.DONE + byStatus.WONT_FIX;

    const stats: TicketStats = {
      total,
      by_status: byStatus,
      by_priority: byPriority,
      by_trigger_type: byTriggerType,
      open_count: openCount,
      closed_count: closedCount,
      avg_resolution_time_hours: avgResolutionTime[0]?.avg_hours
        ? Math.round(avgResolutionTime[0].avg_hours * 10) / 10
        : undefined,
      created_today: createdToday,
      closed_today: closedToday,
    };

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching ticket stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch ticket statistics' },
      { status: 500 }
    );
  }
}
