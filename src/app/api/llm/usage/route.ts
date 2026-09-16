import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import type { LLMUsageStats, LLMUsageRequest, LLMInteractionType, LLMModel } from '@/types/llm';

/**
 * GET /api/llm/usage
 *
 * Get LLM usage statistics for cost monitoring. Scoped to the session's org;
 * the legacy org_clerk_id query param is ignored.
 *
 * Query params:
 * - period_type: 'daily' | 'weekly' | 'monthly' (default: 'daily')
 * - period_start: ISO date string (default: start of current period)
 */
export async function GET(request: NextRequest) {
  try {
    // Tenancy: usage/cost data is org data — org comes from the session.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const orgClerkId = orgResult.ctx.authOrgId;

    const searchParams = request.nextUrl.searchParams;

    const periodType = (searchParams.get('period_type') || 'daily') as 'daily' | 'weekly' | 'monthly';

    // Calculate period bounds
    const { periodStart, periodEnd } = calculatePeriodBounds(
      periodType,
      searchParams.get('period_start') || undefined
    );

    // Get aggregated usage from LLMInteraction table
    const interactions = await prisma.lLMInteraction.findMany({
      where: {
        org_clerk_id: orgClerkId,
        created_at: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      select: {
        interaction_type: true,
        model: true,
        input_tokens: true,
        output_tokens: true,
        cost_usd: true,
        response_cached: true,
        success: true,
      },
    });

    // Aggregate by interaction type
    const byInteractionType: Record<string, { requests: number; tokens: number; cost_usd: number }> = {};
    const byModel: Record<string, { requests: number; cost_usd: number }> = {};

    let totalRequests = 0;
    let cachedRequests = 0;
    let failedRequests = 0;
    let totalCost = 0;

    for (const interaction of interactions) {
      totalRequests++;
      totalCost += Number(interaction.cost_usd);

      if (interaction.response_cached) {
        cachedRequests++;
      }

      if (!interaction.success) {
        failedRequests++;
      }

      // By interaction type
      const type = interaction.interaction_type;
      if (!byInteractionType[type]) {
        byInteractionType[type] = { requests: 0, tokens: 0, cost_usd: 0 };
      }
      byInteractionType[type].requests++;
      byInteractionType[type].tokens += interaction.input_tokens + interaction.output_tokens;
      byInteractionType[type].cost_usd += Number(interaction.cost_usd);

      // By model
      const model = interaction.model;
      if (!byModel[model]) {
        byModel[model] = { requests: 0, cost_usd: 0 };
      }
      byModel[model].requests++;
      byModel[model].cost_usd += Number(interaction.cost_usd);
    }

    // Format response
    const stats: LLMUsageStats = {
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      total_requests: totalRequests,
      cached_requests: cachedRequests,
      failed_requests: failedRequests,
      total_cost_usd: Math.round(totalCost * 1000000) / 1000000, // Round to 6 decimal places
      by_interaction_type: Object.entries(byInteractionType).map(([type, data]) => ({
        type: type as LLMInteractionType,
        requests: data.requests,
        tokens: data.tokens,
        cost_usd: Math.round(data.cost_usd * 1000000) / 1000000,
      })),
      by_model: Object.entries(byModel).map(([model, data]) => ({
        model: model as LLMModel,
        requests: data.requests,
        cost_usd: Math.round(data.cost_usd * 1000000) / 1000000,
      })),
    };

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching LLM usage:', error);
    return NextResponse.json(
      { error: 'Failed to fetch LLM usage' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/llm/usage/summary
 *
 * Create or update usage summary for a period.
 * Called by a scheduled job to aggregate daily/weekly/monthly stats.
 */
export async function POST(request: NextRequest) {
  try {
    // Tenancy: org comes from the session, never from the request body.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const orgClerkId = orgResult.ctx.authOrgId;

    const body: LLMUsageRequest = await request.json();

    const periodType = body.period_type || 'daily';
    const { periodStart, periodEnd } = calculatePeriodBounds(periodType, body.period_start);

    // Aggregate interactions for the period
    const interactions = await prisma.lLMInteraction.findMany({
      where: {
        org_clerk_id: orgClerkId,
        created_at: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
    });

    // Calculate totals by interaction type
    let alertInterpretationTokens = 0;
    let knowledgeQueryTokens = 0;
    let reportGenerationTokens = 0;
    let embeddingTokens = 0;
    let totalRequests = 0;
    let cachedRequests = 0;
    let failedRequests = 0;
    let totalCost = 0;

    for (const interaction of interactions) {
      const tokens = interaction.input_tokens + interaction.output_tokens;
      totalRequests++;
      totalCost += Number(interaction.cost_usd);

      if (interaction.response_cached) cachedRequests++;
      if (!interaction.success) failedRequests++;

      switch (interaction.interaction_type) {
        case 'ALERT_INTERPRETATION':
          alertInterpretationTokens += tokens;
          break;
        case 'KNOWLEDGE_QUERY':
          knowledgeQueryTokens += tokens;
          break;
        case 'REPORT_GENERATION':
          reportGenerationTokens += tokens;
          break;
        case 'EMBEDDING':
          embeddingTokens += tokens;
          break;
      }
    }

    // Upsert summary
    const summary = await prisma.lLMUsageSummary.upsert({
      where: {
        org_clerk_id_period_start_period_type: {
          org_clerk_id: orgClerkId,
          period_start: periodStart,
          period_type: periodType,
        },
      },
      update: {
        period_end: periodEnd,
        alert_interpretation_tokens: alertInterpretationTokens,
        knowledge_query_tokens: knowledgeQueryTokens,
        report_generation_tokens: reportGenerationTokens,
        embedding_tokens: embeddingTokens,
        total_requests: totalRequests,
        cached_requests: cachedRequests,
        failed_requests: failedRequests,
        total_cost_usd: totalCost,
      },
      create: {
        org_clerk_id: orgClerkId,
        period_start: periodStart,
        period_end: periodEnd,
        period_type: periodType,
        alert_interpretation_tokens: alertInterpretationTokens,
        knowledge_query_tokens: knowledgeQueryTokens,
        report_generation_tokens: reportGenerationTokens,
        embedding_tokens: embeddingTokens,
        total_requests: totalRequests,
        cached_requests: cachedRequests,
        failed_requests: failedRequests,
        total_cost_usd: totalCost,
      },
    });

    return NextResponse.json({
      id: summary.id,
      period_start: summary.period_start.toISOString(),
      period_end: summary.period_end.toISOString(),
      total_requests: summary.total_requests,
      total_cost_usd: Number(summary.total_cost_usd),
    });
  } catch (error) {
    console.error('Error creating usage summary:', error);
    return NextResponse.json(
      { error: 'Failed to create usage summary' },
      { status: 500 }
    );
  }
}

function calculatePeriodBounds(
  periodType: 'daily' | 'weekly' | 'monthly',
  periodStartStr?: string
): { periodStart: Date; periodEnd: Date } {
  let periodStart: Date;
  let periodEnd: Date;

  if (periodStartStr) {
    periodStart = new Date(periodStartStr);
  } else {
    periodStart = new Date();
  }

  // Reset to start of day
  periodStart.setHours(0, 0, 0, 0);

  switch (periodType) {
    case 'daily':
      // Start of the day
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 1);
      periodEnd.setMilliseconds(-1);
      break;

    case 'weekly': {
      // Start of the week (Monday)
      const dayOfWeek = periodStart.getDay();
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      periodStart.setDate(periodStart.getDate() - daysFromMonday);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 7);
      periodEnd.setMilliseconds(-1);
      break;
    }

    case 'monthly':
      // Start of the month
      periodStart.setDate(1);
      periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      periodEnd.setMilliseconds(-1);
      break;
  }

  return { periodStart, periodEnd };
}
