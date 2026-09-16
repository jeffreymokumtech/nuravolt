/**
 * Seed the standalone BESS demo asset "Boreas Storage Hub" into the
 * Postgres Plant + BessAsset tables.
 *
 * Idempotent — upserts by `slug`, so re-running is safe.
 *
 *   npm run seed:standalone-bess -- --org <better-auth org id>
 *
 * Pass --org to attach the plant to an organization. Without it the plant is
 * created unowned, which is fine for the public /demo route but means it will
 * NOT appear in any signed-in dashboard: every dashboard read is org-scoped
 * (resolvePlantForRead), so an unowned plant is invisible there by design.
 *
 * The battery nav itself keys off Plant.asset_type via assetTypeChip() ->
 * navForAssetChip(), so an org needs at least one BESS or HYBRID plant before
 * the battery section appears at all.
 */

import dotenv from 'dotenv';

// An explicitly-exported DATABASE_URL always beats .env. Overriding
// unconditionally sent a prod-targeted run to the local database and it
// reported "no organization matched" against the wrong data entirely.
dotenv.config({ override: !process.env.DATABASE_URL });

import { PrismaClient, AssetType, PlantStatus, BessChemistry } from '@prisma/client';

const prisma = new PrismaClient();

const PLANT_SLUG = 'boreas';
const PLANT_NAME = 'Boreas Storage Hub';
const ASSET_EXTERNAL_ID = 'bess-boreas-001';

const RATED_MW = 50.0;
const ENERGY_MWH = 100.0;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

async function resolveOrganizationId(ref: string | undefined): Promise<string | null> {
  if (!ref) return null;
  // Accept the Better Auth org id (stored as clerk_org_id), the internal uuid,
  // or the org name, so this is usable from whatever the caller has to hand.
  const org = await prisma.organization.findFirst({
    where: { OR: [{ clerk_org_id: ref }, { id: ref }, { name: ref }] },
  });
  if (!org) {
    console.error(`No organization matched "${ref}".`);
    console.error('Find yours with: select id, name, clerk_org_id, plan_type from "Organization";');
    process.exit(1);
  }
  if (!['business', 'growth', 'enterprise'].includes(org.plan_type ?? '')) {
    // Not fatal: the plant still seeds. But analytics:bess is Business+, so the
    // section renders the upgrade panel rather than the console.
    console.warn(
      `Warning: org "${org.name}" has plan_type "${org.plan_type}". ` +
        'Battery analytics need business or enterprise, otherwise the section shows the upgrade panel.'
    );
  }
  console.log(`Attaching to organization "${org.name}" (${org.id}).`);
  return org.id;
}

async function main() {
  console.log('=== Seeding standalone BESS plant ===');

  const organizationId = await resolveOrganizationId(argValue('--org'));
  if (!organizationId) {
    console.log('No --org passed: seeding unowned (visible on /demo, not in a dashboard).');
  }

  const fields = {
    name: PLANT_NAME,
    asset_type: AssetType.BESS,
    location_name: 'Yorkshire, United Kingdom',
    latitude: 54,
    longitude: -1.5,
    timezone: 'Europe/London',
    capacity_mw: RATED_MW,
    installed_mw: RATED_MW,
    // Drives the equivalent-MW pricing meter, max(rated MW, MWh / 4).
    energy_capacity_mwh: ENERGY_MWH,
    status: PlantStatus.OPERATIONAL,
    commissioning_date: new Date('2024-06-15'),
    country: 'GB',
    currency: 'GBP',
    ...(organizationId ? { organization_id: organizationId } : {}),
  };

  const plant = await prisma.plant.upsert({
    where: { slug: PLANT_SLUG },
    update: fields,
    create: { slug: PLANT_SLUG, ...fields },
  });
  console.log(`✓ Plant ${plant.slug} (${plant.id}) — ${PLANT_NAME}`);

  // Upsert the BESS asset. Composite key is (plant_id, external_asset_id);
  // since there's no compound unique on the model, we look it up first.
  const existing = await prisma.bessAsset.findFirst({
    where: { plant_id: plant.id, external_asset_id: ASSET_EXTERNAL_ID },
  });

  const assetData = {
    plant_id: plant.id,
    external_asset_id: ASSET_EXTERNAL_ID,
    name: 'Boreas Storage Unit 1',
    chemistry: BessChemistry.LFP,
    nominal_capacity_kwh: 100_000,
    nominal_power_kw: 50_000,
    installation_date: new Date('2024-06-15'),
    manufacturer: 'Tesla',
    model: 'Megapack 2 XL',
    current_soh: 0.963,
    current_soc: 0.42,
    enabled: true,
  };

  const asset = existing
    ? await prisma.bessAsset.update({ where: { id: existing.id }, data: assetData })
    : await prisma.bessAsset.create({ data: assetData });

  console.log(`✓ BessAsset ${asset.external_asset_id} — ${asset.manufacturer} ${asset.model} (${Number(asset.nominal_power_kw) / 1000} MW / ${Number(asset.nominal_capacity_kwh) / 1000} MWh)`);

  console.log('\nDone. Visit:');
  if (organizationId) {
    console.log('  /dashboard/plant/boreas          (signed in as a member of that org)');
    console.log('  /dashboard/plant/boreas/bess');
    console.log('  /dashboard/plant/boreas/revenue');
  } else {
    console.log('  /demo/plant/boreas');
    console.log('  /demo/plant/boreas/revenue');
    console.log('  Pass --org <org id> to make it visible in a signed-in dashboard.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
