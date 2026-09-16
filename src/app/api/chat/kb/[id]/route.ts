import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';

// GET /api/chat/kb/[id] — document metadata + ordered chunks for the viewer
// page. Readable when the doc belongs to the caller's org OR is a globally
// seeded manual (org_clerk_id null). Delete stays org-only below.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const doc = await prisma.kBDocument.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      org_clerk_id: true,
      title: true,
      file_name: true,
      file_type: true,
      chunk_count: true,
      equipment_type: true,
      manufacturer: true,
      model_number: true,
      created_at: true,
    },
  });
  if (!doc || (doc.org_clerk_id !== null && doc.org_clerk_id !== orgId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const chunks = await prisma.kBChunk.findMany({
    where: { document_id: doc.id },
    orderBy: { chunk_index: 'asc' },
    select: { chunk_index: true, content: true },
  });

  const { org_clerk_id, ...rest } = doc;
  return Response.json({
    document: { ...rest, shared: org_clerk_id === null },
    chunks,
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const doc = await prisma.kBDocument.findUnique({
    where: { id: params.id },
  });
  if (!doc || doc.org_clerk_id !== orgId) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // KBChunk has ON DELETE CASCADE — chunks go with the document.
  await prisma.kBDocument.delete({ where: { id: doc.id } });

  return Response.json({ ok: true });
}
