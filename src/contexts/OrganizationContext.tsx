'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { Role } from '@prisma/client'
import { Permission, PERMISSIONS } from '@/lib/auth/permissions-client'

interface OrganizationContextType {
  organization: any | null
  userRole: Role | null
  permissions: Permission[]
  hasPermission: (permission: Permission) => boolean
  isLoading: boolean
}

const OrganizationContext = createContext<OrganizationContextType>({
  organization: null,
  userRole: null,
  permissions: [],
  hasPermission: () => false,
  isLoading: true,
})

export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession()
  const { data: organization } = authClient.useActiveOrganization()
  const [userRole, setUserRole] = useState<Role | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const userId = session?.user.id ?? null
  const orgId = session?.session.activeOrganizationId ?? null

  useEffect(() => {
    async function fetchUserRole() {
      // For now, skip the API call and just set default values
      // This prevents the 401 errors while we focus on getting the dashboard working
      setUserRole(null)
      setPermissions([])
      setIsLoading(isPending)
    }

    fetchUserRole()
  }, [userId, orgId, isPending])

  const hasPermission = (permission: Permission): boolean => {
    return permissions.includes(permission)
  }

  return (
    <OrganizationContext.Provider
      value={{
        organization,
        userRole,
        permissions,
        hasPermission,
        isLoading,
      }}
    >
      {children}
    </OrganizationContext.Provider>
  )
}

export function useOrganizationContext() {
  const context = useContext(OrganizationContext)
  if (!context) {
    throw new Error('useOrganizationContext must be used within OrganizationProvider')
  }
  return context
}
