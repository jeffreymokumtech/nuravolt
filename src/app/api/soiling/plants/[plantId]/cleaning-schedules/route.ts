import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead, requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { recordActivity } from '@/lib/activity';
import {
  createCleaningSchedule,
  listCleaningSchedules,
} from '@/lib/soiling/cleaningSchedules';

/**
 * Adopted cleaning schedules for a plant.
 *
 * POST adopts a schedule from the optimizer (or a chat draft): persists a
 * CleaningSchedule row and, when asked, one SCHEDULED_MAINTENANCE ticket per
 * cleaning date. GET lists adopted schedules (latest is the active plan).
 * DELETE removes an adopted schedule; linked tickets stay (they may carry
 * work history) and simply lose their plan linkage on the UI side.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const gate = await requireFeature(orgResult.ctx.authOrgId, 'analytics:cleaning_optimizer');
    if (gate) return gate;
    const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const body = await request.json();
    const dates: string[] = Array.isArray(body.dates) ? body.dates : [];
    if (!dates.length || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(String(d)))) {
      return NextResponse.json(
        { error: 'dates must be a non-empty array of YYYY-MM-DD strings' },
        { status: 400 },
      );
    }
    if (!(Number(body.estimatedCleaningCostEur) > 0)) {
      return NextResponse.json(
        { error: 'estimatedCleaningCostEur must be > 0' },
        { status: 400 },
      );
    }

    const schedule = await createCleaningSchedule({
      plantId: plantResult.plant.id,
      orgClerkId: orgResult.ctx.authOrgId,
      userId: orgResult.ctx.userId,
      scheduleName: String(body.scheduleName || 'Adopted cleaning plan'),
      dates,
      estimatedEnergyRecoveredMwh: Number(body.estimatedEnergyRecoveredMwh ?? 0),
      estimatedRevenueRecoveredEur: Number(body.estimatedRevenueRecoveredEur ?? 0),
      estimatedCleaningCostEur: Number(body.estimatedCleaningCostEur),
      avgSrBaseline: body.avgSrBaseline != null ? Number(body.avgSrBaseline) : undefined,
      avgSrOptimized: body.avgSrOptimized != null ? Number(body.avgSrOptimized) : undefined,
      createTickets: Boolean(body.createTickets),
    });

    recordActivity({
      orgClerkId: orgResult.ctx.authOrgId,
      userId: orgResult.ctx.userId,
      action: 'cleaning_plan.adopted',
      targetType: 'cleaning_schedule',
      targetId: schedule.id,
      plantId: plantResult.plant.id,
      metadata: {
        n_cleanings: schedule.nCleanings,
        net_benefit_eur: schedule.netBenefitEur,
        tickets_created: schedule.ticketIds.length,
      },
    });

    return NextResponse.json({ data: schedule }, { status: 201 });
  } catch (error) {
    console.error('cleaning-schedules POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;
  if (!readAccess.plant) return NextResponse.json({ data: [] });
  const schedules = await listCleaningSchedules(readAccess.plant.id);
  return NextResponse.json({ data: schedules });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'OPERATE');
  if (!plantResult.ok) return plantResult.response;

  const scheduleId = new URL(request.url).searchParams.get('scheduleId');
  if (!scheduleId) {
    return NextResponse.json({ error: 'scheduleId query parameter required' }, { status: 400 });
  }
  const row = await prisma.cleaningSchedule.findFirst({
    where: { id: scheduleId, plant_id: plantResult.plant.id },
  });
  if (!row) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }
  await prisma.cleaningSchedule.delete({ where: { id: scheduleId } });
  recordActivity({
    orgClerkId: orgResult.ctx.authOrgId,
    userId: orgResult.ctx.userId,
    action: 'cleaning_plan.removed',
    targetType: 'cleaning_schedule',
    targetId: scheduleId,
    plantId: plantResult.plant.id,
  });
  return NextResponse.json({ data: { deleted: true, id: scheduleId } });
}
