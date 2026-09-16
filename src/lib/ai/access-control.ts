import prisma from '@/libs/prisma';

export interface AllowedPlant {
  id: string;
  slug: string;
  name: string;
  asset_type: string;
  status: string;
  capacity_mw: number | null;
  location_name: string | null;
  country: string | null;
}

export interface ChatAccessContext {
  userClerkId: string;
  orgClerkId: string;
  /** UUIDs and slugs the LLM may reference (cached for the request). */
  allowedPlantIds: Set<string>;
  /** Resolved plants for tool responses. */
  plants: AllowedPlant[];
}

/**
 * Resolves plants the user has access to in the current org via PlantAccess
 * (excluding expired grants). The chat layer treats id and slug as equivalent
 * keys — both are added to allowedPlantIds so any tool can validate either.
 */
export async function getChatAccessContext(
  userClerkId: string,
  orgClerkId: string
): Promise<ChatAccessContext> {
  const now = new Date();
  const isDemoUser = userClerkId === 'demo_user';

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

  // Demo / dev user: bypass PlantAccess and grant read access to every plant
  // in the DB. This matches the intent of the public /showcase + /demo
  // surfaces, which are meant to be browseable without per-user grants.
  // Real Clerk users go through the PlantAccess ACL.
  let plantRows: Array<{
    id: string;
    slug: string;
    name: string;
    asset_type: string;
    status: string;
    capacity_mw: any;
    location_name: string | null;
    country: string | null;
  }>;

  if (isDemoUser) {
    plantRows = (await prisma.plant.findMany({ select: plantSelect })) as any;
  } else {
    // Org-wide roles (SUPER_ADMIN / ORG_ADMIN / MANAGER) see every plant in
    // their org — same rule as requirePlantAccess in src/lib/api/tenant.ts.
    // Everyone else goes through per-plant PlantAccess grants.
    const userRole = await prisma.userRole.findUnique({
      where: {
        user_clerk_id_org_clerk_id: {
          user_clerk_id: userClerkId,
          org_clerk_id: orgClerkId,
        },
      },
    });
    const orgWide =
      userRole && ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'].includes(userRole.role);

    if (orgWide) {
      plantRows = (await prisma.plant.findMany({
        where: { organization: { clerk_org_id: orgClerkId } },
        select: plantSelect,
      })) as any;
    } else {
      const grants = await prisma.plantAccess.findMany({
        where: {
          user_clerk_id: userClerkId,
          org_clerk_id: orgClerkId,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        include: { plant: { select: plantSelect } },
      });
      plantRows = grants
        .filter((g) => g.plant)
        .map((g) => g.plant!) as any;
    }
  }

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

  return { userClerkId, orgClerkId, allowedPlantIds, plants };
}

/**
 * Resolve a free-form plant key (UUID or slug) to a plant the user has access
 * to. Returns null when access is denied.
 */
export function resolvePlantOrDeny(
  ctx: ChatAccessContext,
  plantKey: string
): AllowedPlant | null {
  if (!plantKey) return null;
  if (!ctx.allowedPlantIds.has(plantKey)) return null;
  return (
    ctx.plants.find((p) => p.id === plantKey || p.slug === plantKey) ?? null
  );
}
