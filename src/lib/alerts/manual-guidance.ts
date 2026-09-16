import crypto from 'crypto';
import prisma from '@/libs/prisma';
import { searchKB, type KBSearchResult } from '@/lib/ai/kb-search';
import { modelLabel, invokeBedrockDetailed, extractJson } from '@/lib/ai/bedrock';
import { checkLLMBudget } from '@/lib/billing/llm-budget';
import { getOrgPlan, hasFeature } from '@/lib/billing/plan';
import type { PlantAlertKind } from '@prisma/client';
import { enumsForModelId, estimateLLMCostUsd } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

/**
 * Manual-aware guidance for alerts: what does the equipment documentation
 * say the operator should do about this alert?
 *
 * Pipeline: resolve the plant's equipment identity (inverter model, BESS or
 * H2 asset) → vector-search the knowledge base with an equipment filter →
 * distill the top chunks to a ≤2-sentence action with a citation.
 *
 * Design constraints:
 *  - NEVER blocks or fails alerting: any miss (no docs, budget blocked,
 *    LLM error, plan without ai:copilot) returns null and the alert ships
 *    without guidance.
 *  - LLM spend is gated (ai:copilot plans only), budget-checked, cached
 *    for 7 days per (kind, equipment model) via a synthetic
 *    AlertInterpretation row, and logged to LLMInteraction.
 */

export interface ManualGuidance {
  /** ≤2-sentence "per the manual" action. */
  text: string;
  source: {
    title: string;
    /** Best-effort section hint, e.g. "chunk 41 of SUN2000 manual". */
    section: string;
    url?: string | null;
  };
}

export interface ManualExcerpt {
  title: string;
  content: string;
  section: string;
  url?: string | null;
}

interface EquipmentIdentity {
  manufacturer: string | null;
  model: string | null;
  equipmentType: 'inverter' | 'battery' | 'electrolyzer' | null;
}

const CACHE_DAYS = 7;
const GUIDANCE_ALERT_TYPE = 'manual_guidance';

/** Alert kind → what to ask the manuals. */
function queryForKind(kind: PlantAlertKind | string, eq: EquipmentIdentity): string {
  const model = eq.model ?? 'the equipment';
  switch (kind) {
    case 'SOILING_LOSS':
      return 'recommended module cleaning procedure, cleaning interval and soiling mitigation';
    case 'PERFORMANCE_RATIO':
      return `${model} low output power derating troubleshooting causes and checks`;
    case 'DATA_STALE':
      return `${model} communication loss monitoring connection troubleshooting`;
    case 'CRITICAL_FAULT':
      return `${model} fault alarm code troubleshooting corrective action`;
    default:
      return `${model} troubleshooting recommended action`;
  }
}

/** Resolve the plant's primary equipment identity for an alert kind. */
async function resolveEquipment(
  plantId: string,
  kind: PlantAlertKind | string
): Promise<EquipmentIdentity> {
  // BESS/H2 alerts would target those assets; the current v1 kinds are all
  // PV-plant level, so the inverter is the primary identity. Fall through
  // gracefully when the plant has no typed equipment rows.
  const group = await prisma.inverterGroup.findFirst({
    where: { plant_id: plantId, inverter_model: { not: null } },
    select: { inverter_model: true },
  });
  if (group?.inverter_model) {
    return { manufacturer: null, model: group.inverter_model, equipmentType: 'inverter' };
  }
  const bess = await prisma.bessAsset.findFirst({
    where: { plant_id: plantId, model: { not: null } },
    select: { manufacturer: true, model: true },
  });
  if (bess?.model) {
    return { manufacturer: bess.manufacturer, model: bess.model, equipmentType: 'battery' };
  }
  const h2 = await prisma.h2Asset.findFirst({
    where: { plant_id: plantId, model: { not: null } },
    select: { manufacturer: true, model: true },
  });
  if (h2?.model) {
    return { manufacturer: h2.manufacturer, model: h2.model, equipmentType: 'electrolyzer' };
  }
  return { manufacturer: null, model: null, equipmentType: null };
}

function sectionLabel(r: KBSearchResult): string {
  return `${r.document_title}, section ${r.chunk_index + 1}`;
}

/**
 * Raw manual excerpts for an alert/fault — used by ticket narration, which
 * does its own LLM call and should receive source text, not a distillate.
 * No LLM spend here (embedding-only), so no plan gate.
 */
export async function manualExcerptsFor(args: {
  orgClerkId: string;
  plantId: string;
  kind: PlantAlertKind | string;
  /** Extra query context, e.g. the fault type or alarm text. */
  detail?: string | null;
  limit?: number;
}): Promise<ManualExcerpt[]> {
  try {
    const eq = await resolveEquipment(args.plantId, args.kind);
    const query = [queryForKind(args.kind, eq), args.detail ?? ''].join(' ').trim();
    // Soiling is a module/plant-level concern — don't narrow to the inverter
    // identity or the cleaning SOP (equipment_type pv_modules) is filtered out.
    const equipment =
      args.kind !== 'SOILING_LOSS' && eq.model
        ? { manufacturer: eq.manufacturer, model: eq.model, equipmentType: eq.equipmentType }
        : null;
    const hits = await searchKB({
      orgClerkId: args.orgClerkId,
      query,
      limit: args.limit ?? 3,
      plantId: args.plantId,
      equipment,
    });
    return hits
      .filter((h) => h.similarity >= 0.3)
      .map((h) => ({
        title: h.document_title,
        content: h.content,
        section: sectionLabel(h),
        url: h.source_url,
      }));
  } catch (e) {
    console.warn('[manual-guidance] excerpt lookup failed:', e);
    return [];
  }
}

/**
 * Distilled "per the manual" guidance for a plant alert, or null.
 * Cached per (kind, equipment model) for 7 days.
 */
export async function manualGuidanceFor(args: {
  orgClerkId: string;
  plantId: string;
  kind: PlantAlertKind | string;
  message?: string | null;
}): Promise<ManualGuidance | null> {
  try {
    // LLM feature gate: same convention as ticket narration — only
    // ai:copilot plans get generated guidance (demo identities pass).
    if (args.orgClerkId && !args.orgClerkId.startsWith('demo_')) {
      const plan = await getOrgPlan(args.orgClerkId);
      if (!hasFeature(plan, 'ai:copilot')) return null;
    }

    const eq = await resolveEquipment(args.plantId, args.kind);
    const cacheKey = crypto
      .createHash('sha256')
      .update(`manual_guidance:${args.kind}:${eq.model ?? 'generic'}:${eq.equipmentType ?? ''}`)
      .digest('hex');

    // 7-day cache: synthetic AlertInterpretation row keyed by the hash.
    const cached = await prisma.alertInterpretation.findUnique({
      where: { alert_hash: cacheKey },
    });
    if (cached && (!cached.cache_expires_at || cached.cache_expires_at > new Date())) {
      return {
        text: cached.recommended_action,
        source: { title: cached.summary, section: cached.likely_cause },
      };
    }

    const excerpts = await manualExcerptsFor({
      orgClerkId: args.orgClerkId,
      plantId: args.plantId,
      kind: args.kind,
      detail: args.message,
    });
    if (excerpts.length === 0) return null;

    const budget = await checkLLMBudget(args.orgClerkId);
    if (!budget.ok) return null;

    const userPrompt = `Alert kind: ${args.kind}${args.message ? ` — ${args.message}` : ''}
Equipment: ${[eq.manufacturer, eq.model].filter(Boolean).join(' ') || 'unknown'}

Documentation excerpts:
${excerpts.map((e, i) => `[${i}] (${e.section})\n${e.content.slice(0, 900)}`).join('\n\n')}

From these excerpts ONLY, give the operator the manual's recommended action for this alert in at most 2 sentences. If the excerpts don't cover it, respond {"covered": false}. JSON: {"covered": true|false, "action": "<text>", "excerpt_index": <number>}`;

    const startedAt = Date.now();
    const detailed = await invokeBedrockDetailed(userPrompt, {
      system:
        'You summarize equipment documentation for solar plant operators. Only state what the documentation supports; never invent procedures.',
      maxTokens: 220,
      temperature: 0,
      jsonMode: true,
    });
    const raw = detailed.text;
    const parsed = extractJson<{ covered: boolean; action?: string; excerpt_index?: number }>(raw);

    // Real usage when the payload carries it; len/4 is an estimate otherwise.
    const inputTokens = detailed.inputTokens ?? Math.ceil(userPrompt.length / 4);
    const outputTokens = detailed.outputTokens ?? Math.ceil(raw.length / 4);
    const costUsd = estimateLLMCostUsd(modelLabel(), inputTokens, outputTokens);
    await prisma.lLMInteraction
      .create({
        data: {
          org_clerk_id: args.orgClerkId,
          provider: llmEnums.provider,
          model: llmEnums.model,
          interaction_type: 'ALERT_INTERPRETATION',
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd,
          latency_ms: Date.now() - startedAt,
          request_hash: cacheKey,
          plant_id: args.plantId,
          success: Boolean(parsed),
        },
      })
      .catch(() => {});

    if (!parsed?.covered || !parsed.action?.trim()) return null;

    const src =
      excerpts[
        parsed.excerpt_index != null && excerpts[parsed.excerpt_index]
          ? parsed.excerpt_index
          : 0
      ];
    const guidance: ManualGuidance = {
      text: parsed.action.trim(),
      source: { title: src.title, section: src.section, url: src.url },
    };

    // Upsert the cache row (unique on alert_hash).
    await prisma.alertInterpretation
      .upsert({
        where: { alert_hash: cacheKey },
        create: {
          org_clerk_id: args.orgClerkId,
          plant_id: args.plantId,
          alert_type: GUIDANCE_ALERT_TYPE,
          alert_hash: cacheKey,
          summary: guidance.source.title,
          explanation: excerpts[0].content.slice(0, 2000),
          likely_cause: guidance.source.section,
          recommended_action: guidance.text,
          urgency: 'MONITOR',
          confidence: 'MEDIUM',
          llm_model: 'qwen3-next-80b',
          llm_cost_usd: costUsd,
          llm_latency_ms: Date.now() - startedAt,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_expires_at: new Date(Date.now() + CACHE_DAYS * 86_400_000),
        },
        update: {
          recommended_action: guidance.text,
          summary: guidance.source.title,
          likely_cause: guidance.source.section,
          cache_expires_at: new Date(Date.now() + CACHE_DAYS * 86_400_000),
        },
      })
      .catch(() => {});

    return guidance;
  } catch (e) {
    // Guidance must never break alerting.
    console.warn('[manual-guidance] failed:', e);
    return null;
  }
}
