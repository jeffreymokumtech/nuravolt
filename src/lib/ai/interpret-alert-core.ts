import crypto from 'crypto';
import { extractJson, invokeBedrockDetailed, modelLabel } from '@/lib/ai/bedrock';
import { estimateLLMCostUsd } from '@/lib/ai/llm-pricing';
import { PROMPT_SPECS, pickInitialVariant, type PromptVariant } from '@/lib/ai/interpret-alert-prompts';
import type { ManualExcerpt } from '@/lib/alerts/manual-guidance';
import type {
  AlertConfidence,
  AlertUrgency,
  AnomalyContext,
  HistoricalMatch,
  InterpretedAlert,
} from '@/types/llm';

/**
 * Shared core for ML anomaly → human-readable interpretation. Used by:
 *  - POST /api/llm/interpret-alert (public route, callable from anywhere)
 *  - POST /api/tickets/triggers (fire-and-forget at ticket creation)
 *  - POST /api/tickets/[ticketId]/narration/regenerate
 *
 * In-process call (no HTTP hop) so the ticket trigger flow can attach the
 * interpretation to the new Ticket row without blocking the response on
 * Bedrock latency.
 *
 * Behaviour-preserving extraction from the previous inline implementation in
 * src/app/api/llm/interpret-alert/route.ts.
 */

export interface GenerateInterpretationOptions {
  /**
   * Which prompt variant to use. Defaults to a round-robin pick if omitted.
   * Pass an explicit variant when regenerating so we cycle.
   */
  variant?: PromptVariant;
  /**
   * Equipment-manual excerpts (via manualExcerptsFor) — rendered into the
   * prompt so the narration can ground its recommended action in the
   * manufacturer's documentation and cite it.
   */
  manualExcerpts?: ManualExcerpt[];
}

export interface GeneratedInterpretation {
  interpretation: InterpretedAlert;
  variant: PromptVariant;
  /** True iff we fell back to rule-based after a Bedrock failure. */
  usedFallback: boolean;
}

/**
 * Generate an interpretation: try Bedrock first, fall back to rule-based on
 * any failure (network, JSON parse, missing required fields).
 */
export async function generateInterpretation(
  context: AnomalyContext,
  historicalMatches: HistoricalMatch[] | undefined,
  opts: GenerateInterpretationOptions = {}
): Promise<GeneratedInterpretation> {
  const variant = opts.variant ?? pickInitialVariant();

  const llm = await generateLLMInterpretation(
    context,
    historicalMatches,
    variant,
    opts.manualExcerpts
  );
  if (llm) {
    return { interpretation: llm, variant, usedFallback: false };
  }

  const fallback = generateFallbackInterpretation(context, historicalMatches);
  return { interpretation: fallback, variant, usedFallback: true };
}

/**
 * Generate a Bedrock-Claude interpretation of an alert. Returns null on any
 * failure (network, JSON parse, missing fields) so the caller falls back to
 * the rule-based path.
 */
export async function generateLLMInterpretation(
  context: AnomalyContext,
  historicalMatches: HistoricalMatch[] | undefined,
  variant: PromptVariant,
  manualExcerpts?: ManualExcerpt[]
): Promise<InterpretedAlert | null> {
  const startedAt = Date.now();

  const featureLines = context.feature_contributions
    ? Object.entries(context.feature_contributions)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 5)
        .map(([k, v]) => `- ${k}: ${v.toFixed(3)}`)
        .join('\n')
    : '(none)';

  const historyLines =
    historicalMatches && historicalMatches.length > 0
      ? historicalMatches
          .slice(0, 3)
          .map(
            (m, i) =>
              `${i + 1}. ${m.event_id}: ${m.summary ?? 'similar prior event'}`
          )
          .join('\n')
      : '(none)';

  const excerpts = (manualExcerpts ?? []).slice(0, 3);
  const manualLines =
    excerpts.length > 0
      ? excerpts
          .map((e, i) => `[${i}] (${e.section})\n${e.content.slice(0, 700)}`)
          .join('\n\n')
      : undefined;

  const spec = PROMPT_SPECS[variant];
  const userPrompt = spec.build({
    componentType: context.component_type,
    componentId: context.component_id,
    faultType: context.fault_type,
    displayName: context.display_name,
    severity: context.severity,
    anomalyScore: context.anomaly_score,
    expectedValue: context.expected_value,
    actualValue: context.actual_value,
    trendDirection: context.trend_direction,
    consecutiveAnomalies: context.consecutive_anomalies,
    featureLines,
    historyLines,
    existingInterpretation: context.existing_interpretation,
    manualLines,
  });

  try {
    const detailed = await invokeBedrockDetailed(userPrompt, {
      system: spec.system,
      jsonMode: true,
      maxTokens: 600,
      temperature: 0.2,
    });
    const raw = detailed.text;
    const parsed = extractJson<{
      summary?: string;
      explanation?: string;
      likely_cause?: string;
      recommended_action?: string;
      urgency?: AlertUrgency;
      confidence?: AlertConfidence;
      source_indices?: number[];
    }>(raw);

    if (!parsed?.summary || !parsed.explanation || !parsed.recommended_action) {
      return null;
    }

    // Map cited excerpt indices back to documentation metadata.
    const sources = Array.isArray(parsed.source_indices)
      ? parsed.source_indices
          .filter((i): i is number => Number.isInteger(i) && i >= 0 && i < excerpts.length)
          .map((i) => ({ title: excerpts[i].title, section: excerpts[i].section }))
      : [];

    const latencyMs = Date.now() - startedAt;
    // Prefer real usage from the response payload; the len/4 fallback is an
    // ESTIMATE for models that omit usage on the non-streaming path.
    const inputTokens = detailed.inputTokens ?? Math.ceil(userPrompt.length / 4);
    const outputTokens = detailed.outputTokens ?? Math.ceil(raw.length / 4);
    const costUsd = estimateLLMCostUsd(modelLabel(), inputTokens, outputTokens);

    return {
      summary: parsed.summary,
      explanation: parsed.explanation,
      likely_cause: parsed.likely_cause ?? 'See explanation',
      recommended_action: parsed.recommended_action,
      urgency: (parsed.urgency ?? 'MONITOR') as AlertUrgency,
      confidence: (parsed.confidence ?? 'MEDIUM') as AlertConfidence,
      similar_past_events: (historicalMatches || [])
        .slice(0, 3)
        .map((m) => m.event_id),
      sources,
      llm_model: modelLabel(),
      llm_cost_usd: costUsd,
      llm_latency_ms: latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      used_fallback: false,
    };
  } catch (e) {
    console.warn('[interpret-alert-core] Bedrock call failed:', e);
    return null;
  }
}

/**
 * Generate rule-based interpretation when LLM is not available.
 */
export function generateFallbackInterpretation(
  context: AnomalyContext,
  historicalMatches?: HistoricalMatch[]
): InterpretedAlert {
  const startTime = Date.now();

  let summary: string;
  if (context.existing_interpretation) {
    summary = context.existing_interpretation;
  } else {
    const componentType =
      context.component_type.charAt(0).toUpperCase() + context.component_type.slice(1);
    summary = `${componentType} ${context.component_id} anomaly detected`;
  }

  let explanation: string;
  if (
    context.feature_contributions &&
    Object.keys(context.feature_contributions).length > 0
  ) {
    const topFeatures = Object.entries(context.feature_contributions)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3);
    const featureText = topFeatures
      .map(([f, v]) => `${f} (${v > 0 ? '+' : ''}${v.toFixed(2)})`)
      .join(', ');
    explanation = `Primary contributing factors: ${featureText}.`;
  } else {
    explanation = `Anomaly score: ${context.anomaly_score.toFixed(2)}`;
  }

  if (context.expected_value !== undefined && context.actual_value !== undefined) {
    const deviation =
      context.expected_value !== 0
        ? ((context.actual_value - context.expected_value) /
            context.expected_value) *
          100
        : 0;
    explanation += ` Expected: ${context.expected_value.toFixed(1)}, Actual: ${context.actual_value.toFixed(1)} (${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%).`;
  }

  let likelyCause: string;
  if (context.existing_possible_causes && context.existing_possible_causes.length > 0) {
    likelyCause = context.existing_possible_causes[0]!;
  } else {
    likelyCause = inferCauseFromFeatures(context.feature_contributions);
  }

  const urgency = determineUrgency(context);

  let recommendedAction: string;
  if (urgency === 'IMMEDIATE') {
    recommendedAction = `IMMEDIATE: Investigate ${context.component_id}. Check ${likelyCause}.`;
  } else if (urgency === 'WITHIN_24H') {
    recommendedAction = `Schedule inspection of ${context.component_id} within 24 hours.`;
  } else if (urgency === 'WITHIN_7D') {
    recommendedAction = `Plan maintenance for ${context.component_id} within 7 days.`;
  } else {
    recommendedAction = `Monitor ${context.component_id}. Review if trend continues.`;
  }

  const confidence = mapConfidence(context.confidence);
  const latencyMs = Date.now() - startTime;

  return {
    summary,
    explanation,
    likely_cause: likelyCause,
    recommended_action: recommendedAction,
    urgency,
    confidence,
    similar_past_events: (historicalMatches || []).slice(0, 3).map((m) => m.event_id),
    sources: [],
    llm_model: 'fallback',
    llm_cost_usd: 0,
    llm_latency_ms: latencyMs,
    input_tokens: 0,
    output_tokens: 0,
    used_fallback: true,
  };
}

function determineUrgency(context: AnomalyContext): AlertUrgency {
  if (context.severity === 'critical') {
    return 'IMMEDIATE';
  }
  if (context.severity === 'warning') {
    const isWorsening = context.trend_direction === 'worsening';
    const hasMultipleAnomalies = (context.consecutive_anomalies || 0) >= 3;
    if (isWorsening || hasMultipleAnomalies) {
      return 'WITHIN_24H';
    }
    return 'WITHIN_7D';
  }
  return 'MONITOR';
}

function mapConfidence(confidence: number): AlertConfidence {
  if (confidence > 0.8) return 'HIGH';
  if (confidence > 0.5) return 'MEDIUM';
  return 'LOW';
}

function inferCauseFromFeatures(contributions?: Record<string, number>): string {
  if (!contributions || Object.keys(contributions).length === 0) {
    return 'Unknown - requires investigation';
  }
  const causeMapping: Record<string, string> = {
    dc_voltage: 'DC cable or connector issue',
    temperature: 'Thermal stress or cooling problem',
    efficiency: 'Inverter degradation or fault',
    current: 'String mismatch or bypass diode failure',
    power: 'Performance deviation from expected',
    irradiance: 'Sensor calibration or shading',
    soiling: 'Module soiling accumulation',
    residual: 'Model prediction deviation',
  };
  const topFeature = Object.entries(contributions)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]![0]
    .toLowerCase();
  for (const [keyword, cause] of Object.entries(causeMapping)) {
    if (topFeature.includes(keyword)) {
      return cause;
    }
  }
  return `Related to ${topFeature}`;
}

/**
 * Compute a hash for caching based on anomaly context. Used by the public
 * route (AlertInterpretation cache) and by the LLMInteraction request_hash.
 *
 * The salt bump (v2) invalidates pre-fault_type rows where multiple distinct
 * faults on the same asset/severity/score collided onto one cached narrative.
 */
const ALERT_HASH_SALT = 'v2';

export function computeAlertHash(context: AnomalyContext): string {
  const keyParts = [
    ALERT_HASH_SALT,
    context.component_id,
    context.fault_type ?? 'unknown',
    context.severity,
    Math.round(context.anomaly_score * 100).toString(),
  ];
  if (context.feature_contributions) {
    const sorted = Object.entries(context.feature_contributions)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 5);
    keyParts.push(JSON.stringify(sorted.map(([k, v]) => [k, Math.round(v * 100)])));
  }
  return crypto.createHash('md5').update(keyParts.join('|')).digest('hex');
}
