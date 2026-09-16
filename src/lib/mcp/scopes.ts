/**
 * MCP API-key scopes. Customers pick these when generating a key; every
 * tool handler declares which scope(s) it requires.
 *
 * Naming: `<domain>:<verb>`. Read scopes never grant writes.
 */

export const ALL_SCOPES = [
  'plants:read',
  'inverters:read',
  'soiling:read',
  'bess:read',
  'faults:read',
  'tickets:read',
  'kb:read',
  'diagnosis:run',
  'tickets:write',
  'cleaning:write',
  'reports:write',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

// Convenience preset shown in the admin UI.
export const READ_ONLY_SCOPES: Scope[] = [
  'plants:read',
  'inverters:read',
  'soiling:read',
  'bess:read',
  'faults:read',
  'tickets:read',
  'kb:read',
];

export const FULL_AGENT_SCOPES: Scope[] = [
  ...READ_ONLY_SCOPES,
  'diagnosis:run',
  'tickets:write',
  'cleaning:write',
  'reports:write',
];

export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required);
}

export function isValidScope(s: string): s is Scope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}
