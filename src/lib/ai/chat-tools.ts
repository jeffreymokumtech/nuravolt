import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import prisma from '@/libs/prisma';
import {
  resolvePlantOrDeny,
  type ChatAccessContext,
} from '@/lib/ai/access-control';
import { searchKB } from '@/lib/ai/kb-search';
import { buildChartAndReportTools } from '@/lib/ai/chat-tools-reports';
import { buildContractTools } from '@/lib/ai/chat-tools-contracts';
import {
  buildReportScheduleDraft,
  shapeBessRevenueOutput,
  shapeIrradianceQualityOutput,
  shapeOptimizerRunOutput,
  shapeSoilingForecastOutput,
} from '@/lib/ai/tool-shapes';
import { optimizeSchedule } from '@/lib/soiling/optimizeSchedule';
import { fetchRainForecast } from '@/lib/soiling/rainForecast';

/**
 * Standard error envelope returned by any tool that refuses to act. The model
 * sees these and stops gracefully (per the system prompt).
 */
const denied = (reason: string, detail?: string) => ({
  error: reason,
  ...(detail ? { detail } : {}),
});

export function buildChatTools(
  ctx: ChatAccessContext,
  origin: string,
  activeReportId?: string | null
): ToolSet {
  return {
    // Chart + report-composition tools live in chat-tools-reports.ts.
    ...buildChartAndReportTools(ctx, origin, activeReportId),
    // Contract intelligence + BESS guardian tools live in chat-tools-contracts.ts.
    ...buildContractTools(ctx, origin),

    listPlants: tool({
      description:
        'List the plants the current user has access to. Use this whenever the user asks "what plants do I have", names a plant by partial name, or before any plant-scoped tool call to discover the right plant id.',
      inputSchema: z.object({
        assetType: z
          .enum(['PV', 'BESS', 'WIND', 'HYBRID'])
          .optional()
          .describe('Filter by asset type. Omit for all.'),
      }),
      execute: async ({ assetType }) => {
        const filtered = assetType
          ? ctx.plants.filter((p) => p.asset_type === assetType)
          : ctx.plants;
        return {
          count: filtered.length,
          plants: filtered.map((p) => ({
            id: p.id,
            slug: p.slug,
            name: p.name,
            asset_type: p.asset_type,
            status: p.status,
            capacity_mw: p.capacity_mw,
            location: p.location_name,
            country: p.country,
          })),
        };
      },
    }),

    getSoilingForecast: tool({
      description:
        'Get the soiling forecast for a plant. Returns daily predicted soiling ratio (SR), confidence bounds, cleaning recommendations, and (optionally) weather-driven recovery events. Always cite the dates in the response.',
      inputSchema: z.object({
        plantId: z
          .string()
          .describe('Plant id or slug returned from listPlants.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe('Forecast horizon in days. Default 30, max 365.'),
        includeWeather: z
          .boolean()
          .default(false)
          .describe(
            'Include 7-day weather-adjusted recovery events (rain). Slower.'
          ),
      }),
      execute: async ({ plantId, days, includeWeather }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);

        const url = new URL(
          `/api/soiling/plants/${plant.slug}/forecast`,
          origin
        );
        url.searchParams.set('days', String(days));
        if (includeWeather) url.searchParams.set('weather', 'true');

        try {
          const headers = {
            'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '',
          };
          // Fetch the observed summary alongside the forecast: a provisional
          // climate-transfer forecast can start near clean while the fleet is
          // measurably dirty, and answering from the forecast alone would
          // contradict the soiling page. Fail-soft — the forecast still
          // answers without it.
          const [res, summaryRes] = await Promise.all([
            fetch(url.toString(), { headers }),
            fetch(
              new URL(`/api/soiling/plants/${plant.slug}/summary`, origin).toString(),
              { headers }
            ).catch(() => null),
          ]);
          if (!res.ok) {
            return denied('forecast_unavailable', `HTTP ${res.status}`);
          }
          const data = await res.json();
          let observed: {
            fleet_sr: number | null;
            estimated_loss_pct: number | null;
            next_cleaning_recommended: string | null;
            expected_net_benefit_eur: number | null;
          } | null = null;
          if (summaryRes?.ok) {
            const summary = await summaryRes.json().catch(() => null);
            const cur = summary?.currentStatus;
            const econ = summary?.economicImpact;
            if (cur || econ) {
              observed = {
                fleet_sr: cur?.avgSoilingRatio ?? null,
                estimated_loss_pct: cur?.estimatedLossPct ?? null,
                next_cleaning_recommended: econ?.nextCleaningRecommended ?? null,
                expected_net_benefit_eur: econ?.expectedNetBenefit_EUR ?? null,
              };
            }
          }

          // The route returns { forecasts: [{ date, soilingRatio, lowerBound,
          // upperBound, soilingLossPct, cleaningRecommended, ... }] }. Output
          // shaping is shared with the scripted demo threads (tool-shapes.ts).
          const forecast: any[] = Array.isArray(data?.forecasts)
            ? data.forecasts
            : Array.isArray(data?.forecast)
              ? data.forecast
              : [];
          const nextRain = includeWeather
            ? (data?.weather ?? data?.weatherForecast)?.find?.((w: any) => w.is_rain_event)
                ?.date ?? null
            : null;
          return shapeSoilingForecastOutput(
            forecast,
            plant,
            days,
            data?._source ?? null,
            nextRain,
            observed
          );
        } catch (e) {
          return denied(
            'forecast_unavailable',
            e instanceof Error ? e.message : 'fetch failed'
          );
        }
      },
    }),

    listTickets: tool({
      description:
        'List tickets for the org with optional plant/status/priority filters. Use this when the user asks about open work, validation queues, or recent issues.',
      inputSchema: z.object({
        plantId: z
          .string()
          .optional()
          .describe('Plant id or slug. Omit for all accessible plants.'),
        status: z
          .array(
            z.enum([
              'NEW',
              'VALIDATED',
              'ASSIGNED',
              'IN_PROGRESS',
              'DONE',
              'WONT_FIX',
            ])
          )
          .optional(),
        priority: z
          .array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']))
          .optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ plantId, status, priority, limit }) => {
        let plantUuid: string | undefined;
        if (plantId) {
          const plant = resolvePlantOrDeny(ctx, plantId);
          if (!plant)
            return denied('access_denied', `No access to ${plantId}.`);
          plantUuid = plant.id;
        }

        const accessibleUuids = ctx.plants.map((p) => p.id);
        if (accessibleUuids.length === 0) {
          return { count: 0, tickets: [] };
        }

        const tickets = await prisma.ticket.findMany({
          where: {
            org_clerk_id: ctx.orgClerkId,
            plant_id: plantUuid ? plantUuid : { in: accessibleUuids },
            ...(status?.length ? { status: { in: status } } : {}),
            ...(priority?.length ? { priority: { in: priority } } : {}),
          },
          orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
          take: limit,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            trigger_type: true,
            plant_id: true,
            inverter_id: true,
            assigned_to_clerk_id: true,
            estimated_revenue_impact_eur: true,
            created_at: true,
          },
        });

        return {
          count: tickets.length,
          tickets: tickets.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            trigger: t.trigger_type,
            plant_id: t.plant_id,
            inverter_id: t.inverter_id,
            assignee: t.assigned_to_clerk_id,
            revenue_impact_eur: t.estimated_revenue_impact_eur
              ? Number(t.estimated_revenue_impact_eur)
              : null,
            created_at: t.created_at.toISOString(),
          })),
        };
      },
    }),

    searchKnowledgeBase: tool({
      description:
        'Search the organization\'s uploaded knowledge base (manuals, datasheets, runbooks, prior incident reports) for passages relevant to the user\'s question. Use this BEFORE answering any question that depends on equipment specs, fault codes, OEM procedures, or organisation-specific documentation. Cite the document title and chunk_index when you use the result.',
      inputSchema: z.object({
        query: z
          .string()
          .min(3)
          .describe(
            'A natural-language search query. Be specific: include component names, fault codes, or symptoms.'
          ),
        plantId: z
          .string()
          .optional()
          .describe(
            'Optional plant id/slug to bias toward plant-specific docs. Org-wide docs are always included.'
          ),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, plantId, limit }) => {
        let resolvedPlantId: string | undefined;
        if (plantId) {
          const plant = resolvePlantOrDeny(ctx, plantId);
          if (!plant)
            return denied('access_denied', `No access to ${plantId}.`);
          resolvedPlantId = plant.id;
        }

        try {
          const hits = await searchKB({
            orgClerkId: ctx.orgClerkId,
            query,
            limit,
            plantId: resolvedPlantId ?? null,
          });
          return {
            count: hits.length,
            results: hits.map((h) => ({
              document_id: h.document_id,
              document_title: h.document_title,
              file_name: h.file_name,
              chunk_index: h.chunk_index,
              similarity: Number(h.similarity.toFixed(3)),
              excerpt: h.content.slice(0, 600),
            })),
          };
        } catch (e) {
          return denied(
            'kb_search_failed',
            e instanceof Error ? e.message : 'unknown'
          );
        }
      },
    }),

    listInverters: tool({
      description:
        'List the inverters at a plant, with their model and rated capacity. ALWAYS call this BEFORE getInverterDiagnosis so you have a real inverter id — never invent inverter ids like "inv_001".',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
      }),
      execute: async ({ plantId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);

        const groups = await prisma.inverterGroup.findMany({
          where: { plant_id: plant.id },
          select: {
            id: true,
            name: true,
            tilt: true,
            azimuth: true,
            inverter_model: true,
            inverter_nominal_power_kw: true,
            inverters: {
              where: { enabled: true },
              select: {
                id: true,
                external_id: true,
                name: true,
                model: true,
                nominal_power_kw: true,
                serial_number: true,
              },
            },
          },
          orderBy: { name: 'asc' },
        });

        const inverters = groups.flatMap((g) =>
          g.inverters.map((inv) => ({
            id: inv.external_id, // canonical id for diagnosis tool
            uuid: inv.id,
            name: inv.name,
            group: g.name,
            model: inv.model ?? g.inverter_model ?? null,
            nominal_power_kw: inv.nominal_power_kw
              ? Number(inv.nominal_power_kw)
              : g.inverter_nominal_power_kw
              ? Number(g.inverter_nominal_power_kw)
              : null,
          }))
        );

        return {
          plant: { id: plant.id, slug: plant.slug, name: plant.name },
          count: inverters.length,
          inverters,
          note:
            inverters.length === 0
              ? 'This plant has no inverters configured in the database. Diagnosis tools will return no data.'
              : 'Use the `id` field as the inverterId argument for getInverterDiagnosis.',
        };
      },
    }),

    getInverterDiagnosis: tool({
      description:
        'Run AI diagnosis for a specific inverter using 30 days of digital-twin metrics. Returns severity, fault hypothesis, and recommended actions. PRECONDITION: Call `listInverters` first to obtain a real inverter id — never pass a guessed id. If the inverter list is empty, do NOT call this tool; tell the user diagnosis is not possible without inverter data.',
      inputSchema: z.object({
        plantId: z.string(),
        inverterId: z
          .string()
          .describe('Inverter id returned by listInverters — typically the external_id field.'),
      }),
      execute: async ({ plantId, inverterId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);

        const url = new URL(
          `/api/ai/inverter-diagnosis/${plant.slug}/${encodeURIComponent(inverterId)}`,
          origin
        );

        try {
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '' },
          });
          if (!res.ok) {
            return denied('diagnosis_unavailable', `HTTP ${res.status}`);
          }
          return await res.json();
        } catch (e) {
          return denied(
            'diagnosis_unavailable',
            e instanceof Error ? e.message : 'fetch failed'
          );
        }
      },
    }),

    getInverterClassification: tool({
      description:
        'Deterministic rule-based maintenance classification for one inverter. Returns likely cause (SOILING/SHADING/THERMAL/STRING_DEGRADATION/BYPASS_DIODE/INVERTER_DERATE/NORMAL), confidence, ETA in days, evidence strings, and the recommended action (CLEANING/INSPECTION/REPLACEMENT/MONITOR). Fast and free — call this BEFORE getInverterDiagnosis when the user asks "what is wrong with X" or "should we clean X", to get a grounded baseline you can cite verbatim. Use the inverter id from listInverters.',
      inputSchema: z.object({
        plantId: z.string(),
        inverterId: z.string().describe('Inverter id returned by listInverters.'),
      }),
      execute: async ({ plantId, inverterId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);
        const url = new URL(
          `/api/inverters/${encodeURIComponent(inverterId)}/classification`,
          origin,
        );
        url.searchParams.set('plant_id', plant.slug);
        try {
          const res = await fetch(url.toString(), {
            headers: { 'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '' },
          });
          if (!res.ok) return denied('classification_unavailable', `HTTP ${res.status}`);
          return await res.json();
        } catch (e) {
          return denied(
            'classification_unavailable',
            e instanceof Error ? e.message : 'fetch failed',
          );
        }
      },
    }),

    getIrradianceQuality: tool({
      description:
        'Assess how trustworthy a plant\'s on-site irradiance measurement is by comparing the on-site sensor track against the Open-Meteo satellite/reanalysis reference model over the analysis period. Returns correlation, bias, RMSE, a monthly trend, and quality alerts (calibration drift, systematic deviation). Use when the user asks about irradiance data quality, comparing irradiance tracks or sources, sensor trust, or whether the pyranometer needs recalibration. If the result says no_data, there is no on-site sensor — say so plainly and never invent numbers.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
      }),
      execute: async ({ plantId }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);

        const url = new URL(
          `/api/soiling/plants/${plant.slug}/quality/irradiance`,
          origin
        );
        url.searchParams.set('includeScatter', 'false');
        try {
          const res = await fetch(url.toString(), {
            headers: { 'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '' },
          });
          if (!res.ok) return denied('quality_unavailable', `HTTP ${res.status}`);
          const data = await res.json();
          // Output shaping shared with the scripted demo threads.
          return shapeIrradianceQualityOutput(data, plant);
        } catch (e) {
          return denied(
            'quality_unavailable',
            e instanceof Error ? e.message : 'fetch failed'
          );
        }
      },
    }),

    getBessRevenue: tool({
      description:
        'Return ancillary-services and wholesale revenue for a BESS plant over the last N days. Use for questions like "how much did <plant> earn from DC last week", "what\'s the BESS revenue stack", or "which service is the top earner". Reports per-service totals + daily mean. The breakdown of services covers Dynamic Containment, Dynamic Moderation, Dynamic Regulation, Balancing Mechanism, Capacity Market, and wholesale arbitrage. Works for any BESS asset with dispatch history or a revenue fixture; DB-backed plants may book everything under wholesale arbitrage.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(7)
          .describe('How many trailing days to aggregate. Caps at 30.'),
        by: z
          .enum(['service', 'day'])
          .default('service')
          .describe('Group the result by service totals (default) or by day.'),
      }),
      execute: async ({ plantId, days, by }) => {
        const plant = resolvePlantOrDeny(ctx, plantId);
        if (!plant) return denied('access_denied', `No access to ${plantId}.`);

        // The unified revenue route serves DB-backed org BESS plants (e.g.
        // dispatch-optimizer history) AND falls back to fixtures for
        // demo/showcase slugs — so the tool works everywhere the Revenue
        // Cockpit does. Day rows keep the same *_gbp field names in both
        // branches, so the shared shaper is unchanged.
        try {
          const url = new URL(`/api/bess/plants/${plant.slug}/revenue`, origin);
          url.searchParams.set('days', String(days));
          const res = await fetch(url.toString(), {
            headers: { 'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '' },
          });
          if (!res.ok) return denied('no_revenue_data', `HTTP ${res.status}`);
          const data = await res.json();
          const series: Array<Record<string, number | string>> =
            data?.series ?? data?.days ?? [];
          if (!series.length) {
            return denied(
              'no_revenue_data',
              `No revenue history for ${plant.slug} yet (no dispatch records or revenue fixture).`
            );
          }
          const currency = data?.plant?.currency ?? data?.currency ?? 'GBP';
          const shaped = shapeBessRevenueOutput({ currency, days: series }, plant, days, by);
          if (!shaped) {
            return denied('no_revenue_data', `No revenue data for ${plant.slug}.`);
          }
          return shaped;
        } catch (e) {
          return denied(
            'no_revenue_data',
            e instanceof Error ? e.message : 'revenue fetch failed'
          );
        }
      },
    }),

    proposeTicket: tool({
      description:
        'Draft a maintenance/inspection ticket for the user to review and confirm. THIS DOES NOT CREATE THE TICKET — it only renders an editable draft card in the UI. The user must click "Create" in the card to actually persist it. Use this whenever the user asks to "create a ticket", "open a maintenance issue", or to flag a problem for follow-up.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        inverterId: z
          .string()
          .optional()
          .describe('Inverter id when the ticket is inverter-specific.'),
        title: z.string().min(5).max(120).describe('Short, action-oriented title.'),
        description: z
          .string()
          .min(10)
          .describe(
            'One paragraph: what is happening, why it matters, what evidence supports it. Cite numeric values and dates from prior tool outputs.'
          ),
        priority: z
          .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
          .default('MEDIUM'),
        trigger_type: z
          .enum([
            'SOILING_FORECAST',
            'PERFORMANCE_ANOMALY',
            'THRESHOLD_ALERT',
            'SCHEDULED_MAINTENANCE',
            'MANUAL_CREATION',
          ])
          .describe(
            'What surfaced this. Use MANUAL_CREATION when the user simply asked you to draft a ticket.'
          ),
        estimated_energy_loss_kwh: z
          .number()
          .nonnegative()
          .optional()
          .describe('Only fill if a number was actually computed/reported.'),
        estimated_revenue_impact_eur: z
          .number()
          .nonnegative()
          .optional()
          .describe('Only fill if a number was actually computed/reported.'),
      }),
      execute: async (input) => {
        const plant = resolvePlantOrDeny(ctx, input.plantId);
        if (!plant) return denied('access_denied', `No access to ${input.plantId}.`);
        // Return the draft only — the chat UI renders this as a confirm card.
        return {
          kind: 'ticket_draft',
          draft: {
            plant_id: plant.id,
            plant_slug: plant.slug,
            plant_name: plant.name,
            inverter_id: input.inverterId ?? null,
            title: input.title,
            description: input.description,
            priority: input.priority,
            trigger_type: input.trigger_type,
            estimated_energy_loss_kwh: input.estimated_energy_loss_kwh ?? null,
            estimated_revenue_impact_eur: input.estimated_revenue_impact_eur ?? null,
          },
          note:
            'This is a DRAFT. The user must press "Create" in the rendered card for it to be persisted.',
        };
      },
    }),

    proposeReportSchedule: tool({
      description:
        'Set up a recurring emailed performance report (weekly or monthly PDF). This is THE tool for any request like "email me a weekly report", "send me a report every Friday", or "send the team a monthly summary" — you MUST call it for those requests; describing a schedule in text does nothing. It renders an editable draft card the user confirms with one click (nothing persists until they do). Reports send at 07:00 UTC on the chosen day; a plantId narrows the report to that plant. Pass reportId to schedule a COMPOSED report (the active report from the composer) — its dashboard PDF is emailed instead of the standard portfolio PDF.',
      inputSchema: z.object({
        name: z
          .string()
          .max(80)
          .optional()
          .describe('Short report name. Omit for a sensible default.'),
        reportId: z
          .string()
          .optional()
          .describe('Composed report (dashboard) id to attach — use the active report when the user says "schedule/email THIS report".'),
        plantId: z
          .string()
          .optional()
          .describe('Plant id or slug to scope the report to. Omit for the whole portfolio.'),
        schedule: z.enum(['weekly', 'monthly']),
        dayOfWeek: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe('Weekly only: 1=Monday .. 7=Sunday. Default 1.'),
        dayOfMonth: z
          .number()
          .int()
          .min(1)
          .max(28)
          .optional()
          .describe('Monthly only: day of month 1-28. Default 1.'),
        period: z
          .enum(['last_7d', 'last_30d', 'last_month'])
          .default('last_7d')
          .describe('Reporting window each send covers.'),
        recipients: z
          .array(z.string().email())
          .max(10)
          .optional()
          .describe(
            'Recipient email addresses. Omit to default to the current user; never invent addresses.'
          ),
        includeSummary: z.boolean().default(true),
        includeRisk: z.boolean().default(true),
        includeLosses: z.boolean().default(true),
      }),
      execute: async (input) => {
        let plant = null;
        if (input.plantId) {
          plant = resolvePlantOrDeny(ctx, input.plantId);
          if (!plant) return denied('access_denied', `No access to ${input.plantId}.`);
        }

        let recipients = input.recipients ?? [];
        if (recipients.length === 0) {
          // Default to the session user's email (Better Auth user id).
          const user = await prisma.user
            .findUnique({ where: { id: ctx.userClerkId }, select: { email: true } })
            .catch(() => null);
          if (user?.email) recipients = [user.email];
        }

        // Attached composed report (dashboard), explicit or active. The
        // forced-tool nudge can fire before the model knows a real id (it has
        // been observed passing the literal "active"), so placeholders map to
        // the active report and unresolvable ids degrade to an unattached
        // draft — a card the user can still confirm always beats an error.
        let dashboard: { id: string; title: string } | null = null;
        const placeholder = /^(active|current|this|report)$/i.test(input.reportId ?? '');
        let attachId = !input.reportId || placeholder ? activeReportId : input.reportId;
        if (!attachId && input.reportId && !placeholder) attachId = input.reportId;
        if (attachId) {
          const dash = await prisma.dashboard
            .findFirst({
              where: { OR: [{ id: attachId }, { slug: attachId }] },
              select: { id: true, title: true, organization_id: true, owner_id: true },
            })
            .catch(() => null);
          const owns =
            dash &&
            (dash.organization_id === ctx.orgClerkId ||
              dash.owner_id === ctx.userClerkId ||
              (process.env.NODE_ENV === 'development' &&
                dash.organization_id === null &&
                dash.owner_id === null));
          if (owns) dashboard = { id: dash.id, title: dash.title };
        }

        return buildReportScheduleDraft({
          name: input.name ?? null,
          dashboard,
          plant,
          schedule: input.schedule,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          period: input.period,
          recipients,
          includeSummary: input.includeSummary,
          includeRisk: input.includeRisk,
          includeLosses: input.includeLosses,
        });
      },
    }),

    proposeAlertAck: tool({
      description:
        'Draft an acknowledge or resolve action for an ACTIVE plant alert; the user confirms via a rendered card (nothing persists until they click). Pass a match string (alert kind like SOILING_LOSS / CONTRACT_OBLIGATION / CRITICAL_FAULT / DATA_STALE, or a message fragment). If several alerts match, the tool returns the candidates — ask the user which one instead of guessing.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        match: z
          .string()
          .min(2)
          .describe('Alert kind or a distinctive fragment of the alert message.'),
        action: z.enum(['acknowledge', 'resolve']).default('acknowledge'),
      }),
      execute: async (input) => {
        const plant = resolvePlantOrDeny(ctx, input.plantId);
        if (!plant) return denied('access_denied', `No access to ${input.plantId}.`);
        const active = await prisma.plantAlert.findMany({
          where: { plant_id: plant.id, status: 'ACTIVE' },
          orderBy: [{ severity: 'desc' }, { triggered_at: 'desc' }],
          take: 20,
        });
        const q = input.match.toLowerCase();
        const matches = active.filter(
          (a) =>
            a.kind.toLowerCase().includes(q) || a.message.toLowerCase().includes(q),
        );
        if (!matches.length) {
          return denied(
            'no_matching_alert',
            `No ACTIVE alert on ${plant.slug} matches "${input.match}". Active kinds: ${
              [...new Set(active.map((a) => a.kind))].join(', ') || 'none'
            }.`,
          );
        }
        if (matches.length > 1) {
          return {
            kind: 'alert_candidates',
            candidates: matches.map((a) => ({
              id: a.id,
              alert_kind: a.kind,
              severity: a.severity,
              message: a.message,
              acknowledged: Boolean(a.acknowledged_at),
            })),
            note: 'Multiple alerts match; ask the user which one before drafting again with a tighter match.',
          };
        }
        const a = matches[0];
        return {
          kind: 'alert_ack_draft',
          draft: {
            alert_id: a.id,
            plant_id: plant.id,
            plant_slug: plant.slug,
            plant_name: plant.name,
            alert_kind: a.kind,
            severity: a.severity,
            message: a.message,
            action: input.action,
            already_acknowledged: Boolean(a.acknowledged_at),
          },
          note: 'This is a DRAFT. The user confirms via the rendered card.',
        };
      },
    }),

    proposeTicketUpdate: tool({
      description:
        'Draft a status change for an existing ticket; the user confirms via a rendered card (nothing persists until they click). Use for "close ticket X", "mark it in progress", "validate this ticket", "won\'t fix". Look up the ticket id with listTickets first. Allowed transitions: NEW->VALIDATED/WONT_FIX, VALIDATED->ASSIGNED/IN_PROGRESS/WONT_FIX, ASSIGNED->IN_PROGRESS/WONT_FIX, IN_PROGRESS->DONE/WONT_FIX.',
      inputSchema: z.object({
        ticketId: z.string().describe('Ticket id from listTickets.'),
        newStatus: z.enum(['VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'WONT_FIX']),
        reason: z.string().max(500).optional().describe('Short note explaining the change.'),
      }),
      execute: async (input) => {
        // Mirror of ALLOWED_TRANSITIONS in src/lib/mcp/write-tools.ts.
        const TICKET_TRANSITIONS: Record<string, string[]> = {
          NEW: ['VALIDATED', 'WONT_FIX'],
          VALIDATED: ['ASSIGNED', 'IN_PROGRESS', 'WONT_FIX'],
          ASSIGNED: ['IN_PROGRESS', 'WONT_FIX'],
          IN_PROGRESS: ['DONE', 'WONT_FIX'],
          DONE: [],
          WONT_FIX: [],
        };
        const accessibleUuids = ctx.plants.map((p) => p.id);
        const ticket = await prisma.ticket.findFirst({
          where: {
            id: input.ticketId,
            org_clerk_id: ctx.orgClerkId,
            plant_id: { in: accessibleUuids },
          },
          select: { id: true, title: true, status: true, plant_id: true },
        });
        if (!ticket) {
          return denied(
            'not_found',
            `Ticket ${input.ticketId} not found in your org, or you lack access to its plant.`,
          );
        }
        const allowed = TICKET_TRANSITIONS[ticket.status] ?? [];
        if (!allowed.includes(input.newStatus)) {
          return denied(
            'invalid_transition',
            `Cannot move "${ticket.title}" from ${ticket.status} to ${input.newStatus}. Allowed next: ${
              allowed.join(', ') || '(none, the ticket is closed)'
            }.`,
          );
        }
        return {
          kind: 'ticket_update_draft',
          draft: {
            ticket_id: ticket.id,
            title: ticket.title,
            current_status: ticket.status,
            new_status: input.newStatus,
            reason: input.reason ?? null,
          },
          note: 'This is a DRAFT. The user confirms via the rendered card.',
        };
      },
    }),

    proposeTicketComment: tool({
      description:
        'Draft a comment to add to an existing ticket; the user confirms via a rendered card (nothing persists until they click). Look up the ticket id with listTickets first.',
      inputSchema: z.object({
        ticketId: z.string().describe('Ticket id from listTickets.'),
        content: z.string().min(2).max(2000).describe('The comment body.'),
      }),
      execute: async (input) => {
        const accessibleUuids = ctx.plants.map((p) => p.id);
        const ticket = await prisma.ticket.findFirst({
          where: {
            id: input.ticketId,
            org_clerk_id: ctx.orgClerkId,
            plant_id: { in: accessibleUuids },
          },
          select: { id: true, title: true },
        });
        if (!ticket) {
          return denied(
            'not_found',
            `Ticket ${input.ticketId} not found in your org, or you lack access to its plant.`,
          );
        }
        return {
          kind: 'ticket_comment_draft',
          draft: { ticket_id: ticket.id, title: ticket.title, content: input.content },
          note: 'This is a DRAFT. The user confirms via the rendered card.',
        };
      },
    }),

    runCleaningOptimizer: tool({
      description:
        'Run the cleaning-schedule optimizer for a PV plant: scores hundreds of candidate cleaning schedules against the digital-twin soiling forecast and returns the best schedule per cleaning count (scenario ladder) with energy, cost, net benefit, and ROI. Rain-aware when a 16-day forecast is available. Use when the user asks to optimize cleaning, find the best cleaning dates, or whether cleaning pays off. To let the user ADOPT a schedule (persist it, optionally with maintenance tickets), follow up with proposeCleaningSchedule using the recommended dates and the run economics.',
      inputSchema: z.object({
        plantId: z.string().describe('Plant id or slug from listPlants.'),
        electricityRateEurMwh: z.number().min(1).max(1000).optional()
          .describe('Energy price assumption. Default 65.'),
        cleaningCostPerMw: z.number().min(1).max(10000).optional()
          .describe('Cost per MW per cleaning visit. Default 150.'),
        minDaysBetween: z.number().int().min(1).max(365).optional()
          .describe('Minimum days between cleanings. Default 14.'),
        maxCleanings: z.number().int().min(1).max(12).optional()
          .describe('Upper bound on cleanings per year. Default 6.'),
      }),
      execute: async (input) => {
        const plant = resolvePlantOrDeny(ctx, input.plantId);
        if (!plant) return denied('access_denied', `No access to ${input.plantId}.`);
        try {
          // Twin forecast via the same route the optimizer tab uses.
          const url = new URL(
            `/api/soiling/plants/${plant.slug}/digital-twin?source=ml_model`,
            origin,
          );
          const res = await fetch(url.toString(), {
            headers: { 'x-internal-chat-tool': process.env.INTERNAL_API_SECRET ?? '' },
          });
          if (!res.ok) return denied('forecast_unavailable', `HTTP ${res.status}`);
          const twin = await res.json();
          const forecast = twin?.daily_forecasts ?? [];
          if (forecast.length < 30) {
            return denied(
              'forecast_unavailable',
              'The digital twin has no usable soiling forecast for this plant yet.',
            );
          }

          const coords = await prisma.plant.findFirst({
            where: { id: plant.id },
            select: { latitude: true, longitude: true, capacity_mw: true },
          });
          const rain =
            coords?.latitude != null && coords?.longitude != null
              ? await fetchRainForecast(Number(coords.latitude), Number(coords.longitude))
              : null;

          const result = optimizeSchedule({
            plantId: plant.slug,
            forecast,
            params: {
              capacityMW:
                plant.capacity_mw ?? (coords?.capacity_mw ? Number(coords.capacity_mw) : 5),
              electricityRatePerMWh: input.electricityRateEurMwh ?? 65,
              cleaningCostPerMW: input.cleaningCostPerMw ?? 150,
              minDaysBetween: input.minDaysBetween ?? 14,
            },
            minCleanings: 1,
            maxCleanings: input.maxCleanings ?? 6,
            maxScenariosPerCount: 400,
            rainForecast: rain,
          });
          return shapeOptimizerRunOutput(result, plant);
        } catch (e) {
          return denied(
            'optimizer_failed',
            e instanceof Error ? e.message : 'optimizer error',
          );
        }
      },
    }),

    proposeCleaningSchedule: tool({
      description:
        'Draft a cleaning schedule recommendation for the user to review. THIS DOES NOT PERSIST — it renders an editable list of dates the user can adopt or modify. Use after analysing soiling forecasts.',
      inputSchema: z.object({
        plantId: z.string(),
        dates: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'))
          .min(1)
          .max(12)
          .describe('Recommended cleaning dates in chronological order.'),
        rationale: z
          .string()
          .min(20)
          .describe(
            'One paragraph: why these dates, what SR / cost / ROI assumptions you used, and how they compare to the current schedule.'
          ),
        estimatedEnergyRecoveredMwh: z.number().min(0).optional()
          .describe('From the optimizer run, when available.'),
        estimatedRevenueRecoveredEur: z.number().min(0).optional()
          .describe('From the optimizer run, when available.'),
        estimatedCleaningCostEur: z.number().min(0).optional()
          .describe('Total cost of all cleanings, from the optimizer run.'),
      }),
      execute: async (input) => {
        const plant = resolvePlantOrDeny(ctx, input.plantId);
        if (!plant) return denied('access_denied', `No access to ${input.plantId}.`);
        return {
          kind: 'cleaning_schedule_draft',
          draft: {
            plant_id: plant.id,
            plant_slug: plant.slug,
            plant_name: plant.name,
            dates: input.dates,
            rationale: input.rationale,
            estimated_energy_recovered_mwh: input.estimatedEnergyRecoveredMwh,
            estimated_revenue_recovered_eur: input.estimatedRevenueRecoveredEur,
            estimated_cleaning_cost_eur: input.estimatedCleaningCostEur,
          },
          note:
            'This is a DRAFT. The user reviews and adopts it via the rendered card (adoption persists the plan and can create maintenance tickets).',
        };
      },
    }),
  };
}
