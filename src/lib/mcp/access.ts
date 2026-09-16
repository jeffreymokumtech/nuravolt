import prisma from '@/libs/prisma';
import type { ChatAccessContext, AllowedPlant } from '@/lib/ai/access-control';
import type { McpAuthContext } from './auth';

/**
 * Build a ChatAccessContext from an authenticated MCP API key. An API key is
 * org-scoped, so it grants access to:
 *   - every Plant whose Organization.clerk_org_id matches the key's org
 *   - Plants with no organization_id (showcase / unaffiliated demo data)
 *
 * This is wider than the in-app chat (which goes through PlantAccess per
 * user), but matches the intent of an org-level service-account credential.
 * OAuth MCP tokens (Enterprise) don't use this path — they resolve through
 * getChatAccessContext, i.e. the caller's per-user PlantAccess ACL.
 */
export async function buildMcpAccessContext(
  auth: McpAuthContext,
): Promise<ChatAccessContext> {
  const plantSelect = {
    id: true,
    slug: true,
    name: true,
    asset_type: true,
    status: true,
    capacity_mw: true,
    location_name: true,
    country: true,
  } as const;

  const plantRows = await prisma.plant.findMany({
    where: {
      OR: [
        { organization_id: null },
        { organization: { clerk_org_id: auth.orgClerkId } },
      ],
    },
    select: plantSelect,
  });

  const plants: AllowedPlant[] = plantRows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    asset_type: String(p.asset_type),
    status: String(p.status),
    capacity_mw: p.capacity_mw ? Number(p.capacity_mw) : null,
    location_name: p.location_name,
    country: p.country,
  }));

  const allowedPlantIds = new Set<string>();
  for (const p of plants) {
    allowedPlantIds.add(p.id);
    allowedPlantIds.add(p.slug);
  }

  return {
    userClerkId: auth.userClerkId,
    orgClerkId: auth.orgClerkId,
    allowedPlantIds,
    plants,
  };
}
