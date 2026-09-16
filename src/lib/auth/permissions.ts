import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getUserRoleInOrganization, hasPermission as checkPermission } from '@/lib/organizations'
import { NextResponse } from 'next/server'
import { Permission, PERMISSIONS } from '@/lib/auth/permissions-client'

export type { Permission }

async function getAuthIds(): Promise<{ userId: string | null; orgId: string | null }> {
  try {
    const session = await auth.api.getSession({ headers: headers() })
    return {
      userId: session?.user.id ?? null,
      orgId: session?.session.activeOrganizationId ?? null,
    }
  } catch {
    return { userId: null, orgId: null }
  }
}

// Middleware to check permissions in API routes
export async function requirePermission(permission: Permission) {
  const { userId, orgId } = await getAuthIds()

  if (!userId || !orgId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const hasAccess = await checkPermission(userId, orgId, PERMISSIONS[permission])

  if (!hasAccess) {
    return NextResponse.json(
      { error: 'Forbidden: Insufficient permissions' },
      { status: 403 }
    )
  }

  return null // Permission granted
}

// Get current user's permissions
export async function getUserPermissions() {
  const { userId, orgId } = await getAuthIds()

  if (!userId || !orgId) {
    return []
  }

  const userRole = await getUserRoleInOrganization(userId, orgId)

  if (!userRole) {
    return []
  }

  // Return all permissions this role has
  const permissions: Permission[] = []

  for (const [permission, roles] of Object.entries(PERMISSIONS)) {
    if (roles.includes(userRole)) {
      permissions.push(permission as Permission)
    }
  }

  return permissions
}

// Check if user has specific permission
export async function hasPermission(permission: Permission): Promise<boolean> {
  const { userId, orgId } = await getAuthIds()

  if (!userId || !orgId) {
    return false
  }

  return checkPermission(userId, orgId, PERMISSIONS[permission])
}

// Export role utilities from client version
export { isRoleHigherOrEqual } from '@/lib/auth/permissions-client'
