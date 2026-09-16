import prisma from '@/libs/prisma';

/**
 * Who gets alert emails for a plant: the union of
 *   (a) org-wide managers — UserRole SUPER_ADMIN / ORG_ADMIN / MANAGER, and
 *   (b) members holding a live PlantAccess grant (any level) on the plant,
 * resolved to emails via the Better Auth member↔user join, deduped, capped.
 *
 * Never returns recipients for demo orgs (clerk_org_id LIKE 'demo_%').
 */

const ORG_WIDE_ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER'] as const;
const MAX_RECIPIENTS = 20;

export async function alertRecipients(
  orgClerkId: string,
  plantId: string,
): Promise<string[]> {
  if (!orgClerkId || orgClerkId.startsWith('demo_')) return [];

  const [roles, grants] = await Promise.all([
    prisma.userRole.findMany({
      where: { org_clerk_id: orgClerkId, role: { in: ORG_WIDE_ROLES as unknown as any } },
      select: { user_clerk_id: true },
    }),
    prisma.plantAccess.findMany({
      where: {
        org_clerk_id: orgClerkId,
        plant_id: plantId,
        OR: [{ expires_at: null }, { expires_at: { gte: new Date() } }],
      },
      select: { user_clerk_id: true },
    }),
  ]);

  const userIds = [
    ...new Set([...roles, ...grants].map((r) => r.user_clerk_id).filter(Boolean)),
  ];
  if (userIds.length === 0) return [];

  const members = await prisma.member.findMany({
    where: { organizationId: orgClerkId, userId: { in: userIds } },
    include: { user: { select: { email: true } } },
  });

  const emails = [
    ...new Set(
      members
        .map((m) => m.user?.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e))
    ),
  ];
  return emails.slice(0, MAX_RECIPIENTS);
}
