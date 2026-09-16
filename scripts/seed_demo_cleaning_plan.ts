/**
 * Seed ONE adopted cleaning plan for the demo plant (kilima-solar): a few
 * future dry-season dates with linked SCHEDULED_MAINTENANCE tickets, so the
 * soiling page's Planned cleanings panel and the overview teaser are
 * populated while the optimizer tab stays obviously interactive (the demo
 * walk runs a live optimization and adopts a superseding plan).
 *
 * Idempotent: replaces any existing "Seeded dry-season plan" schedule and
 * its linked tickets.
 *
 *   DATABASE_URL=<dsn> npx tsx scripts/seed_demo_cleaning_plan.ts \
 *     --org <better-auth org id> --user <user id> [--plant kilima-solar]
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

import { PrismaClient } from '@prisma/client';
import { createCleaningSchedule } from '../src/lib/soiling/cleaningSchedules';

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const PLAN_NAME = 'Seeded dry-season plan';

async function main() {
  const org = arg('org');
  const user = arg('user');
  const plantRef = arg('plant') ?? 'kilima-solar';
  if (!org || !user) {
    console.error('Usage: seed_demo_cleaning_plan.ts --org <authOrgId> --user <userId> [--plant slug]');
    process.exit(1);
  }
  const plant = await prisma.plant.findFirst({
    where: { OR: [{ id: plantRef }, { slug: plantRef }] },
  });
  if (!plant) throw new Error(`Plant not found: ${plantRef}`);

  // Replace a previous seeded plan (and its tickets) for idempotency.
  const prior = await prisma.cleaningSchedule.findMany({
    where: { plant_id: plant.id, schedule_name: PLAN_NAME },
  });
  if (prior.length) {
    await prisma.ticket.deleteMany({ where: { trigger_id: { in: prior.map((p) => p.id) } } });
    await prisma.cleaningSchedule.deleteMany({ where: { id: { in: prior.map((p) => p.id) } } });
    console.log(`- removed ${prior.length} prior seeded plan(s)`);
  }

  // Three dry-season dates: ~3, ~8 and ~13 weeks out (Kenya dry Jun-Sep and
  // Jan-Feb; relative offsets keep the plan in the future on every reseed).
  const dates = [21, 56, 91].map((days) => {
    const d = new Date(Date.now() + days * 86_400_000);
    return d.toISOString().slice(0, 10);
  });

  // Economics in line with the optimizer's typical kilima output at default
  // prices (65 EUR/MWh, 150 EUR/MW per visit on 6 MW).
  const capacityMw = Number(plant.capacity_mw ?? 6);
  const costPerVisit = capacityMw * 150;
  const schedule = await createCleaningSchedule({
    plantId: plant.id,
    orgClerkId: org,
    userId: user,
    scheduleName: PLAN_NAME,
    dates,
    estimatedEnergyRecoveredMwh: 96,
    estimatedRevenueRecoveredEur: 96 * 65,
    estimatedCleaningCostEur: dates.length * costPerVisit,
    avgSrBaseline: 0.955,
    avgSrOptimized: 0.985,
    createTickets: true,
  });
  console.log(
    `+ adopted plan ${schedule.id}: ${schedule.dates.join(', ')} · net ${schedule.netBenefitEur} EUR · ${schedule.ticketIds.length} tickets`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
