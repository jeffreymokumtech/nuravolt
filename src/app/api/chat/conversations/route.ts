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

  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        user_clerk_id: userId,
        org_clerk_id: orgId,
        archived: false,
      },
      orderBy: [{ pinned: 'desc' }, { updated_at: 'desc' }],
      take: 50,
      select: {
        id: true,
        title: true,
        plant_id: true,
        pinned: true,
        updated_at: true,
      },
    });
    return Response.json({ conversations });
  } catch (e) {
    console.warn('[chat] list conversations failed (migration pending?):', e);
    return Response.json({ conversations: [] });
  }
}

export async function POST(request: Request) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  let body: { plantId?: string | null; title?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const conv = await prisma.conversation.create({
    data: {
      org_clerk_id: orgId,
      user_clerk_id: userId,
      plant_id: body.plantId ?? null,
      title: body.title ?? 'New conversation',
    },
  });

  return Response.json({ conversation: conv }, { status: 201 });
}
