import type { ShapedContract } from '@/lib/contracts/shape';

/**
 * Specimen contracts for fixture-only demo plants (no Plant row in the DB).
 * Values are grounded in the plant's existing static fixtures — boreas terms
 * mirror public/data/bess/boreas/warranty_status.json — never invented fresh
 * here. Source excerpts stay null: no PDF exists, and we don't fabricate
 * contract prose.
 */

const boreasBessWarranty: ShapedContract = {
  id: 'fixture-contract-boreas-bess-warranty',
  plantId: 'boreas',
  contractType: 'BESS_WARRANTY',
  title: 'Megapack capacity warranty',
  counterparty: 'Tesla Energy',
  status: 'ACTIVE',
  effectiveFrom: '2024-06-15',
  effectiveTo: '2039-06-15',
  hasSourceDocument: false,
  kbDocumentId: null,
  bessAssetId: 'bess-boreas-001',
  extractionModel: null,
  extractedAt: null,
  createdAt: '2024-06-15T00:00:00.000Z',
  terms: [
    // Mirrors warranty_terms in public/data/bess/boreas/warranty_status.json.
    { id: 'fx-boreas-soh', field: 'soh_eol_threshold_pct', label: 'Capacity guarantee', valueNumeric: 70, unit: '%', valueText: null, confidence: null, sourceExcerpt: null, isExplicit: true, status: 'CONFIRMED', monitored: true },
    { id: 'fx-boreas-years', field: 'warranty_years', label: 'Warranty period', valueNumeric: 15, unit: 'years', valueText: null, confidence: null, sourceExcerpt: null, isExplicit: true, status: 'CONFIRMED', monitored: false },
    { id: 'fx-boreas-cycles', field: 'cycle_count_warranty', label: 'Warranted cycles', valueNumeric: 6000, unit: 'cycles', valueText: null, confidence: null, sourceExcerpt: null, isExplicit: true, status: 'CONFIRMED', monitored: true },
    { id: 'fx-boreas-rte', field: 'min_rte_pct', label: 'Round-trip efficiency floor', valueNumeric: 86, unit: '%', valueText: null, confidence: null, sourceExcerpt: null, isExplicit: true, status: 'CONFIRMED', monitored: false },
    { id: 'fx-boreas-temp', field: 'max_temp_dwell_c', label: 'Max operating temperature', valueNumeric: 50, unit: 'C', valueText: null, confidence: null, sourceExcerpt: null, isExplicit: true, status: 'CONFIRMED', monitored: false },
  ],
};

const FIXTURE_CONTRACTS: Record<string, ShapedContract[]> = {
  boreas: [boreasBessWarranty],
};

export function fixtureContractsFor(plantId: string): ShapedContract[] {
  return FIXTURE_CONTRACTS[plantId] ?? [];
}
