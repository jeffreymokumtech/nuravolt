/**
 * Canonical multi-tenancy helpers for API routes.
 *
 * Every org-scoped route starts with `requireOrg()`; every plant-scoped route
 * follows with `requirePlantAccess()`. Handles the dual org-id scheme:
 *  - `authOrgId` — the Better Auth organization id. Sessions, Subscription,
 *    UserRole, PlantAccess, ApiKey and tickets key off this (stored in the
 *    legacy `clerk_org_id` / `org_clerk_id` columns).
 *  - `org.id` — the internal Organization uuid. Plant.organization_id and
 *    DataConnection.organization_id reference this.
 *
 * Dev keeps the demo fallback from getChatIds() (demo_user / demo_org_alpha1)
 * so /demo and local API exploration work without a session; in production
 * an absent session is a hard 401.
 */

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import type { Organization, Plant, PlantAccessLevel, Role } from '@prisma/client';
import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { getOrCreateOrganization, getUserRoleInOrganization } from '@/lib/organizations';

export interface OrgContext {
  userId: string;
  /** Better Auth organization id (legacy columns call it clerk_org_id). */
  authOrgId: string;
  /** Legacy Organization row; `org.id` is what Plant.organization_id references. */
  org: Organization;
  role: Role | null;
  /** True when running on the dev demo fallback identity. */
  isDemo: boolean;
}

export type OrgResult =
  | { ok: true; ctx: OrgContext }
  | { ok: false; response: NextResponse };

export type PlantResult =
  | { ok: true; plant: Plant }
  | { ok: false; response: NextResponse };

const LEVEL_ORDER: Record<PlantAccessLevel, number> = {
  VIEW: 0,
  OPERATE: 1,
  MANAGE: 2,
};

/** Roles that get org-wide MANAGE access to every plant (mirrors organizations.ts). */
const ORG_WIDE_ROLES: Role[] = ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as Role[];

/** True when the request carries the internal tool-layer service secret. */
function isInternalToolRequest(): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;
  try {
    return headers().get('x-internal-chat-tool') === secret;
  } catch {
    return false; // outside a request scope (build time)
  }
}

/** Caller owns the connection; demo identity may also see legacy demo rows. */
export function ownsConnection(
  ctx: OrgContext,
  connection: { organization_id: string | null; customer_id: string },
): boolean {
  return (
    connection.organization_id === ctx.org.id ||
    (ctx.isDemo && connection.customer_id === 'demo_customer')
  );
}

/**
 * True when the caller's org role grants org-wide management. Connection CRUD
 * and other org-level settings must check this — plain members (OPERATOR /
 * VIEWER, e.g. a shared demo login) are org members but must not be able to
 * create, reconfigure, or delete data connections.
 */
export function hasOrgManageRole(ctx: OrgContext): boolean {
  return ctx.isDemo || (ctx.role != null && ORG_WIDE_ROLES.includes(ctx.role));
}

export function unauthorized(reason = 'unauthorized'): NextResponse {
  return NextResponse.json({ error: reason }, { status: 401 });
}

export function forbidden(reason = 'forbidden'): NextResponse {
  return NextResponse.json({ error: reason }, { status: 403 });
}

export function notFound(reason = 'not_found'): NextResponse {
  return NextResponse.json({ error: reason }, { status: 404 });
}

/**
 * Resolve the caller's org context from the session. 401s when there is no
 * session (or no active organization) outside dev.
 */
export async function requireOrg(): Promise<OrgResult> {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return { ok: false, response: unauthorized() };
  }

  const isDemo = orgId.startsWith('demo_');
  const org = await getOrCreateOrganization(orgId);
  const role = isDemo ? null : await getUserRoleInOrganization(userId, orgId);

  return { ok: true, ctx: { userId, authOrgId: orgId, org, role, isDemo } };
}

/**
 * Resolve a plant by uuid or slug and verify the caller may access it at the
 * requested level.
 *
 * Rules:
 *  - The plant must belong to the caller's org. Unaffiliated plants
 *    (organization_id = null, demo/showcase data) are visible in dev only.
 *  - SUPER_ADMIN / ORG_ADMIN / MANAGER get MANAGE on all org plants.
 *  - Other roles need a live PlantAccess row at >= the requested level.
 *  - Cross-tenant lookups return 404 (not 403) to avoid existence leaks.
 */
export async function requirePlantAccess(
  ctx: OrgContext,
  plantIdOrSlug: string,
  level: PlantAccessLevel = 'VIEW',
): Promise<PlantResult> {
  const plant = await prisma.plant.findFirst({
    where: { OR: [{ id: plantIdOrSlug }, { slug: plantIdOrSlug }] },
  });
  if (!plant) {
    return { ok: false, response: notFound('plant_not_found') };
  }

  const isDev = process.env.NODE_ENV === 'development';

  // Org ownership. Unaffiliated (null-org) plants are dev-only conveniences.
  if (plant.organization_id !== ctx.org.id) {
    if (!(isDev && plant.organization_id === null)) {
      return { ok: false, response: notFound('plant_not_found') };
    }
  }

  // Demo identity in dev gets full access to whatever it can see.
  if (ctx.isDemo) {
    return { ok: true, plant };
  }

  // Org-wide roles bypass per-plant grants.
  if (ctx.role && ORG_WIDE_ROLES.includes(ctx.role)) {
    return { ok: true, plant };
  }

  const access = await prisma.plantAccess.findUnique({
    where: {
      user_clerk_id_plant_id: {
        user_clerk_id: ctx.userId,
        plant_id: plant.id,
      },
    },
  });
  const live =
    access && (!access.expires_at || access.expires_at.getTime() > Date.now());
  if (!live || LEVEL_ORDER[access!.access_level] < LEVEL_ORDER[level]) {
    return { ok: false, response: forbidden('insufficient_plant_access') };
  }

  return { ok: true, plant };
}

/**
 * True when static-JSON demo fallbacks may serve data for this caller.
 * Production customers must see honest empty states, never demo plants.
 */
export function allowDemoData(ctx: OrgContext): boolean {
  return process.env.NODE_ENV === 'development' || ctx.isDemo;
}

export type PlantReadResult =
  /** Demo / unaffiliated plant (or static-JSON-only id): publicly readable. */
  | { ok: true; access: 'public'; plant: Plant | null }
  /** Org-owned plant, caller authorized. */
  | { ok: true; access: 'org'; plant: Plant; ctx: OrgContext }
  | { ok: false; response: NextResponse };

/**
 * Access rule for plant-scoped READ (analytics) routes, shared by the
 * public marketing showcase and the authenticated app:
 *
 *  - Plant ids that don't resolve in the DB are demo/static-JSON territory
 *    (customer plants always exist in the DB) → public; the route may serve
 *    its static fallback.
 *  - Plants with no organization, or belonging to a demo org, are showcase
 *    content → public.
 *  - Org-owned plants require a session, org match and PlantAccess >= VIEW.
 *
 * Writes must never use this — use requireOrg + requirePlantAccess.
 */
export async function resolvePlantForRead(
  plantIdOrSlug: string,
): Promise<PlantReadResult> {
  const plant = await prisma.plant.findFirst({
    where: { OR: [{ id: plantIdOrSlug }, { slug: plantIdOrSlug }] },
    include: { organization: { select: { clerk_org_id: true } } },
  });

  if (!plant || !plant.organization_id || plant.organization?.clerk_org_id?.startsWith('demo_')) {
    const { organization: _org, ...plainPlant } = (plant ?? {}) as Plant & {
      organization?: unknown;
    };
    return { ok: true, access: 'public', plant: plant ? (plainPlant as Plant) : null };
  }

  // Internal tool-layer fetches (AI chat / MCP tools) already authorize the
  // caller against ChatAccessContext.allowedPlantIds before hitting these
  // routes, but they can't carry a browser session. They authenticate with
  // the INTERNAL_API_SECRET header instead (never issued to clients).
  if (isInternalToolRequest()) {
    const { organization: _org, ...plainPlant } = plant as Plant & { organization?: unknown };
    return { ok: true, access: 'public', plant: plainPlant as Plant };
  }

  const orgResult = await requireOrg();
  if (!orgResult.ok) return { ok: false, response: orgResult.response };

  const access = await requirePlantAccess(orgResult.ctx, plant.id, 'VIEW');
  if (!access.ok) return { ok: false, response: access.response };

  return { ok: true, access: 'org', plant: access.plant, ctx: orgResult.ctx };
}
