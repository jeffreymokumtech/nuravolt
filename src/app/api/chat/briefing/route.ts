import { getChatIds } from '@/lib/ai/chat-auth';
import { getChatAccessContext } from '@/lib/ai/access-control';
import {
  generatePlantBriefing,
  generateInverterBriefing,
} from '@/lib/ai/briefings';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Plan gate: the AI copilot is Business+ only.
  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  // Org-level AI cost cap (OrgLLMBudget) — same check as /api/chat.
  const budget = await checkLLMBudget(orgId);
  if (!budget.ok) {
    return Response.json(llmBudgetError(budget), { status: 429 });
  }

  let body: { kind: 'plant' | 'inverter'; plantId: string; inverterId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.plantId) {
    return Response.json({ error: 'plantId required' }, { status: 400 });
  }

  const access = await getChatAccessContext(userId, orgId);

  try {
    if (body.kind === 'inverter') {
      if (!body.inverterId) {
        return Response.json(
          { error: 'inverterId required for inverter briefing' },
          { status: 400 }
        );
      }
      const briefing = await generateInverterBriefing({
        ctx: access,
        plantId: body.plantId,
        inverterId: body.inverterId,
      });
      if (!briefing) {
        return Response.json({ error: 'access_denied or generation failed' }, { status: 403 });
      }
      return Response.json({ briefing });
    }

    const briefing = await generatePlantBriefing({
      ctx: access,
      plantId: body.plantId,
    });
    if (!briefing) {
      return Response.json({ error: 'access_denied or generation failed' }, { status: 403 });
    }
    return Response.json({ briefing });
  } catch (e) {
    console.error('[briefing] failed:', e);
    return Response.json(
      { error: 'Briefing failed', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}
