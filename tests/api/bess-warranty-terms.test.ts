/**
 * A battery created through the setup path must be born with warranty terms,
 * and those terms must never read as a customer's contract when they are
 * chemistry defaults.
 *
 * Two things are load-bearing here:
 *
 *   1. The TypeScript baseline in scripts/add_bess_to_plant.ts is an exact
 *      mirror of WarrantyTermsConfig in nuravolt/bess/config.py. The Python
 *      pipeline divides cumulative cycles by warranty_terms.max_cycles to write
 *      BessWarrantyStatus.cycle_usage_pct, and the UI draws its cycle-budget
 *      bar from the terms row. Drift between the two puts two different budgets
 *      for one battery on one screen, so the drift test reads config.py and
 *      fails on any change to it that is not mirrored here.
 *
 *   2. Defaulted limits are labelled as defaults. Warranty defence is a product
 *      promise; presenting a chemistry ballpark as a guaranteed contractual
 *      floor would be a fabricated measurement in all but name.
 *
 * The HTTP case needs a live server (npm run test:api) and skips itself when no
 * publicly readable BESS plant answers.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CHEMISTRY_WARRANTY_OVERRIDES,
  WARRANTY_TERMS_BASELINE,
  resolveWarrantyTerms,
  warrantyBaselineFor,
  warrantyTermsProvenanceRecord,
  type WarrantyBaseline,
} from '../../scripts/add_bess_to_plant';

const BASE = (process.env.QA_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

// ── The Python mirror ──────────────────────────────────────────────────────

/** Field defaults declared on the WarrantyTermsConfig dataclass in config.py. */
function pythonWarrantyTermsDefaults(): Record<string, number | null> {
  const src = readFileSync(
    path.join(process.cwd(), 'nuravolt', 'bess', 'config.py'),
    'utf-8'
  );
  const start = src.indexOf('class WarrantyTermsConfig');
  expect(start, 'WarrantyTermsConfig not found in nuravolt/bess/config.py').toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n@dataclass');
  const block = end === -1 ? rest : rest.slice(0, end);

  const out: Record<string, number | null> = {};
  const field = /^ {4}(\w+)\s*:\s*[^=\n]+=\s*([^\s#]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = field.exec(block)) !== null) {
    const [, name, raw] = m;
    out[name] = raw === 'None' ? null : Number(raw);
  }
  return out;
}

describe('warranty baseline mirrors nuravolt/bess/config.py', () => {
  const python = pythonWarrantyTermsDefaults();

  it('parses the Python dataclass it is asserting against', () => {
    // Guard against a silently empty parse making the mirror test vacuous.
    expect(Object.keys(python).length).toBeGreaterThanOrEqual(16);
  });

  for (const key of Object.keys(WARRANTY_TERMS_BASELINE) as Array<keyof WarrantyBaseline>) {
    it(`${key} matches WarrantyTermsConfig`, () => {
      expect(python).toHaveProperty(key);
      expect(WARRANTY_TERMS_BASELINE[key]).toBe(python[key]);
    });
  }

  it('leaves the LFP baseline byte-identical to the shared default', () => {
    // Python is chemistry-agnostic today and scores every asset against these
    // numbers, so the default chemistry must not deviate.
    expect(CHEMISTRY_WARRANTY_OVERRIDES.LFP).toEqual({});
    expect(warrantyBaselineFor('LFP')).toEqual(WARRANTY_TERMS_BASELINE);
  });
});

// ── Resolution and provenance ──────────────────────────────────────────────

describe('resolveWarrantyTerms', () => {
  it('marks a fully defaulted row as a chemistry default, not a declaration', () => {
    const r = resolveWarrantyTerms('LFP', {});
    expect(r.source).toBe('chemistry_default');
    expect(r.declaredFields).toEqual([]);
    expect(r.defaultedFields).toHaveLength(Object.keys(WARRANTY_TERMS_BASELINE).length);
    expect(r.values).toEqual(WARRANTY_TERMS_BASELINE);
  });

  it('splits supplied limits from defaulted ones', () => {
    const r = resolveWarrantyTerms('LFP', {
      capacity_guarantee_pct: 0.65,
      warranty_years: 12,
      min_rte: 0.875,
    });
    expect(r.source).toBe('operator_declared');
    expect(r.declaredFields.sort()).toEqual([
      'capacity_guarantee_pct',
      'min_rte',
      'warranty_years',
    ]);
    expect(r.declaredFields).not.toContain('max_cycles');
    expect(r.defaultedFields).toContain('max_cycles');
    expect(r.values.capacity_guarantee_pct).toBe(0.65);
    expect(r.values.warranty_years).toBe(12);
    expect(r.values.min_rte).toBe(0.875);
    expect(r.values.max_cycles).toBe(WARRANTY_TERMS_BASELINE.max_cycles);
  });

  it('treats an absent throughput cap as the default, not a declaration', () => {
    // null is how "no throughput limit" is expressed and is also the baseline,
    // so it must not be reported as something the caller guaranteed.
    const r = resolveWarrantyTerms('LFP', { max_throughput_mwh: null });
    expect(r.declaredFields).toEqual([]);
    expect(r.defaultedFields).toContain('max_throughput_mwh');
  });

  it('varies only cycle life and the cell voltage window by chemistry', () => {
    for (const chem of ['NMC', 'NCA', 'LTO'] as const) {
      const varied = Object.entries(warrantyBaselineFor(chem))
        .filter(([k, v]) => v !== WARRANTY_TERMS_BASELINE[k as keyof WarrantyBaseline])
        .map(([k]) => k)
        .sort();
      expect(varied).toEqual(['cell_voltage_max_v', 'cell_voltage_min_v', 'max_cycles']);
    }
    expect(warrantyBaselineFor('LTO').max_cycles).toBeGreaterThan(
      warrantyBaselineFor('NMC').max_cycles
    );
    for (const chem of ['LFP', 'NMC', 'NCA', 'LTO'] as const) {
      const b = warrantyBaselineFor(chem);
      expect(b.cell_voltage_max_v).toBeGreaterThan(b.cell_voltage_min_v);
    }
  });
});

describe('warrantyTermsProvenanceRecord', () => {
  it('never claims a defaulted row came from a contract', () => {
    for (const supplied of [{}, { warranty_years: 12 }]) {
      const resolved = resolveWarrantyTerms('LFP', supplied);
      const record = warrantyTermsProvenanceRecord(resolved, 'LFP', new Date('2026-08-04'));
      const prov = record.provenance as Record<string, unknown>;
      expect(prov.is_contract_derived).toBe(false);
      expect(prov.source).not.toBe('contract');
      // The note has to deny the warranty document outright, in either phrasing.
      expect(String(prov.note).toLowerCase()).toMatch(
        /not this asset's warranty document|no warranty document has been read/
      );
      expect(prov.basis).toContain('WarrantyTermsConfig');
    }
  });

  it('records exactly which columns were supplied and which were defaulted', () => {
    const resolved = resolveWarrantyTerms('NMC', { max_cycles: 4200 });
    const prov = warrantyTermsProvenanceRecord(resolved, 'NMC', new Date()).provenance as Record<
      string,
      unknown
    >;
    expect(prov.declared_fields).toEqual(['max_cycles']);
    expect(prov.defaulted_fields).not.toContain('max_cycles');
    expect(prov.chemistry).toBe('NMC');
  });
});

// ── The API surface ────────────────────────────────────────────────────────

const CANDIDATES = [
  process.env.QA_BESS_PLANT,
  'ribera',
  'region_a-storage',
  'athi-storage',
].filter((s): s is string => Boolean(s));

let payload: any = null;
let probedSlug = '';

beforeAll(async () => {
  for (const slug of CANDIDATES) {
    try {
      const res = await fetch(
        `${BASE}/api/bess/plants/${slug}/assets/probe/warranty`
      );
      if (res.status !== 200) continue;
      const body = await res.json();
      if (body?._source !== 'database') continue;
      payload = body;
      probedSlug = slug;
      break;
    } catch {
      /* server down; the cases below skip themselves */
    }
  }
  if (!payload) {
    console.warn(
      `[bess-warranty-terms] no publicly readable BESS plant answered on ${BASE} (tried ${CANDIDATES.join(', ')}); HTTP assertions skipped`
    );
  }
});

describe('GET /api/bess/plants/:plant/assets/:asset/warranty', () => {
  it('serves warranty terms for a database-backed asset', () => {
    if (!payload) return;
    // The regression this guards: an asset created by the setup path used to
    // arrive with no BessWarrantyTerms row, so terms came back null and the
    // whole 4-axis tracker rendered "warranty status unavailable".
    expect(payload.terms, `${probedSlug} has no warranty terms`).not.toBeNull();
    expect(payload.terms.capacityGuaranteePct).toBeGreaterThan(0);
    expect(payload.terms.warrantyYears).toBeGreaterThan(0);
    expect(payload.terms.maxCycles).toBeGreaterThan(0);
  });

  it('labels where those terms came from', () => {
    if (!payload) return;
    expect(payload.termsProvenance).not.toBeNull();
    const p = payload.termsProvenance;
    expect(['contract', 'operator_declared', 'chemistry_default', 'unspecified']).toContain(
      p.source
    );
    expect(typeof p.label).toBe('string');
    expect(p.label.length).toBeGreaterThan(0);
    // Copy rules: no dashes as separators, no emoji.
    expect(p.label).not.toMatch(/[—–]| - /);
    expect(Array.isArray(p.declaredFields)).toBe(true);
    expect(Array.isArray(p.defaultedFields)).toBe(true);
  });

  it('only claims a contract when a contract is actually on file', () => {
    if (!payload) return;
    const p = payload.termsProvenance;
    expect(p.isContractDerived).toBe(p.source === 'contract');
    if (p.source !== 'contract') {
      expect(p.contract).toBeNull();
      expect(p.label.toLowerCase()).not.toContain('from the warranty contract');
    } else {
      expect(p.contract).not.toBeNull();
      expect(typeof p.contract.id).toBe('string');
    }
  });

  it('keeps the fields existing consumers already read', () => {
    if (!payload) return;
    // Additive change only: useBESSData and OpsBattery read these.
    expect(payload).toHaveProperty('assetId');
    expect(payload).toHaveProperty('status');
    expect(payload).toHaveProperty('healthScore');
    expect(payload).toHaveProperty('history');
    expect(payload.metadata).toHaveProperty('generatedAt');
  });
});
