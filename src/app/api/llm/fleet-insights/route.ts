import { NextRequest, NextResponse } from 'next/server';
import { getChatIds } from '@/lib/ai/chat-auth';
import { generateFleetInsights } from '@/lib/ai/briefings';
import { getChatAccessContext } from '@/lib/ai/access-control';
import { requireFeature } from '@/lib/billing/gate';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';

/**
 * GET /api/llm/fleet-insights
 *
 * Generates a portfolio-level weekly briefing across every plant the
 * caller's organization has access to. Cost: ~1 Bedrock call per
 * invocation. Intended to run weekly via a scheduled job; on-demand
 * calls from the dashboard also welcome.
 *
 * Phase K Polish #6.
 */
export async function GET(_req: NextRequest) {
  try {
    const { userId, orgId } = await getChatIds();
    const gate = await requireFeature(orgId, 'ai:insights');
    if (gate) return gate;
    const llmBudget = await checkLLMBudget(orgId);
    if (!llmBudget.ok) {
      return NextResponse.json(llmBudgetError(llmBudget), { status: 429 });
    }
    // Fall back to demo identifiers for unauthenticated callers (matches
    // the rest of the API where DEMO_CUSTOMER_ID is used). Real users
    // need both a session userId and an active orgId.
    const userClerkId = userId ?? 'demo_user';
    const orgClerkId = orgId ?? 'demo_org';

    const ctx = await getChatAccessContext(userClerkId, orgClerkId);
    const insights = await generateFleetInsights({ ctx });
    if (!insights) {
      return NextResponse.json(
        {
          error: 'no_insights',
          reason: 'No plants accessible or LLM call failed (check Bedrock auth + cost ceiling).',
        },
        { status: 404 }
      );
    }

    return NextResponse.json(insights);
  } catch (e: any) {
    console.error('[fleet-insights/route]', e);
    return NextResponse.json(
      { error: 'internal_error', message: e?.message ?? 'unknown' },
      { status: 500 }
    );
  }
}
