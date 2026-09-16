'use client'

import { useOrganizationContext } from '@/contexts/OrganizationContext'
import { Permission } from '@/lib/auth/permissions-client'
import { Role } from '@prisma/client'

interface PermissionGateProps {
  children: React.ReactNode
  permission?: Permission
  role?: Role | Role[]
  fallback?: React.ReactNode
  requireAll?: boolean
}

export function PermissionGate({
  children,
  permission,
  role,
  fallback = null,
  requireAll = false,
}: PermissionGateProps) {
  const { hasPermission, userRole, isLoading } = useOrganizationContext()

  if (isLoading) {
    return <div className="animate-pulse bg-gray-200 rounded h-8 w-full" />
  }

  let hasAccess = false

  // Check permission
  if (permission) {
    hasAccess = hasPermission(permission)
  }

  // Check role
  if (role && userRole) {
    const roles = Array.isArray(role) ? role : [role]
    const hasRole = roles.includes(userRole)
    
    if (requireAll) {
      hasAccess = hasAccess && hasRole
    } else {
      hasAccess = hasAccess || hasRole
    }
  }

  return hasAccess ? <>{children}</> : <>{fallback}</>
}