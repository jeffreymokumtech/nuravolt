import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, forbidden, notFound } from '@/lib/api/tenant';
import { hasRolePermission } from '@/lib/auth/permissions-client';
import { grantPlantAccess, revokePlantAccess } from '@/lib/organizations';

/**
 * POST   /api/team/members/[userId]/plant-access  { plant_id, access_level }
 * DELETE /api/team/members/[userId]/plant-access?plant_id=…
 *
 * Grant/revoke per-plant access (VIEW/OPERATE/MANAGE) for an org member.
 * Only meaningful for OPERATOR/VIEWER members — SUPER_ADMIN/ORG_ADMIN/MANAGER
 * already get org-wide MANAGE via requirePlantAccess. Caller needs the
 * ASSIGN_PLANT_ACCESS permission (ORG_ADMIN/MANAGER+).
 */

const ACCESS_LEVELS = ['VIEW', 'OPERATE', 'MANAGE'] as const;

async function authorize(targetUserId: string) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return { ok: false as const, response: orgResult.response };
  const { ctx } = orgResult;

  if (!hasRolePermission(ctx.role, 'ASSIGN_PLANT_ACCESS')) {
    return { ok: false as const, response: forbidden('insufficient_permissions') };
  }

  // The target must be a member of the caller's org.
  const member = await prisma.member.findFirst({
    where: { organizationId: ctx.authOrgId, userId: targetUserId },
  });
  if (!member) {
    return { ok: false as const, response: notFound('member_not_found') };
  }

  return { ok: true as const, ctx };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } },
) {
  const authz = await authorize(params.userId);
  if (!authz.ok) return authz.response;
  const { ctx } = authz;

  let body: { plant_id?: string; access_level?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const plantId = body.plant_id;
  const accessLevel = body.access_level as (typeof ACCESS_LEVELS)[number];
  if (!plantId || !ACCESS_LEVELS.includes(accessLevel)) {
    return NextResponse.json(
      { error: 'plant_id and access_level (VIEW|OPERATE|MANAGE) are required' },
      { status: 400 },
    );
  }

  // The plant must belong to the caller's org (cross-tenant → 404).
  const plant = await prisma.plant.findFirst({
    where: { id: plantId, organization_id: ctx.org.id },
    select: { id: true },
  });
  if (!plant) return notFound('plant_not_found');

  try {
    const access = await grantPlantAccess(params.userId, plantId, ctx.authOrgId, accessLevel, ctx.userId);
    return NextResponse.json({
      ok: true,
      access: {
        plant_id: access.plant_id,
        access_level: access.access_level,
        granted_at: access.granted_at,
      },
    });
  } catch (error) {
    console.error('[team/plant-access] grant failed:', error);
    return NextResponse.json({ error: 'Failed to grant access' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { userId: string } },
) {
  const authz = await authorize(params.userId);
  if (!authz.ok) return authz.response;

  const plantId = request.nextUrl.searchParams.get('plant_id');
  if (!plantId) {
    return NextResponse.json({ error: 'plant_id query param is required' }, { status: 400 });
  }

  try {
    await revokePlantAccess(params.userId, plantId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    // Prisma P2025 = row already gone; treat revoke as idempotent.
    if (error?.code === 'P2025') return NextResponse.json({ ok: true });
    console.error('[team/plant-access] revoke failed:', error);
    return NextResponse.json({ error: 'Failed to revoke access' }, { status: 500 });
  }
}
