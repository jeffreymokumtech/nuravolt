/**
 * AI Modbus register-map auto-mapper.
 *
 * Zero-touch mapping for on-prem Modbus/SCADA sources: given the text of an
 * OEM datasheet (PDF-extracted) or a SCADA register export (CSV/TSV), produce
 * a structured register map with each register assigned to the closed
 * DataFieldType taxonomy.
 *
 * Two paths:
 *   1. Deterministic CSV fast path — if the input parses as a delimited
 *      register table (address + name columns), rows are parsed directly and
 *      the LLM is only used for one batched mapped_field assignment call.
 *      Cheaper and more accurate than free-text extraction.
 *   2. LLM full extraction — datasheet prose/tables are prefiltered to the
 *      register-table region and sent to Bedrock (jsonMode) with a closed
 *      output schema. Every row is validated: address integer >= 0, dataType
 *      whitelisted, mapped_field in-taxonomy else 'unmapped', confidence
 *      clamped to [0.5, 0.85] (same discipline as field-mapping-llm.ts).
 *
 * Env gate: NURAVOLT_LLM_FIELD_MAPPING_ENABLED !== '0' (shared with the
 * discover-route LLM polish pass). When disabled, the CSV path still works
 * with heuristic name matching via FieldMappingIntelligence.
 *
 * The live Modbus TCP client (modbus-service.ts) is out of scope — this
 * module only turns documents into FieldMapping-shaped register maps.
 */

import { extractJson, invokeBedrock } from './bedrock';
import type { BedrockOptions } from './bedrock';
import { FieldMappingIntelligence } from '../services/field-mapping-intelligence';
import {
  VALID_FIELD_TYPES,
  VALID_DATA_TYPES,
  MAX_SOURCE_CHARS,
  clampLlmConfidence,
  parseRegisterCsv,
  prefilterRegisterText,
  validateExtractedRegister,
} from './register-map-schema';
import type { ExtractedRegister, RegisterMapResult } from './register-map-schema';

export type { ExtractedRegister, RegisterMapResult } from './register-map-schema';

// ---------------------------------------------------------------------------
// Options / injection
// ---------------------------------------------------------------------------

/** invokeBedrock-shaped callable — injectable for tests (mirrors the
 *  fetchImpl injection pattern in huawei-api-service.ts). */
export type BedrockInvoke = (userPrompt: string, opts?: BedrockOptions) => Promise<string>;

export interface ExtractRegisterMapOptions {
  /** Vendor hint (e.g. Modbus preset id: 'sma', 'sungrow', 'huawei') */
  vendorHint?: string;
  /** Injectable Bedrock invoke for tests. Defaults to the real invokeBedrock. */
  invokeImpl?: BedrockInvoke;
  /** Max chars of source text sent to the LLM (default 24k). */
  maxSourceChars?: number;
}

export function isLlmMappingEnabled(): boolean {
  return process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED !== '0';
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a Modbus register-map extraction expert for solar PV inverters, BESS battery storage and wind SCADA equipment. You read OEM datasheets and register-map documentation (SMA, Huawei SUN2000, Sungrow SG, Fronius, SolarEdge/SunSpec, GoodWe, ABB, generic SCADA) and extract a structured register map.

For every telemetry/measurement register in the source, emit one entry. Skip write-only configuration registers and long ASCII blocks (serial numbers, firmware strings) unless they identify the device.

Each register must be mapped to the CLOSED TAXONOMY below — exact strings, lowercase, no invented members. If a register does not correspond to any taxonomy member, set mapped_field to "unmapped".

CLOSED TAXONOMY:
${VALID_FIELD_TYPES.join(', ')}

DATA TYPE WHITELIST (use exactly one per register):
${VALID_DATA_TYPES.join(', ')}

Rules:
- "address" must be the decimal register address (convert hex like 0x7863 to decimal). Use the documented Modbus address as printed; do not invent offsets.
- "scale" is the multiplier from raw register value to the engineering unit (a documented gain of 10 means raw/10 -> scale 0.1; gain 0.1 means scale 0.1 only if the doc defines gain as the multiplier — read carefully).
- "byteOrder" only when the document states it (e.g. "big-endian", "word-swapped").
- Phase quantities: map L1/A-phase voltage to voltage_ac_l1, etc.
- "source_excerpt" is a short verbatim snippet (<= 150 chars) from the source that justifies the row.

Output strict JSON only, no prose:
{
  "vendor": "<manufacturer or null>",
  "model": "<device model or null>",
  "notes": "<one-sentence caveats for an operator>",
  "registers": [
    {
      "address": <int>,
      "name": "<register name from the doc>",
      "dataType": "<whitelist member>",
      "unit": "<W|kW|V|A|Hz|°C|%|kWh|...>",
      "scale": <number, omit if 1>,
      "byteOrder": "<only if documented>",
      "mapped_field": "<taxonomy member or unmapped>",
      "confidence": <0.0-1.0>,
      "source_excerpt": "<verbatim snippet>"
    }
  ]
}

Confidence guidance:
  0.95+ = register name + unit + address all unambiguous
  0.75-0.95 = strong signal but some interpretation
  0.55-0.75 = best guess from limited info
  <0.55 = genuinely uncertain -> set mapped_field to "unmapped"`;

const ASSIGN_SYSTEM_PROMPT = `You are a SCADA field-mapping expert for solar PV, BESS battery storage and wind energy systems. You will receive a JSON list of Modbus registers (name, address, dataType, unit, scale) already parsed from a vendor register export. Assign each register a canonical field type from the CLOSED TAXONOMY below — exact strings, lowercase, no invented members.

CLOSED TAXONOMY:
${VALID_FIELD_TYPES.join(', ')}

Rules:
- Use the register name and unit together (e.g. "Active power" + "kW" -> power_ac; "DC voltage" -> voltage_dc).
- Phase quantities: L1/A-phase AC voltage -> voltage_ac_l1, etc.
- If nothing in the taxonomy matches, return "unmapped".
- Return one assignment per input index. Do not skip indices.

Output strict JSON only, no prose:
{
  "assignments": [
    { "index": <int, matching the input>, "mapped_field": "<taxonomy member or unmapped>", "confidence": <0.0-1.0>, "unit": "<optional unit if the input lacked one>" }
  ]
}

Confidence guidance:
  0.95+ = name + unit both unambiguous
  0.75-0.95 = strong signal but some interpretation
  0.55-0.75 = best guess
  <0.55 = genuinely uncertain -> "unmapped"`;

// ---------------------------------------------------------------------------
// Heuristic (non-LLM) assignment — reuses FieldMappingIntelligence scoring
// ---------------------------------------------------------------------------

function heuristicAssignFields(
  registers: ExtractedRegister[],
  vendorHint?: string
): ExtractedRegister[] {
  const intelligence = new FieldMappingIntelligence();
  return registers.map(reg => {
    // Fold the unit into the probe string so the intelligence layer's
    // unit-match boost applies (it inspects the field name only).
    const probe = reg.unit ? `${reg.name} (${reg.unit})` : reg.name;
    const match = intelligence.mapField(probe, [], vendorHint ? { vendor: vendorHint } : undefined);
    const mapped = String(match.mappedType);
    return {
      ...reg,
      mapped_field: VALID_FIELD_TYPES.includes(mapped) ? mapped : 'unmapped',
      confidence: mapped === 'unmapped' ? 0 : match.confidence,
      unit: reg.unit ?? match.unit,
    };
  });
}

// ---------------------------------------------------------------------------
// LLM batched mapped_field assignment (CSV fast path)
// ---------------------------------------------------------------------------

const ASSIGN_BATCH_SIZE = 100;

interface LLMAssignment {
  index: number;
  mapped_field: string;
  confidence: number;
  unit?: string;
}

async function llmAssignFields(
  registers: ExtractedRegister[],
  vendorHint: string | undefined,
  invoke: BedrockInvoke
): Promise<ExtractedRegister[]> {
  const out = registers.map(r => ({ ...r }));
  const intelligence = new FieldMappingIntelligence();

  for (let offset = 0; offset < out.length; offset += ASSIGN_BATCH_SIZE) {
    const batch = out.slice(offset, offset + ASSIGN_BATCH_SIZE);

    const userPrompt = [
      vendorHint ? `Vendor hint: ${vendorHint}` : null,
      'Registers:',
      JSON.stringify(
        batch.map((r, j) => ({
          index: j,
          name: r.name,
          address: r.address,
          dataType: r.dataType,
          unit: r.unit,
          scale: r.scale,
        }))
      ),
      '\nAssign each register a field type from the taxonomy.',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await invoke(userPrompt, {
      system: ASSIGN_SYSTEM_PROMPT,
      maxTokens: 3000,
      temperature: 0.1,
      jsonMode: true,
    });

    const parsed = extractJson<{ assignments: LLMAssignment[] }>(raw);
    if (!parsed || !Array.isArray(parsed.assignments)) {
      throw new Error(
        `[register-map-llm] could not parse assignment response: ${String(raw).slice(0, 200)}`
      );
    }

    const assigned = new Set<number>();
    for (const a of parsed.assignments) {
      const j = Number(a?.index);
      if (!Number.isInteger(j) || j < 0 || j >= batch.length) continue;
      const mapped =
        typeof a.mapped_field === 'string' && VALID_FIELD_TYPES.includes(a.mapped_field)
          ? a.mapped_field
          : 'unmapped'; // reject out-of-taxonomy hallucinations
      batch[j].mapped_field = mapped;
      batch[j].confidence = clampLlmConfidence(a.confidence);
      if (!batch[j].unit && typeof a.unit === 'string' && a.unit.trim()) {
        batch[j].unit = a.unit.trim().slice(0, 16);
      }
      assigned.add(j);
    }

    // Rows the LLM skipped fall back to heuristic matching so no register is
    // left with a stale placeholder.
    for (let j = 0; j < batch.length; j++) {
      if (assigned.has(j)) continue;
      const probe = batch[j].unit ? `${batch[j].name} (${batch[j].unit})` : batch[j].name;
      const match = intelligence.mapField(probe, [], vendorHint ? { vendor: vendorHint } : undefined);
      const mapped = String(match.mappedType);
      batch[j].mapped_field = VALID_FIELD_TYPES.includes(mapped) ? mapped : 'unmapped';
      batch[j].confidence = mapped === 'unmapped' ? 0 : match.confidence;
    }
    // batch entries are references into `out`, so mutations are already applied
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

interface LLMRegisterMapResponse {
  vendor?: string | null;
  model?: string | null;
  notes?: string | null;
  registers: unknown[];
}

/**
 * Extract a structured Modbus register map from source text (datasheet text
 * or register export). Deterministic CSV path first; LLM full extraction as
 * the fallback for free-text/PDF sources.
 */
export async function extractRegisterMap(
  sourceText: string,
  opts: ExtractRegisterMapOptions = {}
): Promise<RegisterMapResult> {
  const invoke = opts.invokeImpl ?? invokeBedrock;

  if (!sourceText || !sourceText.trim()) {
    return { registers: [], method: 'none', notes: 'Empty source text.' };
  }

  // ── 1. Deterministic CSV/TSV fast path ──
  const csv = parseRegisterCsv(sourceText);
  if (csv) {
    let registers = csv.registers;
    let method: RegisterMapResult['method'] = 'csv+heuristic';
    let notes =
      `Deterministic CSV parse: ${registers.length} register rows` +
      (csv.skippedRows > 0 ? ` (${csv.skippedRows} skipped: bad address or empty name).` : '.');

    if (isLlmMappingEnabled()) {
      try {
        registers = await llmAssignFields(registers, opts.vendorHint, invoke);
        method = 'csv+llm';
      } catch (err) {
        console.warn('[register-map-llm] batch assignment failed, using heuristics:', err);
        registers = heuristicAssignFields(registers, opts.vendorHint);
        notes += ' LLM assignment unavailable — heuristic name matching used.';
      }
    } else {
      registers = heuristicAssignFields(registers, opts.vendorHint);
      notes += ' LLM disabled — heuristic name matching used.';
    }

    return { registers, vendor: opts.vendorHint, method, notes };
  }

  // ── 2. LLM full extraction ──
  if (!isLlmMappingEnabled()) {
    return {
      registers: [],
      method: 'none',
      notes:
        'Source is not a parsable register CSV and LLM extraction is disabled ' +
        '(NURAVOLT_LLM_FIELD_MAPPING_ENABLED=0). Upload a CSV register export instead.',
    };
  }

  const filtered = prefilterRegisterText(sourceText, opts.maxSourceChars ?? MAX_SOURCE_CHARS);
  const userPrompt = [
    opts.vendorHint ? `Vendor hint: ${opts.vendorHint}` : null,
    'Source document:',
    '"""',
    filtered,
    '"""',
    '\nExtract the Modbus register map.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await invoke(userPrompt, {
    system: EXTRACTION_SYSTEM_PROMPT,
    maxTokens: 4000,
    temperature: 0.1,
    jsonMode: true,
  });

  const parsed = extractJson<LLMRegisterMapResponse>(raw);
  if (!parsed || !Array.isArray(parsed.registers)) {
    throw new Error(
      `[register-map-llm] could not parse extraction response: ${String(raw).slice(0, 200)}`
    );
  }

  const registers: ExtractedRegister[] = [];
  let rejected = 0;
  for (const row of parsed.registers) {
    const validated = validateExtractedRegister(row);
    if (validated) registers.push(validated);
    else rejected++;
  }

  const notes = [
    typeof parsed.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : null,
    rejected > 0 ? `${rejected} row(s) rejected during validation.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    registers,
    vendor:
      typeof parsed.vendor === 'string' && parsed.vendor.trim()
        ? parsed.vendor.trim()
        : opts.vendorHint,
    model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined,
    method: 'llm',
    notes: notes || undefined,
  };
}
