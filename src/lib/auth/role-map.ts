import prisma from '@/libs/prisma';
import { Role } from '@prisma/client';

/**
 * Better Auth member role ↔ legacy Role enum bridge.
 *
 * The legacy `UserRole` table is the source of truth for authorization
 * (requireOrg/requirePlantAccess and the PERMISSIONS matrix all read it);
 * Better Auth's Member.role (owner/admin/member) is the transport the org
 * plugin manages. The organizationHooks in src/lib/auth.ts call these helpers
 * so every membership change lands in both systems.
 *
 * Mapping rationale:
 *  - owner  → ORG_ADMIN (matches afterCreateOrganization's creator grant)
 *  - admin  → MANAGER   (both systems agree: may invite/remove members,
 *                        holds MANAGE_TEAM/ASSIGN_PLANT_ACCESS, org-wide
 *                        MANAGE on plants)
 *  - member → VIEWER    (least privilege; per-plant elevation happens via
 *                        PlantAccess VIEW/OPERATE/MANAGE grants)
 */
export const AUTH_ROLE_TO_LEGACY: Record<string, Role> = {
  owner: 'ORG_ADMIN',
  admin: 'MANAGER',
  member: 'VIEWER',
};

export const LEGACY_TO_AUTH_ROLE: Partial<Record<Role, string>> = {
  ORG_ADMIN: 'owner',
  MANAGER: 'admin',
  OPERATOR: 'member',
  VIEWER: 'member',
};

/** Human labels for the roles the team UI exposes. */
export const AUTH_ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Manager',
  member: 'Viewer',
};

export function legacyRoleFor(authRole: string | null | undefined): Role {
  return AUTH_ROLE_TO_LEGACY[authRole ?? 'member'] ?? 'VIEWER';
}

/**
 * Upsert the legacy UserRole row for a Better Auth member. Idempotent —
 * safe to call from hooks and from the lazy-heal path in /api/team/members.
 */
export async function syncMemberRole(
  userId: string,
  authOrgId: string,
  authRole: string | null | undefined,
): Promise<void> {
  const role = legacyRoleFor(authRole);
  await prisma.userRole.upsert({
    where: {
      user_clerk_id_org_clerk_id: {
        user_clerk_id: userId,
        org_clerk_id: authOrgId,
      },
    },
    update: { role },
    create: {
      user_clerk_id: userId,
      org_clerk_id: authOrgId,
      role,
    },
  });
}

/**
 * Remove a departed member's legacy authorization state (org role + all
 * plant grants). Idempotent.
 */
export async function removeMemberAuthz(userId: string, authOrgId: string): Promise<void> {
  await prisma.userRole.deleteMany({
    where: { user_clerk_id: userId, org_clerk_id: authOrgId },
  });
  await prisma.plantAccess.deleteMany({
    where: { user_clerk_id: userId, org_clerk_id: authOrgId },
  });
}
