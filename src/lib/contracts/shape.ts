import type { Contract, ContractTerm } from '@prisma/client';
import { termFieldDef } from './term-fields';

/** Wire shape for a contract term (camelCase, labels resolved). */
export interface ShapedContractTerm {
  id: string;
  field: string;
  label: string;
  valueNumeric: number | null;
  unit: string | null;
  valueText: string | null;
  confidence: number | null;
  sourceExcerpt: string | null;
  isExplicit: boolean;
  status: string;
  monitored: boolean;
}

export interface ShapedContract {
  id: string;
  plantId: string;
  contractType: string;
  title: string;
  counterparty: string | null;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  hasSourceDocument: boolean;
  kbDocumentId: string | null;
  bessAssetId: string | null;
  extractionModel: string | null;
  extractedAt: string | null;
  createdAt: string;
  terms: ShapedContractTerm[];
}

const isoDay = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function shapeContractTerm(
  contractType: Contract['contract_type'],
  t: ContractTerm,
): ShapedContractTerm {
  const def = termFieldDef(contractType, t.field);
  return {
    id: t.id,
    field: t.field,
    label: def?.label ?? t.field.replace(/_/g, ' '),
    valueNumeric: t.value_numeric == null ? null : Number(t.value_numeric),
    unit: t.unit ?? def?.unit ?? null,
    valueText: t.value_text,
    confidence: t.confidence == null ? null : Number(t.confidence),
    sourceExcerpt: t.source_excerpt,
    isExplicit: t.is_explicit,
    status: t.status,
    monitored: t.monitored,
  };
}

export function shapeContract(
  c: Contract & { terms: ContractTerm[] },
  plantSlug: string,
): ShapedContract {
  return {
    id: c.id,
    plantId: plantSlug,
    contractType: c.contract_type,
    title: c.title,
    counterparty: c.counterparty,
    status: c.status,
    effectiveFrom: isoDay(c.effective_from),
    effectiveTo: isoDay(c.effective_to),
    hasSourceDocument: c.source_s3_key != null,
    kbDocumentId: c.kb_document_id,
    bessAssetId: c.bess_asset_id,
    extractionModel: c.extraction_model,
    extractedAt: c.extracted_at ? c.extracted_at.toISOString() : null,
    createdAt: c.created_at.toISOString(),
    terms: c.terms.map((t) => shapeContractTerm(c.contract_type, t)),
  };
}
