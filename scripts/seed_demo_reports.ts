/**
 * Seed the demo org's reporting content: one composed dashboard for the
 * kilima-solar demo plant and one weekly scheduled delivery linked to it, so
 * the Reports hub is never empty and the email pipeline has a live specimen.
 *
 * Idempotent: the dashboard upserts on its slug, the schedule matches on
 * (name, created_by). Widget ids are stable so re-runs overwrite in place.
 *
 *   DATABASE_URL=<dsn> npx tsx scripts/seed_demo_reports.ts \
 *     --org <better-auth org id> --user <user id> [--recipients a@b.c,d@e.f]
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

import { PrismaClient } from '@prisma/client';
import { computeNextRunAt } from '../src/lib/reports/schedule';
import { REPORT_TEMPLATES } from '../src/components/reports/templates';

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const org = arg('org');
  const user = arg('user');
  if (!org || !user) {
    console.error('Usage: seed_demo_reports.ts --org <authOrgId> --user <userId> [--recipients a@b.c,...]');
    process.exit(1);
  }
  const userRow = await prisma.user.findUnique({ where: { id: user } });
  const recipients = (arg('recipients') ?? userRow?.email ?? 'demo@nuravolt.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // The demo org's worst inverters (twin loss ranking) for the deep-dive
  // template's device slots. Falls back to the seeded problem set.
  let worstDevices = ['INV-21', 'INV-17', 'INV-11'];
  try {
    const kilima = await prisma.plant.findFirst({ where: { slug: 'kilima-solar' } });
    if (kilima) {
      const rows = await prisma.$queryRaw<{ device_id: string; loss: number }[]>`
        SELECT device_id,
               COALESCE(AVG(CASE WHEN metric = 'power_ac_predicted' THEN value END), 0)
                 - COALESCE(AVG(CASE WHEN metric = 'power_ac_actual' THEN value END), 0) AS loss
        FROM analysis_results
        WHERE plant_id = ${kilima.id}::uuid
          AND device_id LIKE 'INV%' AND device_id <> 'PLANT'
          AND metric IN ('power_ac_predicted', 'power_ac_actual')
        GROUP BY device_id
        ORDER BY loss DESC
        LIMIT 3`;
      if (rows.length === 3) worstDevices = rows.map((r) => r.device_id);
    }
  } catch {
    // keep the fallback set
  }

  // Flagship templates, instantiated for the demo pair. Weekly ops carries
  // the scheduled delivery; the deep dive shows the low-level story.
  const specs: { slug: string; templateId: string }[] = [
    { slug: 'kilima-weekly-ops', templateId: 'weekly_ops' },
    { slug: 'kilima-inverter-deep-dive', templateId: 'inverter_deep_dive' },
  ];
  let weeklyDashboardId: string | null = null;
  for (const spec of specs) {
    const tpl = REPORT_TEMPLATES.find((t) => t.id === spec.templateId)!;
    const built = tpl.build({
      pvPlant: 'kilima-solar',
      bessPlant: 'athi-storage',
      allPlants: ['kilima-solar', 'athi-storage'],
      worstDevices,
    });
    const fields = {
      title: built.title,
      description: built.description,
      owner_id: user,
      organization_id: org,
      scope_plant_ids: built.plantIds,
      default_range: 'last_30d',
      widgets: built.widgets,
    };
    const dashboard = await prisma.dashboard.upsert({
      where: { slug: spec.slug },
      update: fields,
      create: { slug: spec.slug, ...fields },
    });
    if (spec.templateId === 'weekly_ops') weeklyDashboardId = dashboard.id;
    console.log(`+ dashboard ${dashboard.slug} (${dashboard.id}) [${built.widgets.length} widgets]`);
  }

  const scheduleFields = {
    schedule: 'weekly' as const,
    period: 'last_7d' as const,
    send_day_of_week: 1,
    recipient_emails: recipients,
    plant_ids: ['kilima-solar', 'athi-storage'],
    report_type: 'combined',
    report_sections: [
      'portfolio_summary',
      'risk_performance',
      'loss_breakdown',
      'contract_obligations',
      'bess_kpi',
      'bess_dispatch',
    ],
    dashboard_id: weeklyDashboardId,
    is_active: true,
    next_run_at: computeNextRunAt('weekly', 1),
  };
  const existing = await prisma.scheduledReport.findFirst({
    where: { name: 'Kilima weekly report', created_by: user },
  });
  const report = existing
    ? await prisma.scheduledReport.update({ where: { id: existing.id }, data: scheduleFields })
    : await prisma.scheduledReport.create({
        data: { name: 'Kilima weekly report', created_by: user, ...scheduleFields },
      });
  console.log(
    `+ scheduled report ${report.name} (${report.id}) -> ${recipients.join(', ')} next ${report.next_run_at?.toISOString()}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
