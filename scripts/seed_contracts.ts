/**
 * Seed contract-intelligence rows (arc 11):
 *
 * 1. BESS backfill — every BessAsset that already has BessWarrantyTerms gets
 *    a BESS_WARRANTY Contract whose terms mirror the existing numbers
 *    (reverse of bess-sync.ts). No source excerpts are fabricated: the
 *    detail view renders "terms on file, source document not uploaded".
 * 2. PV specimen contracts (PPA + module warranty + O&M SLA) for one demo
 *    plant so the Contracts tab has a full story. Counterparties are
 *    fictional; term values are industry-typical, clearly specimen.
 *
 * Idempotent: keyed by (plant, type, title); seeded rows carry
 * created_by_clerk_id='seed:contracts'. Flags:
 *
 *   npx tsx scripts/seed_contracts.ts [--pv-plant=<slug>] [--wipe]
 *   DATABASE_URL=<prod> npx tsx scripts/seed_contracts.ts --pv-plant=ribera-solar
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

import { PrismaClient, ContractType } from '@prisma/client';

const prisma = new PrismaClient();
const SEED_TAG = 'seed:contracts';

const argFlag = (name: string): string | boolean | undefined => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

interface SeedTerm {
  field: string;
  value_numeric?: number;
  unit?: string;
  value_text?: string;
  monitored?: boolean;
}

async function ensureContract(opts: {
  plantId: string;
  orgClerkId: string | null;
  type: ContractType;
  title: string;
  counterparty: string;
  effectiveFrom: Date;
  effectiveTo?: Date;
  bessAssetId?: string;
  terms: SeedTerm[];
}) {
  const existing = await prisma.contract.findFirst({
    where: { plant_id: opts.plantId, contract_type: opts.type, title: opts.title },
  });
  if (existing) {
    console.log(`= exists: ${opts.title}`);
    return existing;
  }
  const contract = await prisma.contract.create({
    data: {
      plant_id: opts.plantId,
      org_clerk_id: opts.orgClerkId,
      contract_type: opts.type,
      title: opts.title,
      counterparty: opts.counterparty,
      status: 'ACTIVE',
      effective_from: opts.effectiveFrom,
      effective_to: opts.effectiveTo ?? null,
      bess_asset_id: opts.bessAssetId ?? null,
      created_by_clerk_id: SEED_TAG,
      terms: {
        create: opts.terms.map((t) => ({
          field: t.field,
          value_numeric: t.value_numeric ?? null,
          unit: t.unit ?? null,
          value_text: t.value_text ?? null,
          confidence: null, // entered from records, not extracted
          source_excerpt: null,
          is_explicit: true,
          status: 'CONFIRMED',
          monitored: t.monitored ?? false,
          confirmed_by_clerk_id: SEED_TAG,
          confirmed_at: new Date(),
        })),
      },
    },
  });
  console.log(`+ ${opts.type} contract: ${opts.title} (${contract.id})`);
  return contract;
}

/** BESS backfill: Contract rows FROM existing BessWarrantyTerms. */
async function backfillBessContracts() {
  const assets = await prisma.bessAsset.findMany({
    include: {
      warranty_terms: true,
      plant: { include: { organization: { select: { clerk_org_id: true } } } },
    },
  });
  for (const a of assets) {
    const wt = a.warranty_terms;
    if (!wt) continue;
    const name = a.name ?? a.external_asset_id;
    const terms: SeedTerm[] = [
      {
        field: 'soh_eol_threshold_pct',
        value_numeric: Math.round(Number(wt.capacity_guarantee_pct) * 10000) / 100,
        unit: '%',
        monitored: true,
      },
      { field: 'warranty_years', value_numeric: wt.warranty_years, unit: 'years' },
    ];
    if (wt.max_cycles != null) {
      terms.push({ field: 'cycle_count_warranty', value_numeric: wt.max_cycles, unit: 'cycles', monitored: true });
    }
    if (wt.min_rte != null) {
      terms.push({ field: 'min_rte_pct', value_numeric: Math.round(Number(wt.min_rte) * 10000) / 100, unit: '%' });
    }
    if (wt.operating_temp_max_c != null) {
      terms.push({ field: 'max_temp_dwell_c', value_numeric: Number(wt.operating_temp_max_c), unit: 'C' });
    }
    if (wt.max_c_rate_continuous != null) {
      terms.push({ field: 'max_c_rate_charge', value_numeric: Number(wt.max_c_rate_continuous), unit: 'C' });
    }
    if (wt.max_c_rate_peak != null) {
      terms.push({ field: 'max_c_rate_discharge', value_numeric: Number(wt.max_c_rate_peak), unit: 'C' });
    }
    if (wt.soc_hold_limit_hours != null) {
      terms.push({ field: 'soc_high_dwell_hours', value_numeric: wt.soc_hold_limit_hours, unit: 'hours' });
    }
    await ensureContract({
      plantId: a.plant_id,
      orgClerkId: a.plant.organization?.clerk_org_id ?? null,
      type: 'BESS_WARRANTY',
      title: `${name} capacity warranty`,
      counterparty: a.manufacturer ?? 'Manufacturer on record',
      effectiveFrom: wt.effective_from,
      effectiveTo: new Date(
        new Date(wt.effective_from).setFullYear(wt.effective_from.getFullYear() + wt.warranty_years),
      ),
      bessAssetId: a.id,
      terms,
    });
  }
}

/** PV specimen contracts (fictional counterparties, industry-typical terms). */
async function seedPvContracts(slug: string) {
  const plant = await prisma.plant.findUnique({
    where: { slug },
    include: { organization: { select: { clerk_org_id: true } } },
  });
  if (!plant) {
    console.log(`PV plant '${slug}' not found — skipping specimen contracts.`);
    return;
  }
  const org = plant.organization?.clerk_org_id ?? null;
  const commissioned = plant.commissioning_date ?? new Date('2023-01-01');
  const plus = (d: Date, years: number) => new Date(new Date(d).setFullYear(d.getFullYear() + years));

  await ensureContract({
    plantId: plant.id,
    orgClerkId: org,
    type: 'PPA',
    title: 'Power purchase agreement',
    counterparty: 'Meseta Energy Trading',
    effectiveFrom: commissioned,
    effectiveTo: plus(commissioned, 10),
    terms: [
      { field: 'price_eur_mwh', value_numeric: 52, unit: 'EUR/MWh' },
      { field: 'price_mechanism', value_text: 'Fixed price, indexed annually' },
      { field: 'indexation_pct', value_numeric: 1.5, unit: '%' },
      { field: 'term_years', value_numeric: 10, unit: 'years' },
      { field: 'availability_guarantee_pct', value_numeric: 97, unit: '%', monitored: true },
      { field: 'settlement_period', value_text: 'Monthly' },
    ],
  });

  await ensureContract({
    plantId: plant.id,
    orgClerkId: org,
    type: 'MODULE_WARRANTY',
    title: 'Module linear performance warranty',
    counterparty: 'Helios Module Works',
    effectiveFrom: commissioned,
    effectiveTo: plus(commissioned, 25),
    terms: [
      { field: 'initial_capacity_pct', value_numeric: 98, unit: '%', monitored: true },
      { field: 'year1_degradation_pct', value_numeric: 2, unit: '%', monitored: true },
      { field: 'annual_degradation_pct', value_numeric: 0.55, unit: '%/year', monitored: true },
      { field: 'end_capacity_pct', value_numeric: 84.8, unit: '%' },
      { field: 'performance_warranty_years', value_numeric: 25, unit: 'years' },
      { field: 'product_warranty_years', value_numeric: 12, unit: 'years' },
    ],
  });

  await ensureContract({
    plantId: plant.id,
    orgClerkId: org,
    type: 'OM_SLA',
    title: 'O&M service level agreement',
    counterparty: 'Levante O&M Services',
    effectiveFrom: commissioned,
    effectiveTo: plus(commissioned, 5),
    terms: [
      { field: 'response_hours_critical', value_numeric: 4, unit: 'hours', monitored: true },
      { field: 'response_hours_high', value_numeric: 24, unit: 'hours', monitored: true },
      { field: 'response_hours_medium', value_numeric: 72, unit: 'hours', monitored: true },
      { field: 'response_hours_low', value_numeric: 168, unit: 'hours', monitored: true },
      { field: 'resolution_hours_critical', value_numeric: 48, unit: 'hours', monitored: true },
      { field: 'resolution_hours_high', value_numeric: 168, unit: 'hours', monitored: true },
      { field: 'guaranteed_availability_pct', value_numeric: 98, unit: '%', monitored: true },
      { field: 'cleaning_cadence_per_year', value_numeric: 2, unit: 'per year' },
      { field: 'reporting_cadence', value_text: 'Monthly' },
    ],
  });
}

async function main() {
  if (argFlag('wipe')) {
    const gone = await prisma.contract.deleteMany({
      where: { created_by_clerk_id: SEED_TAG },
    });
    console.log(`Wiped ${gone.count} seeded contracts.`);
  }
  await backfillBessContracts();
  const pvSlug = typeof argFlag('pv-plant') === 'string' ? (argFlag('pv-plant') as string) : 'ribera';
  await seedPvContracts(pvSlug);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
