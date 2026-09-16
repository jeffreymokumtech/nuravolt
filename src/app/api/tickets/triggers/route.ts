import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import {
  computeAlertHash,
  generateInterpretation,
} from '@/lib/ai/interpret-alert-core';
import { manualExcerptsFor } from '@/lib/alerts/manual-guidance';
import { pickInitialVariant } from '@/lib/ai/interpret-alert-prompts';
import { requireOrg } from '@/lib/api/tenant';
import { emitTicketEvent } from '@/lib/integrations/webhooks';
import { requireFeature } from '@/lib/billing/gate';
import type {
  CreateTicketFromTriggerRequest,
  TicketPriority,
  TicketTriggerType,
  SoilingForecastTriggerData,
  PerformanceAnomalyTriggerData,
  ThresholdAlertTriggerData,
  ScheduledMaintenanceTriggerData,
} from '@/types/tickets';
import type { AnomalyContext } from '@/types/llm';
import { modelLabel } from '@/lib/ai/bedrock';
import { enumsForModelId } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

// POST /api/tickets/triggers - Auto-create ticket from system trigger
export async function POST(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const body: CreateTicketFromTriggerRequest = await request.json();

    // Validate required fields
    if (!body.trigger_type || !body.trigger_id || !body.plant_id || !body.trigger_metadata) {
      return NextResponse.json(
        { error: 'Missing required fields: trigger_type, trigger_id, plant_id, trigger_metadata' },
        { status: 400 }
      );
    }

    // Verify plant exists
    const plant = await prisma.discoveredPlant.findUnique({
      where: { id: body.plant_id },
      select: { name: true },
    });

    if (!plant) {
      return NextResponse.json(
        { error: 'Plant not found' },
        { status: 404 }
      );
    }

    // Check for duplicate trigger (avoid creating multiple tickets for same trigger)
    const existingTicket = await prisma.ticket.findFirst({
      where: {
        org_clerk_id: authOrgId,
        trigger_type: body.trigger_type,
        trigger_id: body.trigger_id,
      },
    });

    if (existingTicket) {
      return NextResponse.json({
        message: 'Ticket already exists for this trigger',
        existing_ticket_id: existingTicket.id,
      }, { status: 200 });
    }

    // Generate title and description from trigger metadata
    const { title, description, priority, estimatedRevenue, estimatedEnergy } =
      generateTicketContent(body.trigger_type, body.trigger_metadata, plant.name);

    // Use auto-calculated priority or override
    const finalPriority = body.auto_priority === false
      ? ('MEDIUM' as TicketPriority)
      : priority;

    // Pre-allocate the prompt variant so we can store it on the ticket up-front
    // even if the LLM call is still in flight when we return the response.
    const presetVariant =
      body.trigger_type === 'PERFORMANCE_ANOMALY' ? pickInitialVariant() : null;

    // Create ticket
    const ticket = await prisma.ticket.create({
      data: {
        org_clerk_id: authOrgId,
        plant_id: body.plant_id,
        inverter_id: body.inverter_id,
        title,
        description,
        priority: finalPriority,
        trigger_type: body.trigger_type,
        trigger_id: body.trigger_id,
        trigger_metadata: body.trigger_metadata as Prisma.JsonValue,
        estimated_revenue_impact_eur: estimatedRevenue,
        estimated_energy_loss_kwh: estimatedEnergy,
        ai_prompt_variant: presetVariant,
        history: {
          create: {
            new_status: 'NEW',
            new_priority: finalPriority,
            changed_by_clerk_id: 'system',
            change_reason: `Auto-created from ${body.trigger_type}`,
          },
        },
      },
    });

    // Fire-and-forget: generate the LLM narration for PERFORMANCE_ANOMALY
    // triggers and write it back to the ticket. The trigger response does NOT
    // wait on Bedrock; the UI shows a skeleton until it appears. Plans without
    // the AI copilot skip narration entirely — the ticket itself is unaffected.
    if (body.trigger_type === 'PERFORMANCE_ANOMALY' && presetVariant) {
      if (!(await requireFeature(authOrgId, 'ai:copilot'))) {
        const anomalyData = body.trigger_metadata as unknown as PerformanceAnomalyTriggerData;
        void runNarrationInBackground({
          ticketId: ticket.id,
          plantId: body.plant_id,
          inverterId: body.inverter_id,
          triggerId: body.trigger_id,
          anomalyData,
          variant: presetVariant,
          authOrgId,
        });
      }
    }

    {
      const plant = await prisma.plant.findUnique({
        where: { id: body.plant_id },
        select: { slug: true, name: true },
      });
      await emitTicketEvent(authOrgId, 'ticket.created', {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        plant_slug: plant?.slug ?? null,
        plant_name: plant?.name ?? null,
        trigger_type: ticket.trigger_type,
        estimated_revenue_impact_eur: estimatedRevenue ?? null,
        url: `/dashboard/tickets/${ticket.id}`,
      });
    }

    return NextResponse.json({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      trigger_type: ticket.trigger_type,
      created_at: ticket.created_at.toISOString(),
      ai_prompt_variant: ticket.ai_prompt_variant,
      message: 'Ticket created from trigger',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating ticket from trigger:', error);
    return NextResponse.json(
      { error: 'Failed to create ticket from trigger' },
      { status: 500 }
    );
  }
}

interface NarrationJob {
  ticketId: string;
  plantId: string;
  inverterId?: string;
  triggerId: string;
  anomalyData: PerformanceAnomalyTriggerData;
  variant: import('@/lib/ai/interpret-alert-prompts').PromptVariant;
  authOrgId: string;
}

async function runNarrationInBackground(job: NarrationJob): Promise<void> {
  try {
    const context = mapPerformanceAnomalyToContext(job.anomalyData, job.inverterId);
    const manualExcerpts = await manualExcerptsFor({
      orgClerkId: job.authOrgId,
      plantId: job.plantId,
      kind: 'CRITICAL_FAULT',
      detail: context.fault_type ?? null,
    });
    const { interpretation, variant, usedFallback } = await generateInterpretation(
      context,
      undefined,
      { variant: job.variant, manualExcerpts }
    );

    const alertHash = computeAlertHash(context);

    await prisma.ticket.update({
      where: { id: job.ticketId },
      data: {
        ai_narration: interpretation as unknown as Prisma.InputJsonValue,
        ai_model_used: interpretation.llm_model,
        ai_generated_at: new Date(),
        ai_prompt_variant: variant,
        ai_interpretation_id: alertHash,
      },
    });

    await prisma.lLMInteraction.create({
      data: {
        org_clerk_id: job.authOrgId,
        provider: usedFallback ? 'MOCK' : llmEnums.provider,
        model: usedFallback ? 'GPT_4O_MINI' : llmEnums.model,
        interaction_type: 'TICKET_NARRATION',
        input_tokens: interpretation.input_tokens,
        output_tokens: interpretation.output_tokens,
        cost_usd: interpretation.llm_cost_usd,
        latency_ms: interpretation.llm_latency_ms,
        request_hash: alertHash,
        response_cached: false,
        plant_id: job.plantId,
        ticket_id: job.ticketId,
        alert_id: job.triggerId,
        success: true,
      },
    });
  } catch (err) {
    // Background job — log and move on. The UI re-fetches the ticket and will
    // see no narration; operator can hit "Regenerate" manually.
    console.error('[tickets/triggers] background narration failed:', err);
    await prisma.lLMInteraction
      .create({
        data: {
          org_clerk_id: job.authOrgId,
          provider: llmEnums.provider,
          model: llmEnums.model,
          interaction_type: 'TICKET_NARRATION',
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          latency_ms: 0,
          plant_id: job.plantId,
          ticket_id: job.ticketId,
          alert_id: job.triggerId,
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {
        // last-resort: swallow the logging failure
      });
  }
}

/**
 * Map a PERFORMANCE_ANOMALY trigger payload into the AnomalyContext shape
 * that the interpretation core expects.
 *
 * We synthesise a minimal `feature_contributions` from `metric_name` so the
 * fallback path's SHAP-style explanations work. Real ML pipelines that have
 * actual SHAP values should call the full interpret-alert route directly
 * with them; the ticket trigger only carries a deviation summary.
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

  // Anomaly score scaled from severity + deviation_pct.
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

  // Synthetic SHAP-style feature: the metric carrying the deviation.
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
    component_type: inverterId ? 'inverter' : 'inverter',
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

interface GeneratedContent {
  title: string;
  description: string;
  priority: TicketPriority;
  estimatedRevenue?: number;
  estimatedEnergy?: number;
}

function generateTicketContent(
  triggerType: TicketTriggerType,
  metadata: Record<string, unknown>,
  plantName?: string | null
): GeneratedContent {
  const plant = plantName || 'Unknown Plant';

  switch (triggerType) {
    case 'SOILING_FORECAST': {
      const data = metadata as unknown as SoilingForecastTriggerData;
      const lossPct = data.soiling_loss_pct || 0;

      return {
        title: `Soiling threshold exceeded - ${lossPct.toFixed(1)}% loss predicted`,
        description: `Soiling forecast for ${plant} indicates ${lossPct.toFixed(1)}% power loss expected on ${data.forecast_date}. ${
          data.cleaning_priority
            ? `Cleaning priority: ${data.cleaning_priority}`
            : ''
        }`,
        priority: calculateSoilingPriority(lossPct),
        estimatedRevenue: data.estimated_revenue_impact_eur,
        estimatedEnergy: data.estimated_energy_loss_kwh,
      };
    }

    case 'PERFORMANCE_ANOMALY': {
      const data = metadata as unknown as PerformanceAnomalyTriggerData;

      return {
        title: `Performance anomaly: ${data.anomaly_type}`,
        description: `${data.metric_name} deviation detected at ${plant}. Expected: ${data.expected_value}, Actual: ${data.actual_value} (${data.deviation_pct.toFixed(1)}% deviation)`,
        priority: mapSeverityToPriority(data.severity),
      };
    }

    case 'THRESHOLD_ALERT': {
      const data = metadata as unknown as ThresholdAlertTriggerData;

      return {
        title: `Threshold alert: ${data.threshold_name} exceeded`,
        description: `${data.alert_type} at ${plant}. Threshold: ${data.threshold_value}, Actual: ${data.actual_value}. ${
          data.duration_minutes
            ? `Duration: ${data.duration_minutes} minutes`
            : ''
        }`,
        priority: data.actual_value > data.threshold_value * 1.5 ? 'HIGH' : 'MEDIUM',
      };
    }

    case 'SCHEDULED_MAINTENANCE': {
      const data = metadata as unknown as ScheduledMaintenanceTriggerData;

      return {
        title: `Scheduled ${data.maintenance_type} - ${data.scheduled_date}`,
        description: `${data.maintenance_type.charAt(0).toUpperCase() + data.maintenance_type.slice(1)} scheduled for ${plant} on ${data.scheduled_date}. ${
          data.net_benefit_eur
            ? `Expected net benefit: €${data.net_benefit_eur.toFixed(2)}`
            : ''
        }`,
        priority: 'LOW',
        estimatedRevenue: data.revenue_recovered_eur,
        estimatedEnergy: data.energy_recovered_mwh ? data.energy_recovered_mwh * 1000 : undefined,
      };
    }

    default:
      return {
        title: `System alert - ${triggerType}`,
        description: `Auto-generated ticket for ${plant}`,
        priority: 'MEDIUM',
      };
  }
}

function calculateSoilingPriority(lossPct: number): TicketPriority {
  if (lossPct >= 5) return 'CRITICAL';
  if (lossPct >= 3) return 'HIGH';
  if (lossPct >= 1.5) return 'MEDIUM';
  return 'LOW';
}

function mapSeverityToPriority(severity: string): TicketPriority {
  switch (severity) {
    case 'critical': return 'CRITICAL';
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    case 'low': return 'LOW';
    default: return 'MEDIUM';
  }
}
