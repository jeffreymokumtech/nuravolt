import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import {
  computeAlertHash,
  generateInterpretation,
} from '@/lib/ai/interpret-alert-core';
import { manualExcerptsFor } from '@/lib/alerts/manual-guidance';
import {
  nextVariant,
  type PromptVariant,
} from '@/lib/ai/interpret-alert-prompts';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import type { PerformanceAnomalyTriggerData } from '@/types/tickets';
import type { AnomalyContext } from '@/types/llm';
import { modelLabel } from '@/lib/ai/bedrock';
import { enumsForModelId } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

/** Hard cap on regenerations per ticket — bounds Bedrock cost. */
const MAX_REGENERATIONS = 5;

/**
 * POST /api/tickets/[ticketId]/narration/regenerate
 *
 * Cycle to the next prompt variant and re-draft the AI narration. Resets the
 * approval / edit state so the operator sees a fresh draft.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const gate = await requireFeature(authOrgId, 'ai:copilot');
    if (gate) return gate;

    const { ticketId } = await params;

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, org_clerk_id: authOrgId },
    });
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.ai_regeneration_count >= MAX_REGENERATIONS) {
      return NextResponse.json(
        {
          error: 'Regeneration limit reached',
          regeneration_count: ticket.ai_regeneration_count,
          limit: MAX_REGENERATIONS,
        },
        { status: 429 }
      );
    }

    // We can only re-narrate PERFORMANCE_ANOMALY tickets — that's the only
    // trigger type whose metadata maps cleanly into AnomalyContext. Other
    // trigger types don't currently have a narration pathway.
    if (ticket.trigger_type !== 'PERFORMANCE_ANOMALY') {
      return NextResponse.json(
        { error: 'Narration only supported for PERFORMANCE_ANOMALY tickets' },
        { status: 400 }
      );
    }

    const anomalyData = ticket.trigger_metadata as unknown as PerformanceAnomalyTriggerData;
    const context = mapPerformanceAnomalyToContext(
      anomalyData,
      ticket.inverter_id ?? undefined
    );

    const newVariant = nextVariant(ticket.ai_prompt_variant as PromptVariant | null);

    const manualExcerpts = await manualExcerptsFor({
      orgClerkId: authOrgId,
      plantId: ticket.plant_id,
      kind: 'CRITICAL_FAULT',
      detail: context.fault_type ?? null,
    });
    const { interpretation, variant, usedFallback } = await generateInterpretation(
      context,
      undefined,
      { variant: newVariant, manualExcerpts }
    );

    const alertHash = computeAlertHash(context);
    const now = new Date();

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        ai_narration: interpretation as unknown as Prisma.InputJsonValue,
        ai_model_used: interpretation.llm_model,
        ai_generated_at: now,
        ai_prompt_variant: variant,
        ai_interpretation_id: alertHash,
        ai_regeneration_count: { increment: 1 },
        // Reset operator state — fresh draft.
        ai_edited: false,
        ai_edited_narration: Prisma.DbNull,
        ai_approved_by_clerk_id: null,
        ai_approved_at: null,
      },
    });

    await Promise.all([
      prisma.lLMInteraction.create({
        data: {
          org_clerk_id: authOrgId,
          provider: usedFallback ? 'MOCK' : llmEnums.provider,
          model: usedFallback ? 'GPT_4O_MINI' : llmEnums.model,
          interaction_type: 'TICKET_NARRATION',
          input_tokens: interpretation.input_tokens,
          output_tokens: interpretation.output_tokens,
          cost_usd: interpretation.llm_cost_usd,
          latency_ms: interpretation.llm_latency_ms,
          request_hash: alertHash,
          response_cached: false,
          plant_id: ticket.plant_id,
          ticket_id: ticketId,
          success: true,
        },
      }),
      prisma.ticketHistory.create({
        data: {
          ticket_id: ticketId,
          new_status: ticket.status,
          changed_by_clerk_id: userId,
          change_reason: `AI narration regenerated (variant: ${variant}, attempt #${updated.ai_regeneration_count})`,
        },
      }),
    ]);

    return NextResponse.json({
      ticket_id: ticketId,
      ai_narration: interpretation,
      ai_prompt_variant: variant,
      ai_model_used: interpretation.llm_model,
      ai_generated_at: now.toISOString(),
      ai_regeneration_count: updated.ai_regeneration_count,
      remaining_regenerations: MAX_REGENERATIONS - updated.ai_regeneration_count,
    });
  } catch (error) {
    console.error('Error regenerating narration:', error);
    return NextResponse.json(
      { error: 'Failed to regenerate narration' },
      { status: 500 }
    );
  }
}

/**
 * Same mapping used in /api/tickets/triggers POST. Kept inline here to avoid
 * a cross-file dependency for a small synth function — but if a third caller
 * appears, lift it into `src/lib/tickets/anomaly-context.ts`.
 */
function mapPerformanceAnomalyToContext(
  data: PerformanceAnomalyTriggerData,
  inverterId?: string
): AnomalyContext {
  const severityMap: Record<
    PerformanceAnomalyTriggerData['severity'],
    AnomalyContext['severity']
  > = {
    low: 'info',
    medium: 'warning',
    high: 'warning',
    critical: 'critical',
  };

  const severityWeight =
    data.severity === 'critical'
      ? 0.95
      : data.severity === 'high'
        ? 0.8
        : data.severity === 'medium'
          ? 0.6
          : 0.4;
  const deviationWeight = Math.min(Math.abs(data.deviation_pct) / 100, 1);
  const anomalyScore = Math.min(severityWeight * 0.7 + deviationWeight * 0.3, 1);

  const featureKey = data.metric_name.toLowerCase().replace(/\s+/g, '_');
  const featureContribution =
    data.expected_value !== 0
      ? (data.actual_value - data.expected_value) / Math.abs(data.expected_value)
      : Math.sign(data.actual_value - data.expected_value) * 1;

  return {
    anomaly_score: anomalyScore,
    is_anomaly: true,
    severity: severityMap[data.severity] ?? 'warning',
    confidence: 0.7,
    component_id: inverterId ?? 'plant',
    component_type: 'inverter',
    fault_type: `performance_anomaly:${featureKey}`,
    display_name: `${data.metric_name} deviation`,
    feature_contributions: {
      [featureKey]: featureContribution,
    },
    expected_value: data.expected_value,
    actual_value: data.actual_value,
    deviation_percent: data.deviation_pct,
  };
}
