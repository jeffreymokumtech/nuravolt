import { NextRequest, NextResponse } from 'next/server';
import { invokeBedrockDetailed, modelLabel } from '@/lib/ai/bedrock';
import { recordLLMInteraction } from '@/lib/ai/llm-pricing';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';

/**
 * POST /api/llm/insights
 *
 * Generate AI-powered insights for a plant overview.
 * Backed by AWS Bedrock (BEDROCK_MODEL_ID, Qwen by default).
 */
export async function POST(request: NextRequest) {
  try {
    // Tenancy: session required — every call costs Bedrock money.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const gate = await requireFeature(orgResult.ctx.authOrgId, 'ai:insights');
    if (gate) return gate;
    const llmBudget = await checkLLMBudget(orgResult.ctx.authOrgId);
    if (!llmBudget.ok) {
      return NextResponse.json(llmBudgetError(llmBudget), { status: 429 });
    }

    const body = await request.json();
    const { plantId, plantData } = body;

    if (!plantId || !plantData) {
      return NextResponse.json(
        { error: 'Missing required fields: plantId, plantData' },
        { status: 400 }
      );
    }

    const prompt = `Analyze this solar PV plant snapshot for plant ${plantId}:

${JSON.stringify(plantData, null, 2)}

Return 3-4 bulleted observations covering:
- Performance: how soiling, losses, and health distribution compare to a healthy fleet
- Risks: anything trending the wrong direction or near a threshold
- Recommended actions: concrete operational steps (cleaning, ticket, inspection)

Keep total length under 200 words. Use plain text bullets (no markdown headers). Cite specific numeric values from the data when relevant.`;

    const startTime = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system:
        'You are a senior solar PV plant analyst. Be concise, technical, and never invent values that are not in the provided data.',
      maxTokens: 500,
      temperature: 0.3,
    });
    const insights = detailed.text;
    const latencyMs = Date.now() - startTime;

    // Spend row so checkLLMBudget sees this call (was previously unlogged).
    recordLLMInteraction({
      orgClerkId: orgResult.ctx.authOrgId,
      plantId,
      modelId: modelLabel(),
      interactionType: 'REPORT_GENERATION',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(insights.length / 4),
      latencyMs,
    });

    return NextResponse.json({
      insights,
      model: `${modelLabel()} (Bedrock)`,
      latency_ms: latencyMs,
      plant_id: plantId,
    });
  } catch (error) {
    console.error('Error generating insights:', error);
    return NextResponse.json(
      {
        error: 'Failed to generate insights',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
