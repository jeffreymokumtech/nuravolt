import type { PrismaClient } from '@prisma/client';

/**
 * One-way sync of a confirmed BESS contract's numeric terms into
 * BessWarrantyTerms. The Contract row is the document/provenance record; the
 * BESS guardian (warranty routes, violation detector, dossier) keeps reading
 * BessWarrantyTerms as its single source of numeric truth. Runs at confirm
 * time only — later edits to BessWarrantyTerms are not written back.
 *
 * Mapping is keyed on the term field name, not the contract type, so an
 * operating term that appears on a tolling agreement (min_rte_pct,
 * max_cycles_per_year) lands in the same columns. Two schema facts constrain
 * that, both confirmed against prisma/schema.prisma:
 *
 *   min_rte     exists, fraction units. Direct target for min_rte_pct.
 *   max_cycles  exists but is a *lifetime* equivalent-full-cycle budget, so a
 *               per-year operating cap needs a term length to convert, exactly
 *               like max_throughput_mwh_per_year. It is also the warranty's
 *               own budget, so a tolling-derived number must never overwrite a
 *               value that is already there.
 *
 * There is no per-year cycle column, and this function does not invent one.
 */

export interface ConfirmedTermInput {
  field: string;
  value_numeric: number | null;
  status: string; // only CONFIRMED terms are applied
}

export interface BessTermsUpdate {
  capacity_guarantee_pct?: number;
  warranty_years?: number;
  max_cycles?: number;
  max_throughput_mwh?: number;
  min_rte?: number;
  operating_temp_max_c?: number;
  max_c_rate_continuous?: number;
  max_c_rate_peak?: number;
  soc_hold_limit_hours?: number;
}

export interface BessSyncResult {
  update: BessTermsUpdate;
  applied: string[];
  skipped: string[];
}

/**
 * Pure mapping from contract-term vocabulary (percent units) to the
 * BessWarrantyTerms columns (fraction units). Throughput is contracted per
 * year — the DB column is a lifetime total, so it needs warranty_years (from
 * the same contract or the existing row) to convert; otherwise skipped.
 */
export function bessTermsUpdateFromContract(
  terms: ConfirmedTermInput[],
  opts: { existingWarrantyYears?: number | null; existingMaxCycles?: number | null } = {},
): BessSyncResult {
  const confirmed = new Map<string, number>();
  for (const t of terms) {
    if (t.status === 'CONFIRMED' && t.value_numeric != null && Number.isFinite(t.value_numeric)) {
      confirmed.set(t.field, t.value_numeric);
    }
  }

  const update: BessTermsUpdate = {};
  const applied: string[] = [];
  const skipped: string[] = [];
  const take = (field: string, apply: (v: number) => void) => {
    const v = confirmed.get(field);
    if (v == null) return;
    apply(v);
    applied.push(field);
  };

  take('soh_eol_threshold_pct', (v) => { update.capacity_guarantee_pct = v / 100; });
  take('warranty_years', (v) => { update.warranty_years = Math.round(v); });
  take('cycle_count_warranty', (v) => { update.max_cycles = Math.round(v); });
  take('min_rte_pct', (v) => { update.min_rte = v / 100; });
  take('max_temp_dwell_c', (v) => { update.operating_temp_max_c = v; });
  take('max_c_rate_charge', (v) => { update.max_c_rate_continuous = v; });
  take('max_c_rate_discharge', (v) => { update.max_c_rate_peak = v; });
  take('soc_high_dwell_hours', (v) => { update.soc_hold_limit_hours = Math.round(v); });

  // Per-year cycle cap (tolling) into the lifetime EFC budget column. Refuses
  // to write when a budget is already present: max_cycles is what the warranty
  // guardian raises violations against, and a tolling cap is a different
  // promise from a different counterparty.
  const cyclesPerYear = confirmed.get('max_cycles_per_year');
  if (cyclesPerYear != null) {
    const years =
      update.warranty_years ?? confirmed.get('agreement_years') ?? opts.existingWarrantyYears ?? null;
    if (update.max_cycles != null || opts.existingMaxCycles != null) {
      skipped.push(
        'max_cycles_per_year (a warranted lifetime cycle budget is already on file; an operating cap must not overwrite it)',
      );
    } else if (years && years > 0) {
      update.max_cycles = Math.round(cyclesPerYear * years);
      applied.push('max_cycles_per_year');
    } else {
      skipped.push(
        'max_cycles_per_year (no warranty_years or agreement_years to convert the per-year cap into the lifetime budget column)',
      );
    }
  }

  const throughputPerYear = confirmed.get('max_throughput_mwh_per_year');
  if (throughputPerYear != null) {
    const years = update.warranty_years ?? opts.existingWarrantyYears ?? null;
    if (years && years > 0) {
      update.max_throughput_mwh = Math.round(throughputPerYear * years * 100) / 100;
      applied.push('max_throughput_mwh_per_year');
    } else {
      skipped.push('max_throughput_mwh_per_year (no warranty_years to convert per-year cap)');
    }
  }

  for (const field of Array.from(confirmed.keys())) {
    if (!applied.some((a) => a.startsWith(field)) && !skipped.some((s) => s.startsWith(field))) {
      skipped.push(`${field} (no BessWarrantyTerms mapping)`);
    }
  }

  return { update, applied, skipped };
}

/**
 * Apply a confirmed contract to its linked BessAsset's warranty terms.
 * Creating a row requires the schema's non-null trio (capacity guarantee,
 * warranty years, effective_from); when a contract lacks them and no row
 * exists, the sync reports itself skipped rather than inventing defaults.
 */
export async function syncContractToBessWarrantyTerms(
  prisma: PrismaClient,
  contract: {
    id: string;
    bess_asset_id: string | null;
    effective_from: Date | null;
    terms: ConfirmedTermInput[];
  },
): Promise<BessSyncResult & { synced: boolean; reason?: string }> {
  if (!contract.bess_asset_id) {
    return { update: {}, applied: [], skipped: [], synced: false, reason: 'no_bess_asset' };
  }
  const existing = await prisma.bessWarrantyTerms.findUnique({
    where: { asset_id: contract.bess_asset_id },
  });
  const result = bessTermsUpdateFromContract(contract.terms, {
    existingWarrantyYears: existing ? existing.warranty_years : null,
    existingMaxCycles: existing?.max_cycles == null ? null : Number(existing.max_cycles),
  });
  if (!Object.keys(result.update).length) {
    return { ...result, synced: false, reason: 'no_mappable_terms' };
  }

  if (existing) {
    await prisma.bessWarrantyTerms.update({
      where: { asset_id: contract.bess_asset_id },
      data: result.update,
    });
    return { ...result, synced: true };
  }

  const capacity = result.update.capacity_guarantee_pct;
  const years = result.update.warranty_years;
  if (capacity == null || years == null) {
    return {
      ...result,
      synced: false,
      reason: 'missing_required_terms_for_create (capacity guarantee + warranty years)',
    };
  }
  const asset = await prisma.bessAsset.findUnique({ where: { id: contract.bess_asset_id } });
  await prisma.bessWarrantyTerms.create({
    data: {
      asset_id: contract.bess_asset_id,
      ...result.update,
      capacity_guarantee_pct: capacity,
      warranty_years: years,
      effective_from: contract.effective_from ?? asset?.installation_date ?? new Date(),
    },
  });
  return { ...result, synced: true };
}
