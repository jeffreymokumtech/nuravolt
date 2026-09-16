import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import prisma from '@/libs/prisma';
import {
  resolvePlantOrDeny,
  type ChatAccessContext,
} from '@/lib/ai/access-control';
import { chartMetricMeta, CHART_METRIC_KEYS } from '@/lib/reports/chart-metrics';
import { widgetDefaultLayout } from '@/lib/reports/widget-defaults';
import { slugifyDashboardTitle } from '@/lib/reports/slug';
import { expandDateRange, type DateRangePreset } from '@/types/dashboard';
import { buildAlarmDraft, shapeChartOutput, shapeReportSummary } from '@/lib/ai/tool-shapes';
import { mergeSettings } from '@/lib/plants/settings';

/**
 * Chart + report-composition tools, spread-merged into buildChatTools.
 * Lives in its own file so the (OOM-prone) chat-tools.ts stays bounded and
 * scoped tsc configs can include this file.
 */

const denied = (reason: string, detail?: string) => ({
  error: reason,
  ...(detail ? { detail } : {}),
});

const RANGE_PRESETS = ['last_7d', 'last_14d', 'last_30d', 'last_month'] as const;

/** Mirror of the dashboards routes' ownership rule for the chat identity. */
function ownsReport(
  d: { organization_id: string | null; owner_id: string | null },
  ctx: ChatAccessContext
): boolean {
  if (d.organization_id === ctx.orgClerkId || d.owner_id === ctx.userClerkId) return true;
  return (
    process.env.NODE_ENV === 'development' &&
    d.organization_id === null &&
    d.owner_id === null
  );
}

async function loadOwnedReport(idOrSlug: string, ctx: ChatAccessContext) {
  const d = await prisma.dashboard.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  });
  if (!d || !ownsReport(d, ctx)) return null;
  return d;
}

const widgetId = () => `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * Serialize widget mutations per report. The model can emit several
 * addReportChart calls in ONE step and the AI SDK executes same-step tools
 * concurrently — a plain read-modify-write on the widgets JSON loses
 * updates (observed live: 3 adds, 2 widgets persisted). A SELECT ... FOR
 * UPDATE inside an interactive transaction makes each mutation atomic.
 */
async function mutateReportWidgets(
  reportId: string,
  mutate: (widgets: any[]) => any[] | { error: string; detail?: string }
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Dashboard" WHERE id = ${reportId} FOR UPDATE`;
    const fresh = await tx.dashboard.findUnique({ where: { id: reportId } });
    if (!fresh) return { error: 'not_found' as const };
    const current: any[] = Array.isArray(fresh.widgets) ? (fresh.widgets as any[]) : [];
    const next = mutate(current);
    if (!Array.isArray(next)) return next;
    const updated = await tx.dashboard.update({
      where: { id: reportId },
      data: { widgets: next },
    });
    return { updated };
  });
}

export function buildChartAndReportTools(
  ctx: ChatAccessContext,
  origin: string,
  activeReportId?: string | null
): ToolSet {
  return {
    getChart: tool({
      description:
        `Fetch a timeseries chart for a plant (or one inverter) over a date range and render it inline. Metrics: ${CHART_METRIC_KEYS.join(', ')}. Twin metrics (power_ac, temperature, voltage_dc, current_dc) return predicted vs actual from the digital twin; the others return measured daily telemetry. Use for any "show me / graph / chart / plot X" request. The output includes a widget_config that addReportChart can use to add this exact chart to a report.`,
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        inverterId: z
          .string()
          .optional()
          .describe('Inverter id from listInverters for a device-level chart. Omit for plant level.'),
        metric: z.enum(CHART_METRIC_KEYS).describe('What to chart.'),
        range: z
          .enum(RANGE_PRESETS)
          .default('last_30d')
          .describe('Time window preset.'),
      }),
      execute: async ({ plantId, inverterId, metric, range }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);
        const meta = chartMetricMeta(metric);
        if (!meta) {
          return denied('unknown_metric', `Metric must be one of: ${CHART_METRIC_KEYS.join(', ')}`);
        }

        const { from, to } = expandDateRange(range as DateRangePreset);
        const headers = {
          'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '',
        };

        try {
          let points: Array<{ date: string; actual: number | null; predicted: number | null }>;

          if (meta.source === 'twin') {
            const url = new URL(
              `/api/digitaltwin/${encodeURIComponent(plant.slug)}/timeseries`,
              origin
            );
            url.searchParams.set('device_id', inverterId ?? 'PLANT');
            url.searchParams.set('metric', metric);
            url.searchParams.set('from', from);
            url.searchParams.set('to', to);
            const res = await fetch(url.toString(), { headers });
            if (!res.ok) return denied('chart_unavailable', `HTTP ${res.status}`);
            const data = await res.json();
            points = (data?.series ?? []).map((r: any) => ({
              date: String(r.date).slice(0, 10),
              actual: typeof r.actual === 'number' ? r.actual : null,
              predicted: typeof r.predicted === 'number' ? r.predicted : null,
            }));
          } else {
            const url = new URL(`/api/measurements/${encodeURIComponent(plant.slug)}`, origin);
            url.searchParams.set('metrics', metric);
            url.searchParams.set('resolution', 'daily');
            url.searchParams.set('from', from);
            url.searchParams.set('to', to);
            if (inverterId) url.searchParams.set('devices', inverterId);
            const res = await fetch(url.toString(), { headers });
            if (!res.ok) return denied('chart_unavailable', `HTTP ${res.status}`);
            const data = await res.json();
            const byDate = new Map<string, { sum: number; n: number }>();
            for (const row of data?.data ?? []) {
              const d = String(row.bucket ?? row.timestamp ?? '').slice(0, 10);
              const v = Number(row.avg_value ?? row.value);
              if (!d || !Number.isFinite(v)) continue;
              const cur = byDate.get(d) ?? { sum: 0, n: 0 };
              cur.sum += v;
              cur.n += 1;
              byDate.set(d, cur);
            }
            points = Array.from(byDate.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, { sum, n }]) => ({
                date,
                actual: sum / n,
                predicted: null as number | null,
              }));
          }

          if (points.length === 0) {
            return {
              plant: { id: plant.id, slug: plant.slug, name: plant.name },
              metric,
              range,
              no_data: true,
              note: `No ${meta.label.toLowerCase()} data for ${inverterId ?? plant.name} in ${range}. Say so plainly; never invent values.`,
            };
          }

          return shapeChartOutput(points, {
            plant,
            metric,
            unit: meta.unit,
            label: meta.label,
            deviceId: inverterId ?? null,
            range,
          });
        } catch (e) {
          return denied('chart_unavailable', e instanceof Error ? e.message : 'fetch failed');
        }
      },
    }),

    createReport: tool({
      description:
        'Create a new custom report (an editable dashboard of chart widgets). PERSISTS immediately and opens in the composer drawer. Use when the user wants to start building/composing a report. After creating, add charts with addReportChart.',
      inputSchema: z.object({
        title: z.string().min(3).max(80),
        plantId: z
          .string()
          .optional()
          .describe('Default plant scope for the report. Omit for none.'),
        range: z.enum(RANGE_PRESETS).default('last_30d'),
      }),
      execute: async ({ title, plantId, range }) => {
        let plantSlug: string | null = null;
        if (plantId) {
          const plant = resolvePlantOrDeny(ctx, plantId);
          if (!plant) return denied('access_denied', `No access to ${plantId}.`);
          plantSlug = plant.slug;
        }
        const row = await prisma.dashboard.create({
          data: {
            slug: slugifyDashboardTitle(title),
            title,
            owner_id: ctx.userClerkId === 'demo_user' ? null : ctx.userClerkId,
            organization_id: ctx.userClerkId === 'demo_user' ? null : ctx.orgClerkId,
            scope_plant_ids: plantSlug ? [plantSlug] : [],
            scope_device_ids: [],
            default_range: range,
            widgets: [],
          },
        });
        return shapeReportSummary(row as any);
      },
    }),

    addReportChart: tool({
      description:
        'Add a chart widget to a report. PERSISTS immediately (the composer drawer updates live). Typically called right after getChart with the same plant/metric/range ("add that to my report"). widgetType defaults to the generic metric chart; other types: pv.expected_vs_measured, pv.loss_waterfall, pv.residual_heatmap, bess.soh_history, bess.dispatch, bess.warranty_status, kpi.single_metric, contracts.status (contract obligations with on-track / at-risk / breach pills).',
      inputSchema: z.object({
        reportId: z
          .string()
          .optional()
          .describe('Report id or slug. Omit to use the active report from the conversation.'),
        plantId: z.string().describe('Plant id or slug this chart is scoped to.'),
        metric: z.enum(CHART_METRIC_KEYS).optional().describe('Metric for chart.timeseries.'),
        inverterId: z.string().optional(),
        range: z.enum(RANGE_PRESETS).optional(),
        title: z.string().max(80).optional().describe('Widget title shown on the report.'),
        widgetType: z.string().default('chart.timeseries'),
      }),
      execute: async ({ reportId, plantId, metric, inverterId, range, title, widgetType }) => {
        const targetId = reportId ?? activeReportId;
        if (!targetId) {
          return denied(
            'no_active_report',
            'No report is active. Call createReport first (or ask the user which report).'
          );
        }
        const report = await loadOwnedReport(targetId, ctx);
        if (!report) return denied('not_found', `Report ${targetId} not found.`);
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);
        if (widgetType === 'chart.timeseries' && (!metric || !chartMetricMeta(metric))) {
          return denied('unknown_metric', `chart.timeseries needs a metric from: ${CHART_METRIC_KEYS.join(', ')}`);
        }

        const result = await mutateReportWidgets(report.id, (widgets) => {
          const maxY = widgets.reduce((m, w) => Math.max(m, (w.y ?? 0) + (w.h ?? 0)), 0);
          const layout = widgetDefaultLayout(widgetType);
          return [
            ...widgets,
            {
              id: widgetId(),
              type: widgetType,
              x: 0,
              y: maxY,
              w: layout.w,
              h: layout.h,
              config: {
                ...(title ? { title } : {}),
                plantIds: [plant.slug],
                ...(inverterId ? { deviceIds: [inverterId] } : {}),
                ...(range ? { range } : {}),
                ...(widgetType === 'chart.timeseries' ? { options: { metric } } : {}),
              },
            },
          ];
        });
        if ('error' in result) return denied(result.error, (result as any).detail);
        return shapeReportSummary(result.updated as any);
      },
    }),

    updateReportWidget: tool({
      description:
        'Update a widget on a report (change its metric, range, plant, device, or title). PERSISTS immediately. Identify the widget by its id from getReport, or let the user describe it and pick the matching id yourself.',
      inputSchema: z.object({
        reportId: z.string().optional(),
        widgetId: z.string(),
        title: z.string().max(80).optional(),
        plantId: z.string().optional(),
        inverterId: z
          .string()
          .nullable()
          .optional()
          .describe('Set null to clear the device scope (back to plant level).'),
        metric: z.enum(CHART_METRIC_KEYS).optional(),
        range: z.enum(RANGE_PRESETS).optional(),
      }),
      execute: async ({ reportId, widgetId: wid, title, plantId, inverterId, metric, range }) => {
        const targetId = reportId ?? activeReportId;
        if (!targetId) return denied('no_active_report', 'No report is active.');
        const report = await loadOwnedReport(targetId, ctx);
        if (!report) return denied('not_found', `Report ${targetId} not found.`);

        let plantSlug: string | undefined;
        if (plantId) {
          const plant = resolvePlantOrDeny(ctx, plantId);
          if (!plant) return denied('access_denied', `No access to ${plantId}.`);
          plantSlug = plant.slug;
        }

        const result = await mutateReportWidgets(report.id, (widgets) => {
          const w = widgets.find((x) => x.id === wid);
          if (!w) {
            return {
              error: 'widget_not_found',
              detail: `No widget ${wid} on this report. Call getReport for current ids.`,
            };
          }
          w.config = w.config ?? {};
          if (title !== undefined) w.config.title = title;
          if (plantSlug) w.config.plantIds = [plantSlug];
          if (inverterId === null) delete w.config.deviceIds;
          else if (inverterId) w.config.deviceIds = [inverterId];
          if (range) w.config.range = range;
          if (metric) w.config.options = { ...(w.config.options ?? {}), metric };
          return widgets;
        });
        if ('error' in result) return denied(result.error, (result as any).detail);
        return shapeReportSummary(result.updated as any);
      },
    }),

    removeReportWidget: tool({
      description: 'Remove a widget from a report. PERSISTS immediately.',
      inputSchema: z.object({
        reportId: z.string().optional(),
        widgetId: z.string(),
      }),
      execute: async ({ reportId, widgetId: wid }) => {
        const targetId = reportId ?? activeReportId;
        if (!targetId) return denied('no_active_report', 'No report is active.');
        const report = await loadOwnedReport(targetId, ctx);
        if (!report) return denied('not_found', `Report ${targetId} not found.`);
        const result = await mutateReportWidgets(report.id, (widgets) => {
          const next = widgets.filter((x) => x.id !== wid);
          if (next.length === widgets.length) {
            return { error: 'widget_not_found', detail: `No widget ${wid} on this report.` };
          }
          return next;
        });
        if ('error' in result) return denied(result.error, (result as any).detail);
        return shapeReportSummary(result.updated as any);
      },
    }),

    listReports: tool({
      description: "List the user's reports (dashboards): id, title, widget count, updated time.",
      inputSchema: z.object({}),
      execute: async () => {
        const owned: any[] = [
          { organization_id: ctx.orgClerkId },
          { owner_id: ctx.userClerkId },
        ];
        if (process.env.NODE_ENV === 'development') {
          owned.push({ organization_id: null, owner_id: null });
        }
        const rows = await prisma.dashboard.findMany({
          where: { OR: owned },
          orderBy: { updated_at: 'desc' },
          take: 20,
        });
        return {
          count: rows.length,
          reports: rows.map((d) => ({
            report_id: d.id,
            slug: d.slug,
            title: d.title,
            widget_count: Array.isArray(d.widgets) ? (d.widgets as any[]).length : 0,
            updated_at: d.updated_at.toISOString(),
          })),
        };
      },
    }),

    proposeAlarm: tool({
      description:
        'Draft a change to a plant\'s alarm thresholds for the user to review and confirm. THIS DOES NOT PERSIST — it renders a confirm card. Alarms are STRICTLY: soiling-loss threshold (percent, "SR below 0.93" means soilingLossPct 7), performance-ratio threshold (percent), and the critical-email toggle. Plant-wide only, evaluated hourly; only newly critical breaches email org managers. There are NO per-inverter alarms, NO custom metrics, NO custom recipients, and the data-staleness alarm is fixed at 6 hours — decline such requests plainly instead of calling this tool.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        soilingLossPct: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe('New soiling-loss alarm threshold in percent (SR 0.95 = 5).'),
        performanceRatioPct: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('New performance-ratio alarm threshold in percent.'),
        emailCritical: z
          .boolean()
          .optional()
          .describe('Email org managers on newly critical breaches.'),
      }),
      execute: async ({ plantId, soilingLossPct, performanceRatioPct, emailCritical }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);
        if (soilingLossPct == null && performanceRatioPct == null && emailCritical == null) {
          return denied('nothing_to_change', 'Provide at least one threshold or the email toggle.');
        }

        const row = await prisma.plant
          .findUnique({ where: { id: plant.id }, select: { metadata: true } })
          .catch(() => null);
        const settings = mergeSettings((row?.metadata as any)?.settings);

        return buildAlarmDraft({
          plant,
          current: {
            soilingLossPct: settings.alerts.soilingLossPct,
            performanceRatioPct: settings.alerts.performanceRatioPct,
            emailCritical: settings.notifications.emailCritical,
          },
          soilingLossPct: soilingLossPct ?? null,
          performanceRatioPct: performanceRatioPct ?? null,
          emailCritical: emailCritical ?? null,
        });
      },
    }),

    getReport: tool({
      description:
        "Get a report's current state (title, scope, widget list with ids). Call before updating/removing widgets, or when the user asks what is in the report. Cheap — no chart data.",
      inputSchema: z.object({
        reportId: z
          .string()
          .optional()
          .describe('Report id or slug. Omit for the active report.'),
      }),
      execute: async ({ reportId }) => {
        const targetId = reportId ?? activeReportId;
        if (!targetId) return denied('no_active_report', 'No report is active. Use listReports or createReport.');
        const report = await loadOwnedReport(targetId, ctx);
        if (!report) return denied('not_found', `Report ${targetId} not found.`);
        return shapeReportSummary(report as any);
      },
    }),
  };
}
