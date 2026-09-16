import prisma from '@/libs/prisma';
import type { LLMInteractionType, LLMModel, LLMProvider } from '@/types/llm';

/**
 * Model-keyed LLM pricing + enum mapping. Single source of truth for what a
 * Bedrock call actually cost — before this existed, every LLMInteraction row
 * was priced (and labeled) as Claude Haiku 4.5 even though the live model is
 * Qwen, so recorded spend overstated reality ~6x and checkLLMBudget enforced
 * against fiction.
 *
 * Rates are USD per 1M tokens (Bedrock on-demand, eu-west-1). Update when AWS
 * publishes new rates.
 */

interface ModelPricing {
  /** Substring matched against the Bedrock model id (lowercased). */
  match: string;
  inPer1M: number;
  outPer1M: number;
  provider: LLMProvider;
  model: LLMModel;
}

const PRICING: ModelPricing[] = [
  // Live default (BEDROCK_MODEL_ID): qwen.qwen3-next-80b-a3b
  { match: 'qwen', inPer1M: 0.15, outPer1M: 1.2, provider: 'BEDROCK_QWEN', model: 'QWEN3_NEXT_80B' },
  // Kept for history / if the model is ever switched back.
  { match: 'haiku-4-5', inPer1M: 1.0, outPer1M: 5.0, provider: 'BEDROCK_ANTHROPIC', model: 'CLAUDE_HAIKU_4_5' },
  { match: 'anthropic', inPer1M: 1.0, outPer1M: 5.0, provider: 'BEDROCK_ANTHROPIC', model: 'CLAUDE_HAIKU_4_5' },
];

/** Conservative default for unknown ids: price as the most expensive row. */
const FALLBACK: ModelPricing = PRICING[1];

function rowFor(modelId: string): ModelPricing {
  const id = (modelId || '').toLowerCase();
  return PRICING.find((p) => id.includes(p.match)) ?? FALLBACK;
}

export function estimateLLMCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = rowFor(modelId);
  return (inputTokens / 1_000_000) * p.inPer1M + (outputTokens / 1_000_000) * p.outPer1M;
}

/** Prisma enum values for the given Bedrock model id. */
export function enumsForModelId(modelId: string): { provider: LLMProvider; model: LLMModel } {
  const p = rowFor(modelId);
  return { provider: p.provider, model: p.model };
}

/**
 * Fire-and-forget spend row for call sites that previously logged nothing
 * (insights, briefings, diagnosis). Never throws — cost logging must not
 * break the feature. Token counts may be estimates (len/4) when the caller
 * couldn't get real usage from the response payload.
 */
export function recordLLMInteraction(args: {
  orgClerkId?: string | null;
  userClerkId?: string | null;
  plantId?: string | null;
  modelId: string;
  interactionType: LLMInteractionType | 'TICKET_NARRATION';
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  success?: boolean;
}): void {
  const { provider, model } = enumsForModelId(args.modelId);
  void prisma.lLMInteraction
    .create({
      data: {
        org_clerk_id: args.orgClerkId ?? null,
        user_clerk_id: args.userClerkId ?? null,
        plant_id: args.plantId ?? null,
        provider,
        model,
        interaction_type: args.interactionType,
        input_tokens: Math.max(0, Math.round(args.inputTokens)),
        output_tokens: Math.max(0, Math.round(args.outputTokens)),
        cost_usd: estimateLLMCostUsd(args.modelId, args.inputTokens, args.outputTokens),
        latency_ms: Math.max(0, Math.round(args.latencyMs ?? 0)),
        success: args.success ?? true,
      },
    })
    .catch(() => {});
}
