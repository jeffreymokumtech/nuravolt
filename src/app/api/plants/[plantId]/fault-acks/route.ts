import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { recordActivity } from '@/lib/activity';

/**
 * Server-side acknowledgement for artifact-derived predictive faults. Those
 * rows have no DB identity, so the client keys each by a stable `fault_key`
 * (the fault's deterministic id). Persisting the ack here means a teammate on
 * another device sees what was already triaged, instead of the old per-browser
 * localStorage ack.
 *
 * GET  -> { acked: string[] }   fault_keys acked for this org + plant
 * POST { fault_key } -> { ok }  idempotent ack (OPERATE)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'VIEW');
  if (!plantResult.ok) return plantResult.response;

  const acks = await prisma.faultAck.findMany({
    where: { org_clerk_id: orgResult.ctx.authOrgId, plant_id: plantResult.plant.id },
    select: { fault_key: true },
  });
  return NextResponse.json({ acked: acks.map((a) => a.fault_key) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, params.plantId, 'OPERATE');
  if (!plantResult.ok) return plantResult.response;

  const body = await request.json().catch(() => ({}));
  const faultKey = typeof body?.fault_key === 'string' ? body.fault_key.trim() : '';
  if (!faultKey) {
    return NextResponse.json({ error: 'fault_key is required' }, { status: 400 });
  }

  const userRow = await prisma.user.findUnique({
    where: { id: orgResult.ctx.userId },
    select: { name: true, email: true },
  });
  const who = userRow?.name || userRow?.email || 'operator';

  const existing = await prisma.faultAck.findUnique({
    where: {
      org_clerk_id_plant_id_fault_key: {
        org_clerk_id: orgResult.ctx.authOrgId,
        plant_id: plantResult.plant.id,
        fault_key: faultKey,
      },
    },
    select: { id: true },
  });

  if (!existing) {
    await prisma.faultAck.create({
      data: {
        org_clerk_id: orgResult.ctx.authOrgId,
        plant_id: plantResult.plant.id,
        fault_key: faultKey,
        acknowledged_by: who,
      },
    });
    recordActivity({
      orgClerkId: orgResult.ctx.authOrgId,
      userId: orgResult.ctx.userId,
      userLabel: who,
      action: 'fault.acknowledged',
      targetType: 'fault',
      targetId: faultKey,
      plantId: plantResult.plant.id,
    });
  }

  return NextResponse.json({ ok: true, acknowledged_by: who });
}
