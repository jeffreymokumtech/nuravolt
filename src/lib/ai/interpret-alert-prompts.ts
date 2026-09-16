/**
 * Prompt variants for the LLM ticket-narration A/B framework.
 *
 * Each variant returns the same JSON shape (the `InterpretedAlert` fields). The
 * goal of variants is to test different framings — concise vs. root-cause-first
 * vs. the original prompt — and measure which one operators edit least at the
 * VALIDATED gate.
 *
 * Variant selection is round-robin at first generation; the `regenerate` route
 * cycles through them.
 */

export type PromptVariant = 'v1' | 'v2_concise' | 'v3_root_cause_first';

export const PROMPT_VARIANTS: PromptVariant[] = ['v1', 'v2_concise', 'v3_root_cause_first'];

export interface PromptSpec {
  variant: PromptVariant;
  system: string;
  /** Builds the user prompt given the pre-rendered context fragments. */
  build: (ctx: PromptContext) => string;
}

export interface PromptContext {
  componentType: string;
  componentId: string;
  faultType?: string;
  displayName?: string;
  severity: string;
  anomalyScore: number;
  expectedValue?: number;
  actualValue?: number;
  trendDirection?: string;
  consecutiveAnomalies?: number;
  featureLines: string;
  historyLines: string;
  existingInterpretation?: string;
  /**
   * Pre-rendered equipment-documentation excerpts ("[0] (Doc, section N)\n…").
   * When present the schemas ask for source_indices so citations map back to
   * the excerpts actually used.
   */
  manualLines?: string;
}

const BASE_SYSTEM =
  'You are a senior solar PV reliability engineer. You interpret ML anomaly alerts for operations teams. Be concise, technical, and never invent component IDs or numeric values.';

const CONCISE_SYSTEM =
  'You are a senior solar PV reliability engineer. You interpret ML anomaly alerts for operations teams. Be aggressively concise — each JSON field <= 80 characters. Never invent values.';

const ROOT_CAUSE_SYSTEM =
  'You are a senior solar PV reliability engineer interpreting an ML anomaly. Lead with the root cause: the explanation must justify the likely_cause first, then describe the symptom. Never invent values.';

function baseContextBlock(c: PromptContext): string {
  // Fault type + display name anchor the LLM to the right physical phenomenon
  // when SHAP features are absent (rule-based faults). Without these the prompt
  // is asset+severity+score only and the model pattern-matches from terse
  // evidence text, producing the wrong narrative.
  const faultLine = c.faultType
    ? `Fault type: ${c.faultType}${c.displayName ? ` (${c.displayName})` : ''}`
    : '';
  const evidenceBlock = c.existingInterpretation
    ? `\n\nUpstream evidence (verbatim, do not contradict):\n${c.existingInterpretation}`
    : '';
  const manualBlock = c.manualLines
    ? `\n\nManufacturer documentation excerpts (ground recommended_action in these where relevant; report which via source_indices):\n${c.manualLines}`
    : '';
  return [
    `Component: ${c.componentType} ${c.componentId}`,
    faultLine,
    `Severity: ${c.severity}`,
    `Anomaly score: ${c.anomalyScore.toFixed(3)}`,
    c.expectedValue !== undefined && c.actualValue !== undefined
      ? `Expected: ${c.expectedValue}, Actual: ${c.actualValue}`
      : '',
    c.trendDirection ? `Trend: ${c.trendDirection}` : '',
    c.consecutiveAnomalies != null
      ? `Consecutive anomalies: ${c.consecutiveAnomalies}`
      : '',
    '',
    'Top SHAP feature contributions:',
    c.featureLines,
    '',
    'Similar past events:',
    c.historyLines,
  ]
    .filter(Boolean)
    .join('\n') + evidenceBlock + manualBlock;
}

// Appended to every schema when documentation excerpts are in the prompt.
const SOURCES_KEY_LINE =
  '  "source_indices": array of excerpt numbers actually used (e.g. [0]); [] if none,';

function jsonSchemaV1(withSources: boolean): string {
  return [
    'Return STRICT JSON with keys:',
    '{',
    ...(withSources ? [SOURCES_KEY_LINE] : []),
    '  "summary": short title (<= 120 chars),',
    '  "explanation": 1-2 sentences citing the contributing features,',
    '  "likely_cause": one phrase naming the probable physical cause,',
    '  "recommended_action": one imperative sentence,',
    '  "urgency": "IMMEDIATE" | "WITHIN_24H" | "WITHIN_7D" | "MONITOR",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW"',
    '}',
  ].join('\n');
}

function jsonSchemaConcise(withSources: boolean): string {
  return [
    'Return STRICT JSON. Every text field <= 80 chars. No filler words. Keys:',
    '{',
    ...(withSources ? [SOURCES_KEY_LINE] : []),
    '  "summary": <= 80 chars,',
    '  "explanation": <= 80 chars; cite top 1-2 features,',
    '  "likely_cause": <= 50 chars,',
    '  "recommended_action": <= 80 chars, imperative,',
    '  "urgency": "IMMEDIATE" | "WITHIN_24H" | "WITHIN_7D" | "MONITOR",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW"',
    '}',
  ].join('\n');
}

function jsonSchemaRootCauseFirst(withSources: boolean): string {
  return [
    'Return STRICT JSON. Order your reasoning: root cause first, then symptom. Keys:',
    '{',
    ...(withSources ? [SOURCES_KEY_LINE] : []),
    '  "likely_cause": one phrase naming the probable physical cause,',
    '  "explanation": 1-2 sentences — first justify the cause via SHAP features, then describe the symptom,',
    '  "summary": short title (<= 120 chars),',
    '  "recommended_action": one imperative sentence that targets the cause,',
    '  "urgency": "IMMEDIATE" | "WITHIN_24H" | "WITHIN_7D" | "MONITOR",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW"',
    '}',
  ].join('\n');
}

export const PROMPT_SPECS: Record<PromptVariant, PromptSpec> = {
  v1: {
    variant: 'v1',
    system: BASE_SYSTEM,
    build: (ctx) =>
      `${baseContextBlock(ctx)}\n\n${jsonSchemaV1(Boolean(ctx.manualLines))}`,
  },
  v2_concise: {
    variant: 'v2_concise',
    system: CONCISE_SYSTEM,
    build: (ctx) =>
      `${baseContextBlock(ctx)}\n\n${jsonSchemaConcise(Boolean(ctx.manualLines))}`,
  },
  v3_root_cause_first: {
    variant: 'v3_root_cause_first',
    system: ROOT_CAUSE_SYSTEM,
    build: (ctx) =>
      `${baseContextBlock(ctx)}\n\n${jsonSchemaRootCauseFirst(Boolean(ctx.manualLines))}`,
  },
};

/**
 * Round-robin variant assignment. Use this for the first narration of a ticket
 * so traffic is split evenly across variants. For `regenerate`, the caller
 * passes the previous variant so we can cycle to the next one.
 */
export function pickInitialVariant(): PromptVariant {
  const idx = Math.floor(Math.random() * PROMPT_VARIANTS.length);
  return PROMPT_VARIANTS[idx]!;
}

export function nextVariant(current: PromptVariant | null | undefined): PromptVariant {
  if (!current) return pickInitialVariant();
  const idx = PROMPT_VARIANTS.indexOf(current);
  return PROMPT_VARIANTS[(idx + 1) % PROMPT_VARIANTS.length]!;
}
