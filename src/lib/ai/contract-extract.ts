import type { ContractType } from '@prisma/client';
import { invokeBedrock, extractJson, modelLabel } from '@/lib/ai/bedrock';
import {
  CONTRACT_TERM_FIELDS,
  isWithinBounds,
  type TermFieldDef,
} from '@/lib/contracts/term-fields';

/**
 * LLM contract-term extraction (TS port of the closed-schema design in
 * nuravolt/llm/warranty_extractor.py, generalized to all contract types).
 * The model may only emit fields from the type's vocabulary; numeric values
 * outside the physics bounds are rejected soft; source excerpts that are not
 * verbatim substrings of the document text are dropped and the term's
 * confidence capped, so the review UI never shows fabricated contract prose.
 * Runs on Vercel (one Bedrock call, ~EUR 0.001/document).
 */

export interface ExtractedTerm {
  field: string;
  value_numeric: number | null;
  unit: string | null;
  value_text: string | null;
  confidence: number; // 0-1
  source_excerpt: string | null;
  is_explicit: boolean;
}

export interface ContractExtractResult {
  terms: ExtractedTerm[];
  counterparty: string | null;
  effective_from: string | null; // YYYY-MM-DD
  effective_to: string | null;
  rejected_count: number;
  model_id: string;
}

const MAX_TEXT_CHARS = 30000;
const EXCERPT_MAX = 300;

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function excerptInText(excerpt: string, normalizedDoc: string): boolean {
  const n = normalize(excerpt);
  return n.length >= 10 && normalizedDoc.includes(n);
}

function fieldCatalog(defs: TermFieldDef[]): string {
  return defs
    .map((d) =>
      d.kind === 'numeric'
        ? `- ${d.field} (numeric, ${d.unit ?? 'unitless'}, plausible range ${d.min}-${d.max})`
        : `- ${d.field} (short text)`,
    )
    .join('\n');
}

function buildPrompt(contractType: ContractType, defs: TermFieldDef[], text: string): string {
  return `You extract structured terms from an energy-sector contract document.
Contract type: ${contractType}.

Allowed fields (emit ONLY these, at most once each; omit anything the document does not state):
${fieldCatalog(defs)}

Also identify, when stated: the counterparty (the other contracting party), the
effective start date and the end/expiry date.

Rules:
- Do not guess or infer values that are not in the document. If a value is
  derived indirectly (e.g. computed from other stated numbers), set
  "is_explicit": false.
- "source_excerpt" must be a VERBATIM quote from the document (max ${EXCERPT_MAX}
  characters) containing the value. Never paraphrase.
- "confidence" is 0 to 1: how certain you are the value is what the contract
  binds the parties to.
- Convert percentages to plain numbers (97% -> 97), durations to the field's
  unit.

Respond with only this JSON object:
{
  "counterparty": string | null,
  "effective_from": "YYYY-MM-DD" | null,
  "effective_to": "YYYY-MM-DD" | null,
  "terms": [
    {"field": "...", "value": number | string, "unit": string | null,
     "confidence": 0.0, "source_excerpt": "...", "is_explicit": true}
  ]
}

Document text:
"""
${text}
"""`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && ISO_DAY.test(v) ? v : null;

export async function extractContractTerms(
  documentText: string,
  contractType: ContractType,
): Promise<ContractExtractResult> {
  const defs = CONTRACT_TERM_FIELDS[contractType] ?? [];
  const text = documentText.slice(0, MAX_TEXT_CHARS);
  const normalizedDoc = normalize(text);

  const empty: ContractExtractResult = {
    terms: [],
    counterparty: null,
    effective_from: null,
    effective_to: null,
    rejected_count: 0,
    model_id: modelLabel(),
  };
  if (!defs.length || normalizedDoc.length < 50) return empty;

  let raw: string;
  try {
    raw = await invokeBedrock(buildPrompt(contractType, defs, text), {
      system:
        'You are a meticulous contract analyst. You only report terms the document actually states.',
      maxTokens: 2000,
      temperature: 0,
      jsonMode: true,
    });
  } catch (err) {
    // Fail soft like the Python extractor: the upload still succeeds and the
    // user enters terms manually in the review screen.
    console.error('contract-extract: Bedrock call failed', err);
    return empty;
  }

  const parsed = extractJson<{
    counterparty?: unknown;
    effective_from?: unknown;
    effective_to?: unknown;
    terms?: unknown;
  }>(raw);
  if (!parsed) return empty;

  const byField = new Map<string, TermFieldDef>(defs.map((d) => [d.field, d]));
  const seen = new Set<string>();
  const terms: ExtractedTerm[] = [];
  let rejected = 0;

  for (const item of Array.isArray(parsed.terms) ? parsed.terms : []) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const field = typeof t.field === 'string' ? t.field : '';
    const def = byField.get(field);
    if (!def || seen.has(field)) {
      rejected++;
      continue;
    }

    let valueNumeric: number | null = null;
    let valueText: string | null = null;
    if (def.kind === 'numeric') {
      const v = typeof t.value === 'number' ? t.value : Number(t.value);
      if (!isWithinBounds(def, v)) {
        rejected++;
        continue;
      }
      valueNumeric = v;
    } else {
      const v = typeof t.value === 'string' ? t.value.trim() : '';
      if (!v) {
        rejected++;
        continue;
      }
      valueText = v.slice(0, 500);
    }

    let confidence =
      typeof t.confidence === 'number' && Number.isFinite(t.confidence)
        ? Math.max(0, Math.min(1, t.confidence))
        : 0.5;
    let excerpt =
      typeof t.source_excerpt === 'string' ? t.source_excerpt.trim().slice(0, EXCERPT_MAX) : '';
    if (!excerpt || !excerptInText(excerpt, normalizedDoc)) {
      // Not a verbatim quote — drop it and treat the term as low-trust.
      excerpt = '';
      confidence = Math.min(confidence, 0.5);
    }

    seen.add(field);
    terms.push({
      field,
      value_numeric: valueNumeric,
      unit: def.unit ?? (typeof t.unit === 'string' ? t.unit : null),
      value_text: valueText,
      confidence: Math.round(confidence * 100) / 100,
      source_excerpt: excerpt || null,
      is_explicit: t.is_explicit !== false,
    });
  }

  return {
    terms,
    counterparty:
      typeof parsed.counterparty === 'string' && parsed.counterparty.trim()
        ? parsed.counterparty.trim().slice(0, 200)
        : null,
    effective_from: isoOrNull(parsed.effective_from),
    effective_to: isoOrNull(parsed.effective_to),
    rejected_count: rejected,
    model_id: modelLabel(),
  };
}
