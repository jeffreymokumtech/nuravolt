import { PrismaClient, AssetType, PlantStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Plant definitions
// ---------------------------------------------------------------------------

interface PlantDef {
  plantId: string;
  plantName: string;
  assetType: AssetType;
  location: string;
  capacity_MW: number;
  totalInverters: number;
  inverterGroups?: string[];
  lat: number;
  lng: number;
  timezone: string;
}

const plants: PlantDef[] = [
  {
    plantId: 'alpha',
    plantName: 'Alpha',
    assetType: AssetType.PV,
    location: 'Region A, Southern Europe',
    capacity_MW: 45.0,
    totalInverters: 150,
    inverterGroups: ['PV-01', 'PV-02', 'PV-03', 'PV-04', 'PV-05'],
    lat: 38.0,
    lng: -4.0,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'ribera',
    plantName: 'Beta',
    assetType: AssetType.PV,
    location: 'Region A, Southern Europe',
    capacity_MW: 36.0,
    totalInverters: 120,
    inverterGroups: ['PV-01', 'PV-02', 'PV-03', 'PV-04'],
    lat: 38.0,
    lng: -1.0,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'gamma',
    plantName: 'Gamma',
    assetType: AssetType.PV,
    location: 'Region B, Southern Europe',
    capacity_MW: 13.5,
    totalInverters: 45,
    inverterGroups: ['PV-01', 'PV-02'],
    lat: 38.5,
    lng: -0.5,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'delta',
    plantName: 'Delta',
    assetType: AssetType.PV,
    location: 'Region C, Mediterranean',
    capacity_MW: 12.9,
    totalInverters: 43,
    inverterGroups: ['PV-01', 'PV-02'],
    lat: 39.5,
    lng: 2.5,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'epsilon',
    plantName: 'Epsilon',
    assetType: AssetType.PV,
    location: 'Region D, Southern Europe',
    capacity_MW: 10.8,
    totalInverters: 36,
    inverterGroups: ['PV-01', 'PV-02'],
    lat: 40.0,
    lng: 4.0,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'zeta',
    plantName: 'Zeta',
    assetType: AssetType.PV,
    location: 'Region C, Mediterranean',
    capacity_MW: 9.0,
    totalInverters: 30,
    inverterGroups: ['PV-01'],
    lat: 39.5,
    lng: 3.0,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'eta',
    plantName: 'Eta',
    assetType: AssetType.PV,
    location: 'Region E, Western Europe',
    capacity_MW: 8.4,
    totalInverters: 28,
    inverterGroups: ['PV-01'],
    lat: 38.5,
    lng: -6.5,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'theta',
    plantName: 'Industrial Rooftop Theta',
    assetType: AssetType.PV,
    location: 'Barcelona, Catalonia',
    capacity_MW: 1.0,
    totalInverters: 20,
    inverterGroups: ['South', 'East', 'West'],
    lat: 41.5,
    lng: 2.0,
    timezone: 'Europe/Madrid',
  },
  {
    plantId: 'nordic-wind-1',
    plantName: 'Nordic Wind',
    assetType: AssetType.WIND,
    location: 'Jutland, Denmark',
    capacity_MW: 10.0,
    totalInverters: 5,
    lat: 55.86,
    lng: 9.84,
    timezone: 'Europe/Copenhagen',
  },
  {
    plantId: 'care-portugal',
    plantName: 'CARE Wind Portugal',
    assetType: AssetType.WIND,
    location: 'Portugal',
    capacity_MW: 10.0,
    totalInverters: 5,
    lat: 39.40,
    lng: -8.22,
    timezone: 'Europe/Lisbon',
  },
  {
    plantId: 'iberia-h2',
    plantName: 'Iberia Hydrogen Valley',
    assetType: AssetType.HYDROGEN,
    location: 'Aragón, Spain',
    capacity_MW: 5.0,
    totalInverters: 0,
    lat: 41.65,
    lng: -0.88,
    timezone: 'Europe/Madrid',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a group name like "PV-01" to a slug like "pv-01". */
function groupSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Build a padded inverter external_id.
 *   groupIdx: 1-based group number
 *   invIdx:   1-based inverter number within the entire plant
 * Example: INV_01_001
 */
function inverterId(groupIdx: number, invIdx: number): string {
  const gp = String(groupIdx).padStart(2, '0');
  const iv = String(invIdx).padStart(3, '0');
  return `INV_${gp}_${iv}`;
}

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Seeding demo plants ===\n');

  let plantsCreated = 0;
  let plantsUpdated = 0;
  let groupsCreated = 0;
  let invertersCreated = 0;

  for (const def of plants) {
    // ----- Upsert the Plant -----
    const plant = await prisma.plant.upsert({
      where: { slug: def.plantId },
      update: {
        name: def.plantName,
        asset_type: def.assetType,
        location_name: def.location,
        latitude: def.lat,
        longitude: def.lng,
        timezone: def.timezone,
        capacity_mw: def.capacity_MW,
        status: PlantStatus.OPERATIONAL,
      },
      create: {
        slug: def.plantId,
        name: def.plantName,
        asset_type: def.assetType,
        location_name: def.location,
        latitude: def.lat,
        longitude: def.lng,
        timezone: def.timezone,
        capacity_mw: def.capacity_MW,
        status: PlantStatus.OPERATIONAL,
      },
    });

    // Determine if this was a create or update by checking created_at vs updated_at
    const isNew = plant.created_at.getTime() === plant.updated_at.getTime();
    if (isNew) {
      plantsCreated++;
      console.log(`  + Plant created: ${def.plantName} (${def.plantId})`);
    } else {
      plantsUpdated++;
      console.log(`  ~ Plant updated: ${def.plantName} (${def.plantId})`);
    }

    // ----- Skip inverter groups for WIND plants -----
    if (def.assetType === AssetType.WIND || !def.inverterGroups || def.inverterGroups.length === 0) {
      console.log(`    (wind plant - skipping inverter groups)\n`);
      continue;
    }

    // ----- Distribute inverters across groups -----
    const groupCount = def.inverterGroups.length;
    const basePerGroup = Math.floor(def.totalInverters / groupCount);
    const remainder = def.totalInverters % groupCount;

    // Build group sizes: first `remainder` groups get one extra inverter
    const groupSizes: number[] = [];
    for (let g = 0; g < groupCount; g++) {
      groupSizes.push(basePerGroup + (g < remainder ? 1 : 0));
    }

    let globalInvIdx = 1; // running inverter number across the whole plant

    for (let g = 0; g < groupCount; g++) {
      const gName = def.inverterGroups[g];
      const gSlug = groupSlug(gName);
      const groupIdx = g + 1; // 1-based group number

      // Upsert the InverterGroup
      const group = await prisma.inverterGroup.upsert({
        where: {
          plant_id_slug: {
            plant_id: plant.id,
            slug: gSlug,
          },
        },
        update: {
          name: gName,
        },
        create: {
          plant_id: plant.id,
          name: gName,
          slug: gSlug,
          tilt: 25.0,    // reasonable default for Southern Europe
          azimuth: 180.0, // south-facing
        },
      });

      const isNewGroup = group.created_at.getTime() === group.updated_at.getTime();
      if (isNewGroup) groupsCreated++;

      console.log(`    Group: ${gName} (${groupSizes[g]} inverters)`);

      // Create inverters in this group
      for (let i = 0; i < groupSizes[g]; i++) {
        const extId = inverterId(groupIdx, globalInvIdx);

        await prisma.inverter.upsert({
          where: {
            group_id_external_id: {
              group_id: group.id,
              external_id: extId,
            },
          },
          update: {
            name: extId,
            enabled: true,
          },
          create: {
            group_id: group.id,
            external_id: extId,
            name: extId,
            enabled: true,
          },
        });

        invertersCreated++;
        globalInvIdx++;
      }
    }

    console.log('');
  }

  // ----- Summary -----
  const totalPlants = await prisma.plant.count();
  const totalGroups = await prisma.inverterGroup.count();
  const totalInverters = await prisma.inverter.count();

  console.log('=== Seed complete ===');
  console.log(`  Plants created/updated: ${plantsCreated} new, ${plantsUpdated} updated`);
  console.log(`  Inverter groups upserted: ${groupsCreated}`);
  console.log(`  Inverters upserted: ${invertersCreated}`);
  console.log('');
  console.log(`  Totals in DB: ${totalPlants} plants, ${totalGroups} groups, ${totalInverters} inverters`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
