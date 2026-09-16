import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { getChatAccessContext, resolvePlantOrDeny } from '@/lib/ai/access-control';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ctx = await getChatAccessContext(userId, orgId);
  const plant = resolvePlantOrDeny(ctx, params.slug);
  if (!plant) {
    return Response.json({ error: 'Plant not found' }, { status: 404 });
  }

  const groups = await prisma.inverterGroup.findMany({
    where: { plant_id: plant.id },
    select: {
      id: true,
      name: true,
      inverters: {
        where: { enabled: true },
        select: { external_id: true, name: true, model: true },
        orderBy: { external_id: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  const inverters = groups.flatMap((g) =>
    g.inverters.map((inv) => ({
      id: inv.external_id,
      name: inv.name,
      group: g.name,
      model: inv.model,
    }))
  );

  return Response.json({
    plant: { id: plant.id, slug: plant.slug, name: plant.name },
    inverters,
  });
}
