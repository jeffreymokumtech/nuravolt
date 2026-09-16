import prisma from '@/libs/prisma'
import { Role } from '@prisma/client'

export async function getOrCreateOrganization(orgId: string) {
  // First check if organization exists in the legacy table (clerk_org_id is
  // the external-id column; it holds the Better Auth organization id)
  let organization = await prisma.organization.findUnique({
    where: { clerk_org_id: orgId },
  })

  if (!organization) {
    // Fetch organization details from the Better Auth org table
    const authOrg = await prisma.authOrganization.findUnique({
      where: { id: orgId },
    })

    // Create organization in database
    organization = await prisma.organization.create({
      data: {
        clerk_org_id: orgId,
        name: authOrg?.name || 'Unnamed Organization',
        plan_type: 'free',
        max_plants: 5,
        max_users: 5,
      },
    })
  }

  return organization
}

export async function getUserRoleInOrganization(
  userId: string,
  orgId: string
): Promise<Role | null> {
  const userRole = await prisma.userRole.findUnique({
    where: {
      user_clerk_id_org_clerk_id: {
        user_clerk_id: userId,
        org_clerk_id: orgId,
      },
    },
  })

  return userRole?.role || null
}

export async function hasPermission(
  userId: string,
  orgId: string,
  requiredRoles: Role[]
): Promise<boolean> {
  const userRole = await getUserRoleInOrganization(userId, orgId)
  
  if (!userRole) return false
  
  // Super admin has access to everything
  if (userRole === Role.SUPER_ADMIN) return true
  
  // Check if user has one of the required roles
  return requiredRoles.includes(userRole)
}

export async function getUserPlantAccess(
  userId: string,
  orgId: string,
  plantId?: string
) {
  const baseQuery = {
    user_clerk_id: userId,
    org_clerk_id: orgId,
    ...(plantId && { plant_id: plantId }),
  }

  if (plantId) {
    // Check specific plant access
    const access = await prisma.plantAccess.findUnique({
      where: {
        user_clerk_id_plant_id: {
          user_clerk_id: userId,
          plant_id: plantId,
        },
      },
    })

    // Also check if user has org-wide access
    const userRole = await getUserRoleInOrganization(userId, orgId)
    
    // Org admins and managers have access to all plants
    if (userRole && ([Role.SUPER_ADMIN, Role.ORG_ADMIN, Role.MANAGER] as Role[]).includes(userRole)) {
      return {
        hasAccess: true,
        accessLevel: 'MANAGE',
        fromRole: true,
      }
    }

    return {
      hasAccess: !!access,
      accessLevel: access?.access_level || null,
      fromRole: false,
    }
  } else {
    // Get all plant access for user
    const plantAccess = await prisma.plantAccess.findMany({
      where: baseQuery,
      include: {
        plant: true,
      },
    })

    return plantAccess
  }
}

export async function grantPlantAccess(
  userId: string,
  plantId: string,
  orgId: string,
  accessLevel: 'VIEW' | 'OPERATE' | 'MANAGE',
  grantedBy: string
) {
  return await prisma.plantAccess.upsert({
    where: {
      user_clerk_id_plant_id: {
        user_clerk_id: userId,
        plant_id: plantId,
      },
    },
    update: {
      access_level: accessLevel,
      granted_by: grantedBy,
      granted_at: new Date(),
    },
    create: {
      user_clerk_id: userId,
      plant_id: plantId,
      org_clerk_id: orgId,
      access_level: accessLevel,
      granted_by: grantedBy,
    },
  })
}

export async function revokePlantAccess(userId: string, plantId: string) {
  return await prisma.plantAccess.delete({
    where: {
      user_clerk_id_plant_id: {
        user_clerk_id: userId,
        plant_id: plantId,
      },
    },
  })
}

// Helper function to get plants user has access to
export async function getUserAccessiblePlants(userId: string, orgId: string) {
  const userRole = await getUserRoleInOrganization(userId, orgId)
  
  // Org admins and managers see all plants
  if (userRole && ([Role.SUPER_ADMIN, Role.ORG_ADMIN, Role.MANAGER] as Role[]).includes(userRole)) {
    return await prisma.discoveredPlant.findMany({
      where: {
        connection: {
          organization_id: orgId,
        },
        enabled: true,
      },
      include: {
        connection: true,
      },
    })
  }
  
  // Others only see plants they have specific access to
  const plantAccess = await prisma.plantAccess.findMany({
    where: {
      user_clerk_id: userId,
      org_clerk_id: orgId,
      OR: [
        { expires_at: null },
        { expires_at: { gt: new Date() } },
      ],
    },
    include: {
      plant: {
        include: {
          connection: true,
        },
      },
    },
  })
  
  return plantAccess.map(access => access.plant)
}