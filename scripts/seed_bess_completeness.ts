/**
 * Make BESS plants demo-complete:
 *
 * 1. Every BessAsset gets a BessWarrantyTerms row (chemistry-appropriate
 *    defaults derived from the asset's specs) — the /bess page's warranty
 *    tracker and SoH projection both gate on terms, so assets without a
 *    terms row show "unavailable" panels despite healthy data.
 * 2. region_a-storage gets a second container asset ("Unit 2", same spec,
 *    its own capacity-test history) so the fleet-cohort comparison panel
 *    (which needs >= 2 assets on the plant) renders.
 *
 * Idempotent: terms are keyed by asset_id (unique), the second unit by
 * external_asset_id. Run with DATABASE_URL to target prod:
 *
 *   npx tsx scripts/seed_bess_completeness.ts
 *   DATABASE_URL=<prod> npx tsx scripts/seed_bess_completeness.ts
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureWarrantyTerms() {
  const assets = await prisma.bessAsset.findMany({
    include: { warranty_terms: true },
  });
  let created = 0;
  for (const a of assets) {
    if (a.warranty_terms) continue;
    const capacityKwh = Number(a.nominal_capacity_kwh);
    const powerKw = Number(a.nominal_power_kw);
    // Standard LFP merchant-storage warranty: 70% capacity floor over 10
    // years, 6000 EFC, RTE floor 85%, LFP cell window 2.5-3.65 V, 0-45 C.
    const cRate = capacityKwh > 0 ? Math.round((powerKw / capacityKwh) * 100) / 100 : 0.5;
    await prisma.bessWarrantyTerms.create({
      data: {
        asset_id: a.id,
        capacity_guarantee_pct: 0.7,
        warranty_years: 10,
        max_cycles: 6000,
        max_throughput_mwh: Math.round(capacityKwh * 6), // ~6000 EFC in MWh terms
        min_rte: 0.85,
        max_avg_soc: 0.9,
        min_soc: 0.05,
        soc_hold_limit_hours: 24,
        operating_temp_min_c: 0,
        operating_temp_max_c: 45,
        temp_violation_minutes: 30,
        max_c_rate_continuous: cRate,
        max_c_rate_peak: Math.round(cRate * 1.5 * 100) / 100,
        peak_duration_minutes: 15,
        cell_voltage_min_v: 2.5,
        cell_voltage_max_v: 3.65,
        effective_from: a.installation_date ?? new Date('2025-01-01'),
      },
    });
    created++;
    console.log(`+ warranty terms for ${a.name} (${a.external_asset_id})`);
  }
  console.log(`Warranty terms: ${created} created, ${assets.length - created} already present.`);
}

interface SecondUnitSpec {
  slug: string;
  name: string;
  installDate: string;
  serial: string;
  // Grounding capacity-test history (most recent last); current_soh follows
  // the last test.
  tests: Array<{ d: string; soh: number }>;
}

// The fleet-cohort comparison panel needs >= 2 assets on the plant.
const SECOND_UNITS: SecondUnitSpec[] = [
  {
    slug: 'region_a-storage',
    name: 'Region A Storage Unit 2',
    installDate: '2025-11-12',
    serial: 'ENC-2025-4471',
    tests: [
      { d: '2026-06-22', soh: 0.9942 },
      { d: '2026-06-30', soh: 0.9938 },
      { d: '2026-07-08', soh: 0.9935 },
      { d: '2026-07-15', soh: 0.9931 },
    ],
  },
  {
    slug: 'athi-storage',
    name: 'Athi Storage Unit 2',
    installDate: '2026-03-10',
    serial: 'ENC-2026-1183',
    tests: [
      { d: '2026-06-24', soh: 0.9976 },
      { d: '2026-07-02', soh: 0.9973 },
      { d: '2026-07-10', soh: 0.997 },
      { d: '2026-07-17', soh: 0.9968 },
    ],
  },
];

async function ensureSecondUnit(spec: SecondUnitSpec) {
  const plant = await prisma.plant.findUnique({ where: { slug: spec.slug } });
  if (!plant) {
    console.log(`${spec.slug} plant not found — skipping second unit.`);
    return;
  }
  const extId = `BESS-${spec.slug}-2`;
  const existing = await prisma.bessAsset.findFirst({
    where: { plant_id: plant.id, external_asset_id: extId },
  });
  if (existing) {
    console.log(`Second ${spec.slug} unit already present.`);
    return;
  }

  const latest = spec.tests[spec.tests.length - 1];
  const unit2 = await prisma.bessAsset.create({
    data: {
      plant_id: plant.id,
      external_asset_id: extId,
      name: spec.name,
      chemistry: 'LFP',
      nominal_capacity_kwh: 2000,
      nominal_power_kw: 1000,
      module_count: 8,
      rack_count: 1,
      installation_date: new Date(spec.installDate),
      manufacturer: 'CATL',
      model: 'EnerC Plus',
      serial_number: spec.serial,
      current_soh: latest.soh,
      current_soc: 0.55,
      last_capacity_test: new Date(latest.d),
      enabled: true,
    },
  });

  // A short capacity-test history so its SoH is grounded, mirroring the
  // cadence of unit 1 (tests every ~8 days recently).
  for (const t of spec.tests) {
    await prisma.bessCapacityTest.create({
      data: {
        asset_id: unit2.id,
        test_date: new Date(t.d),
        soh_result: t.soh,
        measured_capacity_kwh: Math.round(2000 * t.soh * 10) / 10,
        capacity_retention: t.soh,
        test_type: 'standard',
      },
    });
  }
  console.log(`+ ${spec.name} (${unit2.id}) with ${spec.tests.length} capacity tests.`);
}

/**
 * Assets whose capacity tests are all model-'estimated' get two 'standard'
 * tests (commissioning acceptance + a recent metered test), consistent with
 * the latest estimated SoH so the trajectory stays coherent. The audit
 * SoH-second-opinion panel only renders on standard/partial tests — without
 * one there is no independent number to compare.
 */
async function ensureStandardCapacityTests() {
  const assets = await prisma.bessAsset.findMany({
    include: { capacity_tests: { orderBy: { test_date: 'asc' } } },
  });
  for (const a of assets) {
    if (!a.capacity_tests.length) continue;
    if (a.capacity_tests.some((t) => t.test_type === 'standard')) continue;
    const capacity = Number(a.nominal_capacity_kwh);
    const latest = a.capacity_tests[a.capacity_tests.length - 1];
    const latestSoh = Number(latest.soh_result);
    const commissioning = a.installation_date ?? a.capacity_tests[0].test_date;

    const tests = [
      { d: commissioning, soh: 0.999, label: 'commissioning acceptance' },
      { d: new Date(latest.test_date.getTime() + 3 * 86_400_000), soh: latestSoh - 0.0005, label: 'recent metered' },
    ];
    for (const t of tests) {
      await prisma.bessCapacityTest.create({
        data: {
          asset_id: a.id,
          test_date: t.d,
          soh_result: Math.round(t.soh * 10000) / 10000,
          measured_capacity_kwh: Math.round(capacity * t.soh * 10) / 10,
          capacity_retention: Math.round(t.soh * 10000) / 10000,
          test_type: 'standard',
        },
      });
      console.log(`+ standard capacity test (${t.label}) for ${a.name} @ ${(t.soh * 100).toFixed(2)}%`);
    }
  }
}

async function main() {
  await ensureWarrantyTerms();
  for (const spec of SECOND_UNITS) {
    await ensureSecondUnit(spec);
  }
  // Terms for the new units too (created after the first pass).
  await ensureWarrantyTerms();
  await ensureStandardCapacityTests();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
