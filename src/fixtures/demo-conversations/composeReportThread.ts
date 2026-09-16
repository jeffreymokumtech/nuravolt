import {
  buildReportScheduleDraft,
  shapeReportSummary,
  type ToolPlantRef,
} from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';

/**
 * Report-composition example session: create a report, add a chart, schedule
 * it monthly. Entirely structural — no metric values are claimed, so every
 * output is a deterministic shaper product (no fixture JSON needed). Cards
 * are inert in scripted replays; the honesty footer covers the rest.
 */

export function buildComposeReportThread(args: {
  plant: ToolPlantRef;
  surface: 'demo' | 'showcase';
}): DemoThread {
  const { plant, surface } = args;

  const reportId = `seed-report-${plant.slug}-monthly`;
  const baseReport = {
    id: reportId,
    slug: `${plant.slug}-monthly-ops`,
    title: `${plant.name} monthly ops report`,
    scope_plant_ids: [plant.slug],
    default_range: 'last_30d',
  };

  const emptySummary = shapeReportSummary({ ...baseReport, widgets: [] });
  const withChart = shapeReportSummary({
    ...baseReport,
    widgets: [
      {
        id: 'w_demo_pwr1',
        type: 'chart.timeseries',
        x: 0,
        y: 0,
        w: 8,
        h: 6,
        config: {
          title: 'Plant AC power, predicted vs actual',
          plantIds: [plant.slug],
          range: 'last_30d',
          options: { metric: 'power_ac' },
        },
      },
    ],
  });

  const scheduleDraft = buildReportScheduleDraft({
    name: null,
    plant: null,
    dashboard: { id: reportId, title: baseReport.title },
    schedule: 'monthly',
    dayOfMonth: 1,
    period: 'last_month',
    recipients: ['you@yourcompany.com'],
  });

  return {
    id: `${plant.slug}-compose-report`,
    title: 'Build and schedule a custom report',
    prompt: `Build me a monthly report for ${plant.name} with a power chart, and email it on the 1st`,
    plantSlug: plant.slug,
    plantName: plant.name,
    surface,
    messages: [
      userMsg(`Build me a monthly report for ${plant.name} with a power chart, and email it on the 1st`),
      assistantMsg([
        textPart(`I will set that up. First the report itself.`),
        toolPart('createReport', { title: baseReport.title, plantId: plant.slug, range: 'last_30d' }, emptySummary),
        textPart(`Report created. Now the power chart.`),
        toolPart(
          'addReportChart',
          { plantId: plant.slug, metric: 'power_ac', range: 'last_30d', title: 'Plant AC power, predicted vs actual' },
          withChart
        ),
        textPart(
          `The report now has one chart: predicted vs actual AC power over the last 30 days. You can watch and edit it live in the composer drawer, drag it around, or ask me to add more charts, for example daily energy or irradiance.\n\nLast step: the monthly email.`
        ),
        toolPart(
          'proposeReportSchedule',
          { reportId, schedule: 'monthly', dayOfMonth: 1, period: 'last_month' },
          scheduleDraft
        ),
        textPart(
          `A draft schedule is ready above: this composed report, emailed as a PDF on the 1st of each month at 07:00 UTC. Nothing sends until you press Schedule.`
        ),
      ]),
    ],
  };
}
