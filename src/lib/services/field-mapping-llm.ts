/**
 * LLM fallback for field mapping when regex confidence is low.
 *
 * When `FieldMappingIntelligence.mapField()` returns confidence < a
 * threshold (default 0.7), we ask Bedrock to classify the field from:
 *   - the raw column name
 *   - a small sample of values
 *   - optional vendor / context hints
 *
 * The LLM must respond with a fault_type from the closed `DataFieldType`
 * enum below. Any out-of-taxonomy answer is rejected and we fall back to
 * `unmapped` (same behaviour as if the LLM was unavailable).
 *
 * Cost: ~€0.0001 per LLM call (Claude Haiku 4.5 on ~500 token prompt).
 * For a typical client onboarding 50 columns where 10-15 trigger fallback:
 * ~€0.0015 per plant. Negligible.
 */

import { DataFieldType } from '@prisma/client';
import { extractJson, invokeBedrock } from '@/lib/ai/bedrock';
import type { FieldMappingResult } from './field-mapping-intelligence';

// ============================================================================
// Closed taxonomy — must mirror the DataFieldType enum in prisma/schema.prisma
// ============================================================================
const VALID_FIELD_TYPES: readonly string[] = [
  // PV measurements
  'power_ac', 'power_dc', 'reactive_power',
  'voltage_dc', 'voltage_ac_l1', 'voltage_ac_l2', 'voltage_ac_l3',
  'current_dc', 'current_ac_l1', 'current_ac_l2', 'current_ac_l3',
  'irradiance_poa', 'irradiance_ghi', 'irradiance_dni',
  'temp_module', 'temp_ambient', 'temp_inverter',
  'energy_daily', 'energy_total', 'power_loss', 'financial_impact',
  // Weather
  'wind_speed', 'humidity', 'precipitation', 'soiling_ratio',
  // Electrical
  'frequency', 'power_factor',
  // Status & identifiers
  'status_code', 'alarm_code',
  'plant_id', 'inverter_id', 'string_id', 'timestamp',
  // BESS
  'bess_soc', 'bess_soh', 'bess_power_charge', 'bess_power_discharge',
  'bess_temp_cell', 'bess_temp_pack', 'bess_temp_ambient',
  'bess_voltage_cell', 'bess_voltage_pack', 'bess_current', 'bess_c_rate',
  'bess_cycle_count', 'bess_throughput', 'bess_rte',
  'bess_hvac_status', 'bess_contactor_status',
  // Wind
  'wind_power', 'wind_direction', 'wind_rotor_rpm', 'wind_nacelle_temp',
  'wind_pitch_angle',
  // Explicit "could not map"
  'unmapped',
];

const SYSTEM_PROMPT = `You are a SCADA data column-mapping expert for solar PV, BESS battery storage, and wind energy systems. You map ambiguous column names from customer data exports (Huawei SmartLogger, SMA Sunny Portal, Sungrow iSolarCloud, Fronius SolarWeb, Tesla Powerwall, generic Modbus, etc.) to a standardized field taxonomy.

You will receive a column name + a small sample of values + (optional) vendor hint. Output the canonical field type from the CLOSED TAXONOMY below — exact strings, lowercase, no others.

CLOSED TAXONOMY:
${VALID_FIELD_TYPES.join(', ')}

Rules:
- If the column is clearly a measurement → pick the matching type (e.g. "Inv01.AC_Power" → power_ac).
- If the column name and values together don't match anything → return "unmapped".
- Use sample values to disambiguate (e.g. column "T1" with values 25-45 is temp_module or temp_ambient — pick based on typical PV ambient vs module ranges).
- Voltages: AC line voltages are usually 200-480V; DC voltage is typically 200-1500V for PV strings.
- BESS-specific clues: SoC/SoH in 0-1 or 0-100, cycle count is integer >0, etc.

Output strict JSON only, no prose:
{
  "field_type": "<one of taxonomy>",
  "unit": "<W|kW|V|A|°C|%|...>",
  "confidence": <0.0-1.0>,
  "reason": "<one-sentence rationale for an operator>"
}

Confidence guidance:
  0.95+ = column name + values both unambiguous match
  0.75-0.95 = strong signal but some interpretation
  0.55-0.75 = best guess from limited info
  <0.55 = genuinely uncertain → set field_type to "unmapped"`;

export interface LLMFieldMappingResponse {
  field_type: string;
  unit?: string;
  confidence: number;
  reason: string;
}

export interface LLMFieldMappingResult extends FieldMappingResult {
  llmInvoked: true;
  llmReason: string;
  llmRawResponse?: string;
}

/**
 * Trigger threshold — when regex confidence is below this, ask the LLM.
 * Tunable per deployment. Default 0.7 = the field is more guess than match.
 */
export const LLM_FALLBACK_THRESHOLD = 0.7;

/**
 * Classify a single field via Bedrock when regex confidence is low.
 *
 * Returns null if the LLM was unavailable / hallucinated an invalid type
 * (caller keeps the regex result, marked low-confidence).
 */
export async function llmFallbackMapField(
  fieldName: string,
  sampleValues: any[],
  contextHints: { vendor?: string; plantType?: 'PV' | 'BESS' | 'WIND' | 'HYBRID' } = {}
): Promise<LLMFieldMappingResult | null> {
  // Sample 5 values for the prompt (any more bloats tokens without adding info)
  const samples = sampleValues.slice(0, 5);

  const userPrompt = [
    `Column name: "${fieldName}"`,
    contextHints.vendor ? `Vendor hint: ${contextHints.vendor}` : null,
    contextHints.plantType ? `Asset type: ${contextHints.plantType}` : null,
    `Sample values: ${JSON.stringify(samples)}`,
    `\nReturn the canonical field type from the taxonomy.`,
  ]
    .filter(Boolean)
    .join('\n');

  let raw: string;
  try {
    raw = await invokeBedrock(userPrompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 200,
      temperature: 0.1,
      jsonMode: true,
    });
  } catch (err) {
    console.warn(`[field-mapping-llm] Bedrock error on "${fieldName}":`, err);
    return null;
  }

  const parsed = extractJson<LLMFieldMappingResponse>(raw);
  if (!parsed || typeof parsed.field_type !== 'string') {
    console.warn(`[field-mapping-llm] could not parse LLM response for "${fieldName}": ${raw.slice(0, 200)}`);
    return null;
  }

  // Validate against closed taxonomy
  if (!VALID_FIELD_TYPES.includes(parsed.field_type)) {
    console.warn(`[field-mapping-llm] LLM returned out-of-taxonomy type "${parsed.field_type}" for "${fieldName}" — rejecting`);
    return null;
  }

  const mappedType = parsed.field_type as DataFieldType;
  // Clamp LLM confidence to [0.5, 0.85]:
  //   - Floor 0.5: even if the LLM is "very sure", treat as ambiguous-needs-operator-confirmation
  //     since regex already failed (low signal field).
  //   - Ceiling 0.85: never let LLM confidence override a high-confidence regex match
  //     in downstream comparison logic.
  const confidence = Math.min(0.85, Math.max(0.5, parsed.confidence ?? 0.65));

  return {
    originalField: fieldName,
    mappedType,
    confidence,
    unit: parsed.unit,
    sampleValues: samples,
    confidenceFactors: {
      patternMatch: 0,
      unitMatch: 0,
      valueRange: 0,
      uniqueness: 0,
    },
    llmInvoked: true,
    llmReason: parsed.reason ?? '',
    llmRawResponse: raw,
  };
}

/**
 * Apply LLM fallback to a list of mapping results where regex confidence
 * was below the threshold. Results above threshold pass through unchanged.
 *
 * Concurrency-limited (default 3) so a 50-column file doesn't fire 50
 * parallel Bedrock calls.
 */
export async function llmPolishMappings(
  results: FieldMappingResult[],
  sampleValuesByField: Map<string, any[]>,
  options: {
    threshold?: number;
    contextHints?: { vendor?: string; plantType?: 'PV' | 'BESS' | 'WIND' | 'HYBRID' };
    concurrency?: number;
  } = {}
): Promise<{
  polished: FieldMappingResult[];
  llmCallsMade: number;
  llmAcceptedCount: number;
  llmRejectedCount: number;
}> {
  const threshold = options.threshold ?? LLM_FALLBACK_THRESHOLD;
  const concurrency = options.concurrency ?? 3;
  const ctx = options.contextHints ?? {};

  const toPolish = results
    .map((r, idx) => ({ idx, result: r }))
    .filter(({ result }) => result.confidence < threshold);

  let llmCallsMade = 0;
  let llmAcceptedCount = 0;
  let llmRejectedCount = 0;

  // Concurrency-limited polish loop
  const polished = [...results];
  for (let i = 0; i < toPolish.length; i += concurrency) {
    const batch = toPolish.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ idx, result }) => {
        const samples = sampleValuesByField.get(result.originalField) ?? result.sampleValues ?? [];
        llmCallsMade++;
        const llmResult = await llmFallbackMapField(result.originalField, samples, ctx);
        if (llmResult === null) {
          llmRejectedCount++;
          return { idx, result }; // keep regex result
        }
        // Only accept LLM if its confidence beats the regex result by 0.05+
        if (llmResult.confidence > result.confidence + 0.05) {
          llmAcceptedCount++;
          return { idx, result: llmResult };
        }
        llmRejectedCount++;
        return { idx, result };
      })
    );
    for (const { idx, result } of batchResults) {
      polished[idx] = result;
    }
  }

  return { polished, llmCallsMade, llmAcceptedCount, llmRejectedCount };
}
