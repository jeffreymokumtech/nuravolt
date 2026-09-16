import srForecast from '../../../public/data/soiling/ribera/sr_forecast.json';
import faults from '../../../public/data/faults/ribera/fault_detection_enhanced.json';
import irradianceComparison from '../../../public/data/soiling/ribera/quality/irradiance_comparison.json';
import { buildSoilingThread } from './soilingThread';
import { buildIrradianceQualityThread } from './irradianceThread';
import { buildManualsThread } from './manualsThread';
import { buildComposeReportThread } from './composeReportThread';
import { buildContractsThread } from './contractsThread';
import { buildReportScheduleDraft } from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';

/**
 * Example sessions for Ribera Solar Park (dev-only /demo surface). All
 * numbers are computed from the shipped fixture JSON — the same files the
 * demo dashboard renders — so the thread can never contradict the charts.
 */

const PLANT = { id: 'ribera', slug: 'ribera', name: 'Ribera Solar Park' };

const cleaningThread = buildSoilingThread({
  fixture: srForecast as any,
  plant: PLANT,
  surface: 'demo',
});

// ── Fault triage thread — built from the top RUL prediction in the shipped
// fault fixture (the same entry the Faults page and alarm stack render).
function buildFaultThread(): DemoThread {
  const preds: any[] = (faults as any).rul_predictions ?? [];
  const top =
    preds.find((p) => p.inverter_id && p.days_to_fault != null && p.recommended_action) ??
    preds[0];

  const confidence = Number(top.numeric_evidence?.ai_synthesised_confidence ?? top.confidence);
  const classification = {
    inverterId: top.inverter_id,
    plantId: PLANT.slug,
    likelyCause: String(top.fault_type ?? 'unknown').toUpperCase(),
    confidence,
    etaDays: top.days_to_fault ?? null,
    projectedEnergyLossKwhPerDay: null as number | null,
    evidence: [
      `${top.display_name}: ${top.current_value}${top.unit ? ` ${top.unit}` : ''} vs threshold ${top.threshold}`,
      String(top.evidence ?? '').slice(0, 180),
      `Recommended: ${top.recommended_action}`,
    ].filter(Boolean),
    recommendedAction: top.urgency === 'monitoring' ? 'MONITOR' : 'INSPECT',
  };

  const etaDays = String(top.days_to_fault);
  const confPct = String(Math.round(confidence * 100));
  const repairEur = String(top.repair_cost_eur);

  const ticketDraft = {
    kind: 'ticket_draft',
    draft: {
      plant_id: PLANT.id,
      plant_slug: PLANT.slug,
      plant_name: PLANT.name,
      inverter_id: top.inverter_id,
      title: `${top.display_name} on ${top.inverter_id}: schedule string inspection`,
      description: `${top.display_name} detected on ${top.inverter_id} with ${confPct}% confidence and an estimated ${etaDays} days to actionable fault. Current deviation ${top.current_value}${top.unit ? ` ${top.unit}` : ''} against a ${top.threshold} threshold. ${top.recommended_action} Estimated repair cost ${repairEur} EUR.`,
      priority: 'MEDIUM',
      trigger_type: 'PERFORMANCE_ANOMALY',
      estimated_energy_loss_kwh: null as number | null,
      estimated_revenue_impact_eur: null as number | null,
    },
    note: 'This is a DRAFT. The user must press "Create" in the rendered card for it to be persisted.',
  };

  return {
    id: 'ribera-fault-triage',
    title: 'Anything failing I should look at?',
    prompt: `Anything failing at ${PLANT.name} I should look at?`,
    plantSlug: PLANT.slug,
    plantName: PLANT.name,
    surface: 'demo',
    messages: [
      userMsg(`Anything failing at ${PLANT.name} I should look at?`),
      assistantMsg([
        textPart(`Let me run the fault classifier on the flagged inverter.`),
        toolPart(
          'getInverterClassification',
          { plantId: PLANT.slug, inverterId: top.inverter_id },
          classification
        ),
        textPart(
          `One item is worth your attention. Inverter ${top.inverter_id} [[cite:chart|plant=${PLANT.slug}|inverter=${top.inverter_id}|metric=power_ac|range=30d]] shows ${top.display_name.toLowerCase()} at ${confPct}% confidence, with roughly ${etaDays} days before it becomes actionable. The deviation is still under threshold, so this is a planned intervention, not an emergency.\n\nI can open a ticket so it lands in the maintenance queue with the evidence attached.`
        ),
        toolPart(
          'proposeTicket',
          {
            plantId: PLANT.slug,
            inverterId: top.inverter_id,
            title: ticketDraft.draft.title,
            description: ticketDraft.draft.description,
            priority: 'MEDIUM',
            trigger_type: 'PERFORMANCE_ANOMALY',
          },
          ticketDraft
        ),
        textPart(`The draft ticket is ready above. It is only created when you press Create.`),
      ]),
    ],
  };
}

// ── Weekly report thread — the draft is deterministic from its inputs (the
// same buildReportScheduleDraft the live tool uses); recipient is a
// placeholder, never a real address.
function buildReportThread(): DemoThread {
  const reportDraft = buildReportScheduleDraft({
    name: null,
    plant: PLANT,
    schedule: 'weekly',
    dayOfWeek: 1,
    period: 'last_7d',
    recipients: ['you@yourcompany.com'],
  });

  return {
    id: 'ribera-weekly-report',
    title: 'Email me a weekly report',
    prompt: `Email me a weekly report on ${PLANT.name} every Monday morning`,
    plantSlug: PLANT.slug,
    plantName: PLANT.name,
    surface: 'demo',
    messages: [
      userMsg(`Email me a weekly report on ${PLANT.name} every Monday morning`),
      assistantMsg([
        textPart(`I will set up a recurring report draft for you to confirm.`),
        toolPart(
          'proposeReportSchedule',
          { plantId: PLANT.slug, schedule: 'weekly', dayOfWeek: 1, period: 'last_7d' },
          reportDraft
        ),
        textPart(
          `A draft schedule is ready above: a weekly performance report filtered to ${PLANT.name}, covering the last 7 days, sent every Monday at 07:00 UTC. I defaulted the recipient to your own address; you can add teammates in the card.\n\nNothing is scheduled until you press Schedule. Once confirmed, you can manage or pause it any time from the Reports page.`
        ),
      ]),
    ],
  };
}

const irradianceThread = buildIrradianceQualityThread({
  fixture: irradianceComparison,
  plant: PLANT,
  surface: 'demo',
});

const threads: DemoThread[] = [
  cleaningThread,
  buildFaultThread(),
  irradianceThread,
  buildReportThread(),
  buildManualsThread({ plant: PLANT, surface: 'demo' }),
  buildComposeReportThread({ plant: PLANT, surface: 'demo' }),
  buildContractsThread({ plant: PLANT, surface: 'demo' }),
];
export default threads;
