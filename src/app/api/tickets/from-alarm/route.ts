import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import {
  buildTicketCreatePayload,
  type PredictiveAlarm,
} from '@/lib/tickets/createFromAlarm';
import {
  computeAlertHash,
  generateInterpretation,
} from '@/lib/ai/interpret-alert-core';
import { manualExcerptsFor } from '@/lib/alerts/manual-guidance';
import { emitTicketEvent } from '@/lib/integrations/webhooks';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import type { AnomalyContext } from '@/types/llm';
import type { PerformanceAnomalyTriggerData } from '@/types/tickets';
import { modelLabel } from '@/lib/ai/bedrock';
import { enumsForModelId } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

/**
 * POST /api/tickets/from-alarm
 *
 * Idempotent ticket creation from a predictive-fault alarm row. Body:
 *   { plantId: string, alarm: PredictiveAlarm }
 *
 * Behaviour:
 *   1. Look up existing ticket where (plant_id, trigger_id) match. If found,
 *      return its id with `isNew: false` — the caller routes to the detail.
 *   2. Otherwise create one with trigger_type PERFORMANCE_ANOMALY so the
 *      existing AIAnalysisCard fires.
 *   3. Fire-and-forget Bedrock narration so the page can navigate without
 *      waiting on the LLM. Cache hits (same alert_hash) cost nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const body = (await request.json()) as { plantId: string; alarm: PredictiveAlarm };
    const { plantId, alarm } = body;

    if (!plantId || !alarm?.id) {
      return NextResponse.json(
        { error: 'Missing plantId or alarm.id' },
        { status: 400 }
      );
    }

    // Caller may pass either a Plant.id (UUID) or Plant.slug. Resolve to id.
    const resolvedPlantId = await resolvePlantId(plantId);

    const existing = await prisma.ticket.findFirst({
      where: {
        org_clerk_id: authOrgId,
        plant_id: resolvedPlantId,
        trigger_id: alarm.id,
      },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ ticketId: existing.id, isNew: false });
    }

    const payload = buildTicketCreatePayload({ plantId: resolvedPlantId, alarm });

    const ticket = await prisma.ticket.create({
      data: {
        org_clerk_id: authOrgId,
        plant_id: payload.plant_id,
        inverter_id: payload.inverter_id,
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
        trigger_type: payload.trigger_type,
        trigger_id: payload.trigger_id,
        trigger_metadata: payload.trigger_metadata as unknown as Prisma.InputJsonValue,
        estimated_revenue_impact_eur: payload.estimated_revenue_impact_eur,
        estimated_energy_loss_kwh: payload.estimated_energy_loss_kwh,
        history: {
          create: {
            new_status: 'NEW',
            new_priority: payload.priority,
            changed_by_clerk_id: userId,
            change_reason: `Ticket created from predictive alarm ${alarm.id}`,
          },
        },
      },
      select: { id: true, plant_id: true, inverter_id: true, trigger_metadata: true },
    });

    // Fire-and-forget Bedrock narration. Errors are logged but never block
    // the response — the AIAnalysisCard handles the "narration loading" /
    // "narration failed, retry" states already. Plans without the AI copilot
    // skip narration entirely — the ticket itself is unaffected.
    if (!(await requireFeature(authOrgId, 'ai:copilot'))) {
      fireNarrationInBackground({
        ticketId: ticket.id,
        plantId: ticket.plant_id,
        inverterId: ticket.inverter_id,
        triggerMetadata: payload.trigger_metadata,
        authOrgId,
      }).catch((err) => {
        console.error(`Narration background generation failed for ${ticket.id}:`, err);
      });
    }

    {
      const plant = await prisma.plant.findUnique({
        where: { id: ticket.plant_id },
        select: { slug: true, name: true },
      });
      await emitTicketEvent(authOrgId, 'ticket.created', {
        id: ticket.id,
        title: payload.title,
        status: 'NEW',
        priority: payload.priority,
        plant_slug: plant?.slug ?? null,
        plant_name: plant?.name ?? null,
        trigger_type: payload.trigger_type,
        estimated_revenue_impact_eur: payload.estimated_revenue_impact_eur ?? null,
        url: `/dashboard/tickets/${ticket.id}`,
      });
    }

    return NextResponse.json({ ticketId: ticket.id, isNew: true }, { status: 201 });
  } catch (error) {
    console.error('Error creating ticket from alarm:', error);
    return NextResponse.json(
      { error: 'Failed to create ticket from alarm' },
      { status: 500 }
    );
  }
}

/**
 * Resolve either a Plant.id (UUID) or Plant.slug to the canonical Plant.id.
 * Falls back to the input string if no Plant row matches — supports demo
 * plants that exist only as on-disk fixtures.
 */
async function resolvePlantId(input: string): Promise<string> {
  const plant = await prisma.plant.findFirst({
    where: { OR: [{ id: input }, { slug: input }] },
    select: { id: true },
  });
  return plant?.id ?? input;
}

interface NarrationArgs {
  ticketId: string;
  plantId: string;
  inverterId: string | null;
  triggerMetadata: PerformanceAnomalyTriggerData & {
    fault_type: string;
    equipment_id: string;
    days_to_fault: number;
  };
  authOrgId: string;
}

async function fireNarrationInBackground({
  ticketId,
  plantId,
  inverterId,
  triggerMetadata,
  authOrgId,
}: NarrationArgs) {
  const context = mapToAnomalyContext(triggerMetadata, inverterId ?? undefined);
  const manualExcerpts = await manualExcerptsFor({
    orgClerkId: authOrgId,
    plantId,
    kind: 'CRITICAL_FAULT',
    detail: triggerMetadata.fault_type ?? null,
  });
  const { interpretation, variant, usedFallback } = await generateInterpretation(
    context,
    undefined,
    { variant: 'v1', manualExcerpts }
  );
  const alertHash = computeAlertHash(context);
  const now = new Date();

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      ai_narration: interpretation as unknown as Prisma.InputJsonValue,
      ai_model_used: interpretation.llm_model,
      ai_generated_at: now,
      ai_prompt_variant: variant,
      ai_interpretation_id: alertHash,
    },
  });

  await prisma.lLMInteraction.create({
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
      plant_id: plantId,
      ticket_id: ticketId,
      success: true,
    },
  });
}

function mapToAnomalyContext(
  data: PerformanceAnomalyTriggerData & { fault_type: string; equipment_id: string },
  inverterId?: string
): AnomalyContext {
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

  const severityMap: Record<
    PerformanceAnomalyTriggerData['severity'],
    AnomalyContext['severity']
  > = {
    low: 'info',
    medium: 'warning',
    high: 'warning',
    critical: 'critical',
  };

  const featureKey = data.fault_type.toLowerCase().replace(/\s+/g, '_');
  const featureContribution =
    data.expected_value !== 0
      ? (data.actual_value - data.expected_value) / Math.abs(data.expected_value)
      : Math.sign(data.actual_value - data.expected_value) * 1;

  return {
    anomaly_score: anomalyScore,
    is_anomaly: true,
    severity: severityMap[data.severity] ?? 'warning',
    confidence: 0.75,
    component_id: inverterId ?? data.equipment_id,
    component_type: 'inverter',
    fault_type: data.fault_type,
    display_name: data.metric_name,
    feature_contributions: { [featureKey]: featureContribution },
    expected_value: data.expected_value,
    actual_value: data.actual_value,
    deviation_percent: data.deviation_pct,
  };
}
