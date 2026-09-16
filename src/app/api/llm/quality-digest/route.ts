import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { invokeBedrockDetailed, modelLabel } from '@/lib/ai/bedrock';
import { recordLLMInteraction } from '@/lib/ai/llm-pricing';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';

export const runtime = 'nodejs';

/**
 * POST /api/llm/quality-digest
 *
 * Bedrock-Haiku-backed Data Quality digest for the morning operator briefing.
 *
 * Input: today.json payload describing one plant's DQ posture
 *   {
 *     plant_id, sla, freshness_summary, top_degraded, kpi_impact,
 *     curation_log_recent
 *   }
 *
 * Output (ALWAYS 200):
 *   { digest: string, generated_at: ISO, cache_hit: boolean, model: string }
 *
 * Bedrock failures (timeouts, no creds, parse errors) silently fall back to a
 * rule-based digest derived strictly from the input numbers — no fabrication.
 *
 * Caching: in-memory 24h TTL keyed by SHA-256 of the normalised input body.
 * The cache is per-Node-process and survives only while the server runs; this
 * matches the throwaway nature of a daily digest and avoids a Prisma migration
 * just for a free-text blob. (Contrast: interpret-alert caches in Postgres
 * because its rows back the AlertInterpretation table consumed by the UI.)
 */

interface QualityDigestInput {
  plant_id?: string;
  sla?: {
    contract_pct?: number;
    mtd_pct?: number;
    projected_eom_pct?: number;
    days_remaining_in_month?: number;
  };
  freshness_summary?: {
    total_streams?: number;
    fresh?: number;
    stale_under_1h?: number;
    stale_under_24h?: number;
    stale_over_24h?: number;
  };
  top_degraded?: Array<{
    stream_id?: string;
    label?: string;
    severity?: string;
    gap_minutes?: number;
    attribution_cause?: string;
    attribution_narrative?: string;
    affected_kpis?: string[];
  }>;
  kpi_impact?: Array<{
    kpi?: string;
    confidence_band?: string;
    excluded_streams?: number;
    notes?: string;
  }>;
  curation_log_recent?: Array<{
    action?: string;
    stream_id?: string;
    by?: string;
    at?: string;
  }>;
}

interface DigestResponse {
  digest: string;
  generated_at: string;
  cache_hit: boolean;
  model: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_LABEL = modelLabel();
const FALLBACK_MODEL_LABEL = 'fallback';

type CacheEntry = { value: DigestResponse; expiresAt: number };
const digestCache: Map<string, CacheEntry> = (globalThis as any).__qualityDigestCache
  ?? ((globalThis as any).__qualityDigestCache = new Map<string, CacheEntry>());

function computeDigestHash(input: QualityDigestInput): string {
  // Stable stringify by re-walking keys alphabetically so equivalent payloads
  // collide in cache regardless of key order.
  const stable = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function buildPrompt(input: QualityDigestInput): string {
  return [
    `PLANT: ${input.plant_id ?? 'unknown'}`,
    '',
    'SIGNALS:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

const SYSTEM_PROMPT = `You are an O&M data quality analyst summarizing today's signals for the morning operator briefing. Output a short, scannable briefing.

Write a briefing that:
1. Leads with SLA standing (MTD% vs contract) — call out if below.
2. Highlights the 1-2 most critical degraded streams with cause in plain English.
3. Notes KPI confidence impact in operational terms.
4. Ends with ONE prioritised action for the next hour.

150 words max. Bullet format welcome. Plain ASCII (no emojis). Numbers cited precisely.`;

/**
 * Rule-based fallback. Strict: every number traced to the input — no estimates.
 */
function buildFallbackDigest(input: QualityDigestInput): string {
  const sla = input.sla ?? {};
  const mtd =
    typeof sla.mtd_pct === 'number' ? sla.mtd_pct.toFixed(2) : 'n/a';
  const contract =
    typeof sla.contract_pct === 'number'
      ? `${sla.contract_pct}%`
      : 'contract n/a';

  const degraded = Array.isArray(input.top_degraded) ? input.top_degraded : [];
  const flaggedCount = degraded.length;
  const topStream = degraded[0];
  const topSeverity = topStream?.severity ?? 'unspecified severity';
  const topLabel =
    topStream?.label ?? topStream?.stream_id ?? 'no flagged stream';

  const kpiBands = Array.isArray(input.kpi_impact) ? input.kpi_impact : [];
  const prImpact = kpiBands.find(
    (k) => (k?.kpi ?? '').toUpperCase() === 'PR'
  );
  const prBand = prImpact?.confidence_band ?? 'unreported';

  const slaCall =
    typeof sla.mtd_pct === 'number' &&
    typeof sla.contract_pct === 'number' &&
    sla.mtd_pct < sla.contract_pct
      ? ` (below ${contract})`
      : '';

  const actionTarget =
    topStream?.stream_id ?? topStream?.label ?? 'flagged streams';

  return `SLA tracking at ${mtd}%${slaCall}; ${flaggedCount} streams flagged (${topSeverity}, top: ${topLabel}). PR confidence ${prBand}; recommended: review ${actionTarget}.`;
}

async function callBedrock(
  input: QualityDigestInput,
  orgClerkId: string
): Promise<string | null> {
  try {
    const prompt = buildPrompt(input);
    const startedAt = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 400,
      temperature: 0.2,
    });
    const trimmed = (detailed.text ?? '').trim();
    recordLLMInteraction({
      orgClerkId,
      modelId: modelLabel(),
      interactionType: 'REPORT_GENERATION',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(trimmed.length / 4),
      latencyMs: Date.now() - startedAt,
    });
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    console.warn('[quality-digest] Bedrock call failed:', e);
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Tenancy: session required — every uncached call costs Bedrock money.
  // (The "always 200" contract below applies to authenticated callers only.)
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const gate = await requireFeature(orgResult.ctx.authOrgId, 'ai:insights');
  if (gate) return gate;
  const llmBudget = await checkLLMBudget(orgResult.ctx.authOrgId);
  if (!llmBudget.ok) {
    return NextResponse.json(llmBudgetError(llmBudget), { status: 429 });
  }

  let input: QualityDigestInput = {};
  try {
    input = (await req.json()) as QualityDigestInput;
    if (!input || typeof input !== 'object') input = {};
  } catch {
    // Malformed JSON — still return 200 with a fallback so the morning briefing
    // never blocks the UI.
    input = {};
  }

  const hash = computeDigestHash(input);
  const now = Date.now();

  const cached = digestCache.get(hash);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json({
      ...cached.value,
      cache_hit: true,
    });
  }

  const llmText = await callBedrock(input, orgResult.ctx.authOrgId);
  const usedFallback = llmText === null;
  const digest = llmText ?? buildFallbackDigest(input);

  const response: DigestResponse = {
    digest,
    generated_at: new Date().toISOString(),
    cache_hit: false,
    model: usedFallback ? FALLBACK_MODEL_LABEL : MODEL_LABEL,
  };

  digestCache.set(hash, {
    value: response,
    expiresAt: now + CACHE_TTL_MS,
  });

  return NextResponse.json(response);
}
