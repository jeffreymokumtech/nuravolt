import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { recordActivity } from '@/lib/activity';
import { emitAlertEvent } from '@/lib/integrations/webhooks';

/**
 * PATCH /api/plants/[plantId]/alerts/[alertId]
 *
 * Operator actions on a plant alert:
 *   { action: "acknowledge" } — stamps acknowledged_at/by; the alert stays
 *     ACTIVE (ack is "seen, being handled", not "gone"). Idempotent.
 *   { action: "resolve" } — sets RESOLVED + resolved_at and marks the row
 *     context.manual_resolve so the cron's flap guard does not silently
 *     reopen it; if the condition persists, the next evaluation opens a
 *     fresh alert instead.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { plantId: string; alertId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'OPERATE');
  if (!plantResult.ok) return plantResult.response;

  const body = await request.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'acknowledge' && action !== 'resolve') {
    return NextResponse.json(
      { error: 'action must be "acknowledge" or "resolve"' },
      { status: 400 },
    );
  }

  const alert = await prisma.plantAlert.findFirst({
    where: { id: params.alertId, plant_id: plantResult.plant.id },
  });
  if (!alert) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
  }

  const userRow = await prisma.user.findUnique({
    where: { id: orgResult.ctx.userId },
    select: { name: true, email: true },
  });
  const who = userRow?.name || userRow?.email || 'operator';

  const plant = await prisma.plant.findUnique({
    where: { id: plantResult.plant.id },
    select: { slug: true, name: true },
  });
  const alertBase = process.env.NEXT_PUBLIC_APP_URL ?? 'https://nuravolt.com';
  const alertEventData = {
    id: alert.id,
    kind: alert.kind,
    severity: alert.severity,
    message: alert.message,
    metric_value: alert.metric_value,
    threshold: alert.threshold,
    plant_slug: plant?.slug ?? null,
    plant_name: plant?.name ?? null,
    acknowledged_by: who,
    url: plant?.slug ? `${alertBase}/dashboard/plant/${plant.slug}` : undefined,
  };

  if (action === 'acknowledge') {
    const updated = alert.acknowledged_at
      ? alert
      : await prisma.plantAlert.update({
          where: { id: alert.id },
          data: { acknowledged_at: new Date(), acknowledged_by: who },
        });
    if (!alert.acknowledged_at) {
      recordActivity({
        orgClerkId: orgResult.ctx.authOrgId,
        userId: orgResult.ctx.userId,
        userLabel: who,
        action: 'alert.acknowledged',
        targetType: 'alert',
        targetId: alert.id,
        plantId: plantResult.plant.id,
        metadata: { kind: alert.kind, severity: alert.severity },
      });
      await emitAlertEvent(orgResult.ctx.authOrgId, 'alert.acknowledged', {
        ...alertEventData,
        status: updated.status,
      });
    }
    return NextResponse.json({ data: view(updated) });
  }

  // resolve
  if (alert.status === 'RESOLVED') {
    return NextResponse.json({ data: view(alert) });
  }
  const updated = await prisma.plantAlert.update({
    where: { id: alert.id },
    data: {
      status: 'RESOLVED',
      resolved_at: new Date(),
      acknowledged_at: alert.acknowledged_at ?? new Date(),
      acknowledged_by: alert.acknowledged_by ?? who,
      context: {
        ...((alert.context as Record<string, unknown>) ?? {}),
        manual_resolve: true,
        resolved_by: who,
      },
    },
  });
  recordActivity({
    orgClerkId: orgResult.ctx.authOrgId,
    userId: orgResult.ctx.userId,
    userLabel: who,
    action: 'alert.resolved',
    targetType: 'alert',
    targetId: alert.id,
    plantId: plantResult.plant.id,
    metadata: { kind: alert.kind, severity: alert.severity },
  });
  await emitAlertEvent(orgResult.ctx.authOrgId, 'alert.resolved', {
    ...alertEventData,
    status: 'RESOLVED',
  });
  return NextResponse.json({ data: view(updated) });
}

function view(a: {
  id: string;
  status: string;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
}) {
  return {
    id: a.id,
    status: a.status,
    acknowledged_at: a.acknowledged_at?.toISOString() ?? null,
    acknowledged_by: a.acknowledged_by,
    resolved_at: a.resolved_at?.toISOString() ?? null,
  };
}
