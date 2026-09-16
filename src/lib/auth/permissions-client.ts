import { Role } from '@prisma/client'

// Client-safe permissions that can be used in React components
export const PERMISSIONS = {
  // Organization management
  MANAGE_ORGANIZATION: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  MANAGE_BILLING: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  MANAGE_TEAM: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as Role[],
  
  // Plant management
  CREATE_PLANT: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as Role[],
  UPDATE_PLANT: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as Role[],
  DELETE_PLANT: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  ASSIGN_PLANT_ACCESS: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as Role[],
  
  // Plant operations
  VIEW_PLANT_DATA: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'] as Role[],
  CONTROL_PLANT: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR'] as Role[],
  EXPORT_DATA: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR'] as Role[],
  
  // Data connections
  CREATE_CONNECTION: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  UPDATE_CONNECTION: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  DELETE_CONNECTION: ['SUPER_ADMIN', 'ORG_ADMIN'] as Role[],
  
  // Analytics and reporting
  VIEW_ANALYTICS: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'] as Role[],
  CREATE_REPORTS: ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER', 'OPERATOR'] as Role[],
  
  // System admin
  ACCESS_ADMIN_PANEL: ['SUPER_ADMIN'] as Role[],
} as const

export type Permission = keyof typeof PERMISSIONS

// Role hierarchy for comparisons
export const ROLE_HIERARCHY: Record<Role, number> = {
  SUPER_ADMIN: 5,
  ORG_ADMIN: 4,
  MANAGER: 3,
  OPERATOR: 2,
  VIEWER: 1,
}

export function isRoleHigherOrEqual(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

export function hasRolePermission(userRole: Role | null, permission: Permission): boolean {
  if (!userRole) return false
  return PERMISSIONS[permission].includes(userRole)
}