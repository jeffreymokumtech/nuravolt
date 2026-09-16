import { Role } from '@prisma/client'

export const ROLE_DESCRIPTIONS = {
  [Role.SUPER_ADMIN]: {
    name: 'Super Admin',
    description: 'Full system access across all organizations',
    color: 'blue',
    icon: 'shield',
  },
  [Role.ORG_ADMIN]: {
    name: 'Organization Admin',
    description: 'Full access within the organization',
    color: 'blue',
    icon: 'crown',
  },
  [Role.MANAGER]: {
    name: 'Manager',
    description: 'Manage plants, teams, and view all data',
    color: 'blue',
    icon: 'briefcase',
  },
  [Role.OPERATOR]: {
    name: 'Operator',
    description: 'Operate assigned plants and create reports',
    color: 'blue',
    icon: 'wrench',
  },
  [Role.VIEWER]: {
    name: 'Viewer',
    description: 'View data from assigned plants',
    color: 'gray',
    icon: 'eye',
  },
}

export function getRoleDisplayName(role: Role): string {
  return ROLE_DESCRIPTIONS[role]?.name || role
}

export function getRoleDescription(role: Role): string {
  return ROLE_DESCRIPTIONS[role]?.description || ''
}

export function getRoleColor(role: Role): string {
  return ROLE_DESCRIPTIONS[role]?.color || 'gray'
}

export function getRoleIcon(role: Role): string {
  return ROLE_DESCRIPTIONS[role]?.icon || 'user'
}