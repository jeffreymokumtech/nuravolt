import portfolioFinancial from '../../../public/data/portfolio_financial.json';
import { buildReportScheduleDraft } from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';

/**
 * Flagship portfolio-triage example session. Every numeral is computed from
 * public/data/portfolio_financial.json — the same file the demo portfolio
 * dashboard and the report cron read — so the thread can never contradict
 * them. Shown in the curated example-session list (dashboard rail included).
 */

const plants: any[] = (portfolioFinancial as any).plants ?? [];

const assetType = (t: string) => (t === 'SOLAR' ? 'PV' : t);

const listOutput = {
  count: plants.length,
  plants: plants.map((p) => ({
    id: p.plantId,
    slug: p.plantId,
    name: p.plantName,
    asset_type: assetType(String(p.assetType ?? 'SOLAR')),
    status: p.status ?? 'active',
    capacity_mw: p.capacity_MW,
    location: p.location ?? null,
    country: null as string | null,
  })),
};

const totalMw = plants.reduce((s, p) => s + (p.capacity_MW ?? 0), 0);
const totalAtRiskEur = plants.reduce(
  (s, p) => s + (p.financials?.revenue_at_risk_eur ?? 0),
  0
);
const worst = [...plants].sort(
  (a, b) => (b.riskScore?.overall ?? 0) - (a.riskScore?.overall ?? 0)
)[0];
const worstAtRisk = Math.round(worst.financials?.revenue_at_risk_eur ?? 0);
const worstFaultComponent = worst.riskScore?.components?.fault_frequency ?? null;

const fmtK = (v: number) => `${Math.round(v / 1000)}k`;

const ticketDraft = {
  kind: 'ticket_draft',
  draft: {
    plant_id: worst.plantId,
    plant_slug: worst.plantId,
    plant_name: worst.plantName,
    inverter_id: null as string | null,
    title: `Investigate elevated fault frequency at ${worst.plantName}`,
    description: `${worst.plantName} carries the highest risk score in the portfolio (${worst.riskScore.overall} of 100, level ${worst.riskScore.level}), driven mainly by a fault frequency component of ${worstFaultComponent}. Estimated revenue at risk is ${worstAtRisk} EUR. Review the recent fault detections and confirm whether a site inspection is needed before the next scheduled visit.`,
    priority: 'HIGH',
    trigger_type: 'PERFORMANCE_ANOMALY',
    estimated_energy_loss_kwh: null as number | null,
    estimated_revenue_impact_eur: worstAtRisk,
  },
  note: 'This is a DRAFT. The user must press "Create" in the rendered card for it to be persisted.',
};

const triageThread: DemoThread = {
  id: 'portfolio-morning-triage',
  title: 'Which plants need attention today?',
  prompt: 'Good morning. Which plants need attention today?',
  plantSlug: 'portfolio',
  plantName: 'Demo portfolio',
  surface: 'demo',
  messages: [
    userMsg('Good morning. Which plants need attention today?'),
    assistantMsg([
      textPart(`Let me pull up the fleet.`),
      toolPart('listPlants', {}, listOutput),
      textPart(
        `Here is the morning picture across your ${listOutput.count} assets (${totalMw.toFixed(1)} MW). Total revenue at risk across the portfolio is about ${fmtK(totalAtRiskEur)} EUR right now.\n\nOne plant stands out: ${worst.plantName} carries the highest risk score at ${worst.riskScore.overall} of 100, driven mainly by fault frequency, with roughly ${fmtK(worstAtRisk)} EUR of revenue at risk. Everything else is in the low band this morning.\n\nI would put ${worst.plantName} at the top of the list. I have drafted a ticket so the investigation lands in the maintenance queue.`
      ),
      toolPart(
        'proposeTicket',
        {
          plantId: worst.plantId,
          title: ticketDraft.draft.title,
          description: ticketDraft.draft.description,
          priority: 'HIGH',
          trigger_type: 'PERFORMANCE_ANOMALY',
        },
        ticketDraft
      ),
      textPart(
        `The draft is above. Nothing is created until you press Create. Want me to look at any plant in more depth?`
      ),
    ]),
  ],
};

// ── Money-leak sweep: leads with the fleet's euro losses and closes with a
// recurring-report draft. Every euro figure is a sum over the fixture.
const totalSoilingEur = plants.reduce(
  (s, p) => s + (p.financials?.soiling_loss_eur ?? 0),
  0
);
const totalFaultEur = plants.reduce(
  (s, p) => s + (p.financials?.fault_loss_eur ?? 0),
  0
);
const worstSoiling = [...plants].sort(
  (a, b) => (b.financials?.soiling_loss_eur ?? 0) - (a.financials?.soiling_loss_eur ?? 0)
)[0];
const worstFault = [...plants].sort(
  (a, b) => (b.financials?.fault_loss_eur ?? 0) - (a.financials?.fault_loss_eur ?? 0)
)[0];

const monthlyReportDraft = buildReportScheduleDraft({
  name: 'Monthly portfolio loss report',
  plant: null,
  schedule: 'monthly',
  dayOfMonth: 1,
  period: 'last_month',
  recipients: ['you@yourcompany.com'],
  includeSummary: true,
  includeRisk: true,
  includeLosses: true,
});

const moneyThread: DemoThread = {
  id: 'portfolio-money-leaks',
  title: 'Where are we losing money?',
  prompt: 'Where are we losing money across the portfolio right now?',
  plantSlug: 'portfolio',
  plantName: 'Demo portfolio',
  surface: 'demo',
  messages: [
    userMsg('Where are we losing money across the portfolio right now?'),
    assistantMsg([
      textPart(`Let me sweep the fleet financials.`),
      toolPart('listPlants', {}, listOutput),
      textPart(
        `Three leaks stand out across your ${listOutput.count} assets.\n\n1. Soiling is the biggest controllable loss: about ${fmtK(totalSoilingEur)} EUR across the fleet, and ${worstSoiling.plantName} alone accounts for ${fmtK(worstSoiling.financials.soiling_loss_eur)} EUR of it. That is recoverable with a cleaning round; the optimizer can price the exact window.\n\n2. Fault-related losses total about ${fmtK(totalFaultEur)} EUR, led by ${worstFault.plantName} at ${fmtK(worstFault.financials.fault_loss_eur)} EUR. Worth a look at its open fault list before the next site visit.\n\n3. Total revenue at risk sits near ${fmtK(totalAtRiskEur)} EUR when you fold in availability and budget deviation.\n\nIf you want this in your inbox instead of having to ask, I can set up a monthly loss report. A draft is ready below.`
      ),
      toolPart(
        'proposeReportSchedule',
        { name: 'Monthly portfolio loss report', schedule: 'monthly', dayOfMonth: 1, period: 'last_month' },
        monthlyReportDraft
      ),
      textPart(
        `Nothing sends until you press Schedule. From there it arrives on the 1st of each month with the loss breakdown attached.`
      ),
    ]),
  ],
};

const threads: DemoThread[] = [triageThread, moneyThread];
export default threads;
