import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';
import { requireFeature } from '@/lib/billing/gate';
import {
  computeAlertHash,
  generateInterpretation,
} from '@/lib/ai/interpret-alert-core';
import type {
  InterpretAlertRequest,
  InterpretAlertResponse,
  InterpretedAlert,
  AlertUrgency,
  AlertConfidence,
} from '@/types/llm';
import { modelLabel } from '@/lib/ai/bedrock';
import { enumsForModelId } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

/**
 * POST /api/llm/interpret-alert
 *
 * Interprets an ML anomaly output into human-readable explanation. The core
 * generation logic lives in src/lib/ai/interpret-alert-core.ts so other routes
 * (notably ticket creation/regeneration) can call it in-process. This route is
 * the public HTTP surface that also handles caching, persistence, and usage
 * tracking.
 *
 * Flow:
 *  1. Check AlertInterpretation cache (24h TTL keyed by SHAP-derived hash)
 *  2. Otherwise call generateInterpretation() — Bedrock first, rule-based fallback
 *  3. Persist to cache and log to LLMInteraction
 */
export async function POST(request: NextRequest) {
  try {
    // Tenancy: session required — every uncached call costs Bedrock money.
    // The org is taken from the session, never from the request body.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const gate = await requireFeature(orgResult.ctx.authOrgId, 'ai:copilot');
    if (gate) return gate;
    const llmBudget = await checkLLMBudget(orgResult.ctx.authOrgId);
    if (!llmBudget.ok) {
      return NextResponse.json(llmBudgetError(llmBudget), { status: 429 });
    }
    const { ctx } = orgResult;
    const orgClerkId = ctx.authOrgId;

    const body: InterpretAlertRequest = await request.json();

    if (!body.plant_id || !body.alert_type || !body.context) {
      return NextResponse.json(
        { error: 'Missing required fields: plant_id, alert_type, context' },
        { status: 400 }
      );
    }

    const alertHash = computeAlertHash(body.context);

    const cached = await prisma.alertInterpretation.findUnique({
      where: { alert_hash: alertHash },
    });

    // Only serve a cache hit that belongs to the caller's org.
    if (
      cached &&
      cached.org_clerk_id === orgClerkId &&
      cached.cache_expires_at &&
      cached.cache_expires_at > new Date()
    ) {
      const interpretation: InterpretedAlert = {
        summary: cached.summary,
        explanation: cached.explanation,
        likely_cause: cached.likely_cause,
        recommended_action: cached.recommended_action,
        urgency: cached.urgency as AlertUrgency,
        confidence: cached.confidence as AlertConfidence,
        similar_past_events: cached.similar_event_ids,
        llm_model: cached.llm_model,
        llm_cost_usd: Number(cached.llm_cost_usd),
        llm_latency_ms: cached.llm_latency_ms,
        input_tokens: cached.input_tokens,
        output_tokens: cached.output_tokens,
        used_fallback: cached.used_fallback,
      };

      return NextResponse.json({
        interpretation,
        cache_hit: true,
      } as InterpretAlertResponse);
    }

    const { interpretation } = await generateInterpretation(
      body.context,
      body.historical_matches
    );

    const cacheExpiry = new Date();
    cacheExpiry.setHours(cacheExpiry.getHours() + 24);

    const stored = await prisma.alertInterpretation.upsert({
      where: { alert_hash: alertHash },
      update: {
        summary: interpretation.summary,
        explanation: interpretation.explanation,
        likely_cause: interpretation.likely_cause,
        recommended_action: interpretation.recommended_action,
        urgency: interpretation.urgency,
        confidence: interpretation.confidence,
        similar_event_ids: interpretation.similar_past_events,
        llm_model: interpretation.llm_model,
        llm_cost_usd: interpretation.llm_cost_usd,
        llm_latency_ms: interpretation.llm_latency_ms,
        input_tokens: interpretation.input_tokens,
        output_tokens: interpretation.output_tokens,
        used_fallback: interpretation.used_fallback,
        cache_expires_at: cacheExpiry,
      },
      create: {
        org_clerk_id: orgClerkId,
        plant_id: body.plant_id,
        inverter_id: body.inverter_id,
        alert_type: body.alert_type,
        alert_id: body.alert_id,
        alert_hash: alertHash,
        summary: interpretation.summary,
        explanation: interpretation.explanation,
        likely_cause: interpretation.likely_cause,
        recommended_action: interpretation.recommended_action,
        urgency: interpretation.urgency,
        confidence: interpretation.confidence,
        similar_event_ids: interpretation.similar_past_events,
        llm_model: interpretation.llm_model,
        llm_cost_usd: interpretation.llm_cost_usd,
        llm_latency_ms: interpretation.llm_latency_ms,
        input_tokens: interpretation.input_tokens,
        output_tokens: interpretation.output_tokens,
        used_fallback: interpretation.used_fallback,
        cache_hit: false,
        cache_expires_at: cacheExpiry,
      },
    });

    await prisma.lLMInteraction.create({
      data: {
        org_clerk_id: orgClerkId,
        provider: interpretation.used_fallback ? 'MOCK' : llmEnums.provider,
        model: interpretation.used_fallback ? 'GPT_4O_MINI' : llmEnums.model,
        interaction_type: 'ALERT_INTERPRETATION',
        input_tokens: interpretation.input_tokens,
        output_tokens: interpretation.output_tokens,
        cost_usd: interpretation.llm_cost_usd,
        latency_ms: interpretation.llm_latency_ms,
        request_hash: alertHash,
        response_cached: false,
        plant_id: body.plant_id,
        alert_id: body.alert_id,
        success: true,
      },
    });

    return NextResponse.json({
      interpretation,
      cache_hit: false,
      interaction_id: stored.id,
    } as InterpretAlertResponse);
  } catch (error) {
    console.error('Error interpreting alert:', error);
    return NextResponse.json(
      { error: 'Failed to interpret alert' },
      { status: 500 }
    );
  }
}
