import { NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { getOrgBilling } from '@/lib/billing/plan';
import { hasRolePermission } from '@/lib/auth/permissions-client';
import { legacyRoleFor, syncMemberRole } from '@/lib/auth/role-map';

/**
 * GET /api/team/members
 *
 * Merged team view for the settings/team page: Better Auth members joined
 * with legacy UserRole (authz source of truth) + PlantAccess grants, pending
 * invitations, the org's plants (for the access editor), and seat usage.
 *
 * Readable by any org member; mutation capabilities are reported via
 * canManage/canAssignPlantAccess and enforced server-side elsewhere
 * (authClient.organization.* endpoints + /api/team/members/[userId]/plant-access).
 *
 * Lazy-heal: any Member without a UserRole row gets one upserted from its
 * Better Auth role, covering members added before the sync hooks existed.
 */
export async function GET() {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { ctx } = orgResult;

  try {
    const [members, userRoles, plantAccess, invitations, plants, billing] = await Promise.all([
      prisma.member.findMany({
        where: { organizationId: ctx.authOrgId },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.userRole.findMany({ where: { org_clerk_id: ctx.authOrgId } }),
      prisma.plantAccess.findMany({
        where: { org_clerk_id: ctx.authOrgId },
        include: { plant: { select: { id: true, name: true, slug: true } } },
      }),
      prisma.invitation.findMany({
        where: { organizationId: ctx.authOrgId, status: 'pending' },
        orderBy: { expiresAt: 'asc' },
      }),
      prisma.plant.findMany({
        where: { organization_id: ctx.org.id },
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      }),
      getOrgBilling(ctx.authOrgId),
    ]);

    const roleByUser = new Map(userRoles.map((r) => [r.user_clerk_id, r.role]));
    const accessByUser = new Map<string, typeof plantAccess>();
    for (const access of plantAccess) {
      const list = accessByUser.get(access.user_clerk_id) ?? [];
      list.push(access);
      accessByUser.set(access.user_clerk_id, list);
    }

    // Lazy-heal members that predate the role-sync hooks.
    for (const member of members) {
      if (!roleByUser.has(member.userId)) {
        const healed = legacyRoleFor(member.role);
        await syncMemberRole(member.userId, ctx.authOrgId, member.role).catch(() => {});
        roleByUser.set(member.userId, healed);
      }
    }

    const seatCap = Number.isFinite(billing.limits.seats) ? billing.limits.seats : null;

    return NextResponse.json({
      members: members.map((member) => ({
        memberId: member.id,
        userId: member.userId,
        name: member.user?.name ?? null,
        email: member.user?.email ?? null,
        image: member.user?.image ?? null,
        authRole: member.role,
        role: roleByUser.get(member.userId) ?? legacyRoleFor(member.role),
        joinedAt: member.createdAt,
        isSelf: member.userId === ctx.userId,
        plantAccess: (accessByUser.get(member.userId) ?? []).map((a) => ({
          plant_id: a.plant_id,
          plant_name: a.plant?.name ?? null,
          plant_slug: a.plant?.slug ?? null,
          access_level: a.access_level,
          expires_at: a.expires_at,
        })),
      })),
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt,
      })),
      plants,
      seats: {
        used: members.length,
        pending: invitations.length,
        cap: seatCap,
      },
      plan: billing.plan,
      canManage: hasRolePermission(ctx.role, 'MANAGE_TEAM'),
      canAssignPlantAccess: hasRolePermission(ctx.role, 'ASSIGN_PLANT_ACCESS'),
    });
  } catch (error) {
    console.error('[team/members] failed:', error);
    return NextResponse.json({ error: 'Failed to load team' }, { status: 500 });
  }
}
