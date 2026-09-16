import { NextResponse } from 'next/server';
import { getUserRoleInOrganization } from '@/lib/organizations';

/**
 * API keys outlive the session that minted them, so creation/revocation is
 * an org-management action: SUPER_ADMIN / ORG_ADMIN / MANAGER only (same
 * rule as connection mutations, see hasOrgManageRole in tenant.ts). Plain
 * members (OPERATOR / VIEWER — e.g. a shared demo login) can list keys but
 * not mint or revoke. Returns the 403 response to send, or null to proceed.
 */
export async function requireKeyManageRole(
  userId: string,
  orgId: string
): Promise<NextResponse | null> {
  if (orgId.startsWith('demo_')) return null; // dev demo identity
  const role = await getUserRoleInOrganization(userId, orgId);
  if (role && ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'].includes(role)) return null;
  return NextResponse.json({ error: 'org_manage_role_required' }, { status: 403 });
}
