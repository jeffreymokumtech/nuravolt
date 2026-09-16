import { getChatIds } from '@/lib/ai/chat-auth';
import { getChatAccessContext } from '@/lib/ai/access-control';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';

export async function GET() {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  const ctx = await getChatAccessContext(userId, orgId);
  return Response.json({
    plants: ctx.plants.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      asset_type: p.asset_type,
    })),
  });
}
