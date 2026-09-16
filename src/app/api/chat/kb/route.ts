import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';

export async function GET() {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  // Org docs plus the globally seeded manuals (org_clerk_id null) — global
  // docs are searchable by every org via searchKB, so the drawer must show
  // them too (marked shared, delete stays org-only).
  const docs = await prisma.kBDocument.findMany({
    where: { OR: [{ org_clerk_id: orgId }, { org_clerk_id: null }] },
    orderBy: { created_at: 'desc' },
    take: 100,
    select: {
      id: true,
      org_clerk_id: true,
      title: true,
      file_name: true,
      file_type: true,
      file_size_bytes: true,
      chunk_count: true,
      processing_status: true,
      processing_error: true,
      plant_id: true,
      equipment_type: true,
      manufacturer: true,
      model_number: true,
      created_at: true,
    },
  });

  return Response.json({
    documents: docs.map(({ org_clerk_id, ...d }) => ({
      ...d,
      shared: org_clerk_id === null,
    })),
  });
}
