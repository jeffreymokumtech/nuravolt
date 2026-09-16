import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';

async function loadOwned(id: string, userId: string) {
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv || conv.user_clerk_id !== userId) return null;
  return conv;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const conv = await loadOwned(params.id, userId);
  if (!conv) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { conversation_id: conv.id },
    orderBy: { created_at: 'asc' },
  });

  return Response.json({ conversation: conv, messages });
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const conv = await loadOwned(params.id, userId);
  if (!conv) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const body = (await request.json()) as {
    title?: string;
    pinned?: boolean;
  };

  const updated = await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    },
  });

  return Response.json({ conversation: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { userId, orgId } = await getChatIds();
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const conv = await loadOwned(params.id, userId);
  if (!conv) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { archived: true },
  });

  return Response.json({ ok: true });
}
