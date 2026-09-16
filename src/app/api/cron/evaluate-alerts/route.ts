import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { evaluatePlant } from '@/lib/alerts/evaluate';
import { evaluatePlantContracts } from '@/lib/contracts/evaluate';
import { alertRecipients } from '@/lib/alerts/recipients';
import { manualGuidanceFor, type ManualGuidance } from '@/lib/alerts/manual-guidance';
import { settingsFromMetadata } from '@/lib/plants/settings';
import { resendService } from '@/libs/resend';
import { emitAlertEvent } from '@/lib/integrations/webhooks';

/**
 * POST /api/cron/evaluate-alerts
 *
 * Evaluates every org plant's alert thresholds (Plant.metadata.settings)
 * and applies the PlantAlert state machine; newly triggered / escalated
 * CRITICAL alerts are emailed to org managers + plant-access holders
 * (honoring notifications.emailCritical). Triggered hourly by
 * .github/workflows/evaluate-alerts.yml.
 *
 * Query params:
 *   ?dry_run=1 — evaluate + report without persisting or emailing
 *   ?digest=1  — placeholder for the daily-summary pass (v1: reports the
 *                flag; digest content ships with the fleet rollup)
 *
 * Auth: Bearer CRON_SECRET in production (same convention as
 * /api/cron/poll-connections).
 */

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://nuravolt.com';
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dry_run') === '1';
  const digest = searchParams.get('digest') === '1';

  const plants = await prisma.plant.findMany({
    where: {
      organization_id: { not: null },
      status: { in: ['TRAINING', 'OPERATIONAL'] },
    },
    include: { organization: { select: { clerk_org_id: true } } },
  });

  let evaluated = 0;
  let opened = 0;
  let resolved = 0;
  let escalated = 0;
  let emailed = 0;
  const details: Record<string, unknown>[] = [];

  for (const plant of plants) {
    const orgClerkId = plant.organization?.clerk_org_id ?? '';
    try {
      const result = await evaluatePlant(plant, orgClerkId, dryRun);
      evaluated++;
      opened += result.opened;
      resolved += result.resolved;
      escalated += result.escalated;

      // Email criticals — never for demo orgs, never in dry runs, only when
      // the plant's notification toggle allows it. Outside production the
      // send is skipped (state still transitions) unless ?force_email=1.
      const settings = settingsFromMetadata(plant.metadata);
      const emailAllowed =
        process.env.NODE_ENV === 'production' || searchParams.get('force_email') === '1';

      // Manual-aware guidance for alerts we're notifying on: distilled from
      // equipment documentation in the KB (ai:copilot orgs only; every
      // failure path returns null and the alert ships plain). Persisted into
      // PlantAlert.context so the alert strip can render it too.
      const guidanceByAlert = new Map<string, ManualGuidance>();
      if (!dryRun && result.notify.length > 0) {
        for (const a of result.notify) {
          const guidance = await manualGuidanceFor({
            orgClerkId,
            plantId: plant.id,
            kind: a.kind,
            message: a.message,
          });
          if (!guidance) continue;
          guidanceByAlert.set(a.id, guidance);
          await prisma.plantAlert
            .update({
              where: { id: a.id },
              data: {
                context: {
                  ...((a.context as Record<string, unknown>) ?? {}),
                  manual_guidance: {
                    text: guidance.text,
                    source_title: guidance.source.title,
                    source_section: guidance.source.section,
                    source_url: guidance.source.url ?? null,
                  },
                },
              },
            })
            .catch(() => {});
        }
      }

      // Email eligible alerts, gated per severity: criticals under
      // emailCritical, warnings under emailWarning (both default on).
      const emailable = result.notify.filter((a) =>
        a.severity === 'CRITICAL'
          ? settings.notifications.emailCritical
          : settings.notifications.emailWarning
      );
      if (!dryRun && emailAllowed && emailable.length > 0) {
        const recipients = await alertRecipients(orgClerkId, plant.id);
        if (recipients.length > 0) {
          await resendService.sendPlantAlert(
            recipients,
            plant.name,
            `${baseUrl()}/dashboard/plant/${plant.slug}`,
            emailable.map((a) => {
              const g = guidanceByAlert.get(a.id);
              return {
                kind: a.kind,
                message: a.message,
                metricValue: a.metric_value,
                threshold: a.threshold,
                guidance: g
                  ? { text: g.text, sourceTitle: g.source.title, section: g.source.section }
                  : null,
              };
            })
          );
          await prisma.plantAlert.updateMany({
            where: { id: { in: emailable.map((a) => a.id) } },
            data: { notified_at: new Date() },
          });
          emailed++;
        }
      }

      // Deliver alert webhooks (all severities) to subscribers. No-op for orgs
      // without hooks; never throws. Demo orgs have no webhooks.
      if (!dryRun) {
        for (const a of result.notify) {
          await emitAlertEvent(orgClerkId, 'alert.opened', {
            id: a.id,
            kind: a.kind,
            severity: a.severity,
            message: a.message,
            metric_value: a.metric_value,
            threshold: a.threshold,
            status: a.status,
            plant_slug: plant.slug,
            plant_name: plant.name,
            url: `${baseUrl()}/dashboard/plant/${plant.slug}`,
          });
        }
      }

      // Contract obligations: separate evaluator, same cadence. Breaches open
      // WARNING-severity CONTRACT_OBLIGATION alerts (no email — the critical
      // email path stays reserved for the threshold rules above).
      let contractSummary: Record<string, unknown> | null = null;
      try {
        const contracts = await evaluatePlantContracts(plant, orgClerkId, dryRun);
        if (contracts) {
          opened += contracts.opened;
          resolved += contracts.resolved;
          contractSummary = {
            obligations: contracts.obligations.length,
            opened: contracts.opened,
            resolved: contracts.resolved,
            breaches: contracts.obligations.filter((o) => o.status === 'breach').length,
          };
        }
      } catch (err) {
        contractSummary = { error: (err as Error).message };
      }

      if (result.opened || result.resolved || result.escalated || contractSummary || dryRun) {
        details.push({
          plant: plant.slug,
          readings: result.readings.map((r) => ({
            kind: r.kind,
            value: r.value,
            threshold: r.threshold,
            breached: r.breached,
          })),
          opened: result.opened,
          resolved: result.resolved,
          escalated: result.escalated,
          ...(contractSummary ? { contracts: contractSummary } : {}),
        });
      }
    } catch (err) {
      details.push({ plant: plant.slug, error: (err as Error).message });
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    digest,
    evaluated,
    opened,
    resolved,
    escalated,
    emailed,
    details,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
