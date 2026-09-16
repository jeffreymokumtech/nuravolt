import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding A/B test variants...');

  await prisma.aBVariant.createMany({
    data: [
      {
        test_name: 'hero-section',
        variant_name: 'control',
        is_active: true,
        traffic_percentage: 50
      },
      {
        test_name: 'hero-section',
        variant_name: 'variant_b',
        is_active: true,
        traffic_percentage: 50
      }
    ],
    skipDuplicates: true
  });

  console.log('A/B test variants seeded successfully');

  await seedWave3DataQualityDemo();
}

/**
 * Wave-3 Data-Quality persistence demo seed.
 *
 * Idempotently creates the records the Alpha DQ Hub fixture expects so the
 * demo renders persisted curation actions out-of-the-box. Wrapped in try/catch
 * so the seed step degrades gracefully if the Wave-3 migration has not yet
 * been applied (e.g. fresh checkout running `npm run seed` before
 * `npx prisma migrate dev`).
 */
async function seedWave3DataQualityDemo() {
  const ORG = 'demo_org_alpha1';
  const PLANT = 'alpha';

  try {
    console.log('Seeding Wave-3 DQ Hub persistence demo (alpha)...');

    // 1) DataQualityIncident — INV-04 SCADA polling stale
    // No natural unique key on the model, so guard with findFirst+create.
    const existingIncident = await prisma.dataQualityIncident.findFirst({
      where: {
        org_clerk_id: ORG,
        plant_id: PLANT,
        summary: 'INV-04 SCADA polling stale for 17h',
      },
    });
    const incident =
      existingIncident ??
      (await prisma.dataQualityIncident.create({
        data: {
          org_clerk_id: ORG,
          plant_id: PLANT,
          summary: 'INV-04 SCADA polling stale for 17h',
          severity: 'high',
          opened_by: 'AM',
        },
      }));
    console.log(`  DataQualityIncident: ${incident.id}`);

    // 2) DataQualityAcknowledgement — AM acknowledged INV-04 stream
    // No natural unique key — guard with findFirst on (org, plant, stream, actor).
    const ackStream = 'alpha.INV04.scada.poll';
    const existingAck = await prisma.dataQualityAcknowledgement.findFirst({
      where: {
        org_clerk_id: ORG,
        plant_id: PLANT,
        stream_id: ackStream,
        acknowledged_by: 'AM',
      },
    });
    if (!existingAck) {
      await prisma.dataQualityAcknowledgement.create({
        data: {
          org_clerk_id: ORG,
          plant_id: PLANT,
          stream_id: ackStream,
          acknowledged_by: 'AM',
          reason: 'Aware — maintenance scheduled',
          incident_id: incident.id,
        },
      });
      console.log(`  DataQualityAcknowledgement created for ${ackStream}`);
    } else {
      console.log(`  DataQualityAcknowledgement already present for ${ackStream}`);
    }

    // 3) DataStreamExclusion — DustIQ unit_03 excluded from SR
    const exclusionStream = 'alpha.dustiq.unit_03';
    const existingExclusion = await prisma.dataStreamExclusion.findFirst({
      where: {
        org_clerk_id: ORG,
        plant_id: PLANT,
        stream_id: exclusionStream,
        created_by: 'AM',
        ends_at: null,
      },
    });
    if (!existingExclusion) {
      await prisma.dataStreamExclusion.create({
        data: {
          org_clerk_id: ORG,
          plant_id: PLANT,
          stream_id: exclusionStream,
          kpi_names: ['SR'],
          created_by: 'AM',
          reason: 'Pre-firmware drift — excluded until upgraded',
        },
      });
      console.log(`  DataStreamExclusion created for ${exclusionStream}`);
    } else {
      console.log(`  DataStreamExclusion already present for ${exclusionStream}`);
    }

    // 4) DataStreamHealth — mirror top_degraded entries from alpha today.json
    // Composite unique key (org, plant, stream) lets us upsert cleanly.
    const healthRows = [
      {
        stream_id: 'alpha.INV04.scada.poll',
        label: 'INV-04 SCADA polling',
        category: 'inverter',
        severity: 'high',
        last_good_at: new Date('2026-06-20T14:22:00Z'),
        last_value: null as number | null,
        gap_minutes: 1070,
        attribution_cause: 'inverter_trip',
        attribution_narrative:
          'Polling channel went stale at 14:22 yesterday — coincides with INV-04 fault entry at 14:21:48 in /api/faults',
        affected_kpis: ['PR', 'AC_yield', 'fleet_capacity_factor'],
      },
      {
        stream_id: 'alpha.met.pyrano_a',
        label: 'Pyranometer A (rooftop)',
        category: 'met_sensor',
        severity: 'medium',
        last_good_at: new Date('2026-06-21T07:48:00Z'),
        last_value: 142.3,
        gap_minutes: 24,
        attribution_cause: 'met_station_shadow',
        attribution_narrative:
          'Pyrano-A occluded 06:00–08:30 for 6 consecutive mornings — likely tree growth or new mounting obstruction. Pyrano-B unaffected.',
        affected_kpis: ['PR', 'SR'],
      },
      {
        stream_id: 'alpha.dustiq.unit_03',
        label: 'DustIQ unit 03',
        category: 'soiling_sensor',
        severity: 'low',
        last_good_at: new Date('2026-06-21T05:14:00Z'),
        last_value: 0.961,
        gap_minutes: 178,
        attribution_cause: 'dustiq_firmware_quirk',
        attribution_narrative:
          'Unit 03 is pre-firmware v22000; dust-slope coefficient needs ×2 correction (Heimsath 2019). Applied automatically upstream.',
        affected_kpis: ['SR'],
      },
    ];

    for (const row of healthRows) {
      await prisma.dataStreamHealth.upsert({
        where: {
          org_clerk_id_plant_id_stream_id: {
            org_clerk_id: ORG,
            plant_id: PLANT,
            stream_id: row.stream_id,
          },
        },
        update: {
          label: row.label,
          category: row.category,
          severity: row.severity,
          last_good_at: row.last_good_at,
          last_value: row.last_value,
          gap_minutes: row.gap_minutes,
          attribution_cause: row.attribution_cause,
          attribution_narrative: row.attribution_narrative,
          affected_kpis: row.affected_kpis,
        },
        create: {
          org_clerk_id: ORG,
          plant_id: PLANT,
          stream_id: row.stream_id,
          label: row.label,
          category: row.category,
          severity: row.severity,
          last_good_at: row.last_good_at,
          last_value: row.last_value,
          gap_minutes: row.gap_minutes,
          attribution_cause: row.attribution_cause,
          attribution_narrative: row.attribution_narrative,
          affected_kpis: row.affected_kpis,
        },
      });
    }
    console.log(`  DataStreamHealth upserted ${healthRows.length} rows`);

    console.log('Wave-3 DQ Hub demo seeded successfully');
  } catch (err: any) {
    // Most likely cause: Wave-3 migration hasn't been applied yet, so the
    // referenced models/tables don't exist. Log and continue instead of
    // failing the whole seed run.
    console.warn(
      '[seed] Skipping Wave-3 DQ Hub demo seed — tables likely missing. ' +
        'Run `npx prisma migrate dev` to apply the Wave-3 migration, then re-run `npm run seed`.'
    );
    console.warn(`[seed] underlying error: ${err?.message ?? err}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });