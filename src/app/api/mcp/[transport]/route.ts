import { createMcpHandler, withMcpAuth, getPublicOrigin } from 'mcp-handler';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { authenticateMcpRequest, authenticateMcpOAuth } from '@/lib/mcp/auth';
import { buildMcpAccessContext } from '@/lib/mcp/access';
import { getChatAccessContext } from '@/lib/ai/access-control';
import { hasScope, type Scope } from '@/lib/mcp/scopes';
import { checkRateLimit } from '@/lib/mcp/rate-limit';
import { recordToolCall, findIdempotentResult, type AuditStatus } from '@/lib/mcp/audit';
import { buildChatTools } from '@/lib/ai/chat-tools';
import {
  createTicket,
  updateTicketStatus,
  commentOnTicket,
  approveCleaningSchedule,
  scheduleReport,
  type WriteResult,
} from '@/lib/mcp/write-tools';
import {
  listPlantOverviewResources,
  readPlantOverview,
  listKBResources,
  readKBDocument,
} from '@/lib/mcp/resources';
import type { ChatAccessContext } from '@/lib/ai/access-control';

export const runtime = 'nodejs';
// Streaming MCP responses can take a while (Bedrock inference is the slowest).
export const maxDuration = 60;

interface ResolvedAuth {
  kind: 'api_key' | 'oauth';
  orgClerkId: string;
  userClerkId: string;
  apiKeyId: string;
  scopes: Scope[];
  origin: string;
}

function resolveAuth(authInfo: { extra?: Record<string, unknown> } | undefined): ResolvedAuth | null {
  const kind = (authInfo?.extra?.kind as 'api_key' | 'oauth' | undefined) ?? 'api_key';
  const orgClerkId = authInfo?.extra?.orgClerkId as string | undefined;
  const apiKeyId = authInfo?.extra?.apiKeyId as string | undefined;
  const userClerkId =
    (authInfo?.extra?.userClerkId as string | undefined) ??
    (apiKeyId ? `mcp_key_${apiKeyId}` : undefined);
  const scopes = (authInfo?.extra?.scopes as Scope[] | undefined) ?? [];
  const origin = (authInfo?.extra?.origin as string | undefined) ?? '';
  if (!orgClerkId || !apiKeyId || !userClerkId) return null;
  return { kind, orgClerkId, userClerkId, apiKeyId, scopes, origin };
}

/**
 * Access context for an authenticated caller. API keys are org-wide service
 * credentials; OAuth tokens are per-user and resolve through the caller's
 * PlantAccess ACL like the in-app chat.
 */
async function buildCtxForAuth(auth: ResolvedAuth): Promise<ChatAccessContext> {
  if (auth.kind === 'oauth') {
    return getChatAccessContext(auth.userClerkId, auth.orgClerkId);
  }
  return buildMcpAccessContext({
    kind: 'api_key',
    orgClerkId: auth.orgClerkId,
    userClerkId: auth.userClerkId,
    apiKeyId: auth.apiKeyId,
    scopes: auth.scopes,
  });
}

/** Wrap any value into MCP's `{ content: [{ type:'text', text:'…' }] }`. */
function toMcpResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Run a function under the standard guardrails: scope → rate-limit → audit. */
async function guarded(
  authInfo: { extra?: Record<string, unknown> } | undefined,
  toolName: string,
  args: unknown,
  requiredScope: Scope,
  idempotencyKey: string | null,
  exec: (ctx: ChatAccessContext, auth: ResolvedAuth) => Promise<{
    result: unknown;
    ticketId?: string | null;
    cleaningScheduleId?: string | null;
  }>,
) {
  const start = Date.now();
  const auth = resolveAuth(authInfo);
  if (!auth) {
    return toMcpResult({ error: 'unauthenticated' });
  }

  if (!hasScope(auth.scopes, requiredScope)) {
    const result = { error: 'forbidden', detail: `Missing required scope: ${requiredScope}` };
    await recordToolCall({
      apiKeyId: auth.apiKeyId,
      orgClerkId: auth.orgClerkId,
      toolName,
      args,
      status: 'forbidden',
      errorReason: `missing_scope:${requiredScope}`,
      durationMs: Date.now() - start,
      idempotencyKey,
    });
    return toMcpResult(result);
  }

  const rate = checkRateLimit(auth.apiKeyId);
  if (!rate.ok) {
    const result = {
      error: 'rate_limited',
      reason: rate.reason,
      retry_after_sec: rate.retryAfterSec,
    };
    await recordToolCall({
      apiKeyId: auth.apiKeyId,
      orgClerkId: auth.orgClerkId,
      toolName,
      args,
      status: 'rate_limited',
      errorReason: rate.reason,
      durationMs: Date.now() - start,
      idempotencyKey,
    });
    return toMcpResult(result);
  }

  if (idempotencyKey) {
    const prior = await findIdempotentResult(auth.apiKeyId, toolName, idempotencyKey);
    if (prior) {
      return toMcpResult({
        ...((prior.result as Record<string, unknown>) ?? {}),
        idempotent_replay: true,
      });
    }
  }

  const ctx = await buildCtxForAuth(auth);

  let status: AuditStatus = 'success';
  let errorReason: string | undefined;
  let result: unknown;
  let ticketId: string | null | undefined;
  let cleaningScheduleId: string | null | undefined;
  try {
    const out = await exec(ctx, auth);
    result = out.result;
    ticketId = out.ticketId ?? null;
    cleaningScheduleId = out.cleaningScheduleId ?? null;
    // Tool returned an error envelope — surface as audit status=error so the
    // customer sees it in their audit log, but still hand back to MCP.
    if (
      result &&
      typeof result === 'object' &&
      'error' in (result as Record<string, unknown>)
    ) {
      status = 'error';
      errorReason = String((result as Record<string, unknown>).error);
    }
  } catch (e) {
    status = 'error';
    errorReason = e instanceof Error ? e.message : String(e);
    result = { error: 'tool_execution_failed', detail: errorReason };
  }

  await recordToolCall({
    apiKeyId: auth.apiKeyId,
    orgClerkId: auth.orgClerkId,
    toolName,
    args,
    status,
    errorReason,
    durationMs: Date.now() - start,
    idempotencyKey,
    // Only persist `result` for successful writes (so idempotent replays
    // work). Skip for reads — we don't want big payloads in audit rows.
    result: idempotencyKey && status === 'success' ? result : undefined,
    ticketId,
    cleaningScheduleId,
  });

  return toMcpResult(result);
}

/** Delegate to the existing chat-tools `buildChatTools` for read tools. */
async function runChatToolViaGuard<K extends keyof ToolSet>(
  mcpToolName: string,
  chatToolKey: K,
  args: unknown,
  authInfo: { extra?: Record<string, unknown> } | undefined,
  requiredScope: Scope,
) {
  return guarded(authInfo, mcpToolName, args, requiredScope, null, async (ctx, auth) => {
    const tools = buildChatTools(ctx, auth.origin);
    const tool = tools[chatToolKey];
    if (!tool || typeof tool.execute !== 'function') {
      return { result: { error: 'tool_not_implemented', tool: String(chatToolKey) } };
    }
    const result = await tool.execute(args as never, {
      toolCallId: 'mcp',
      messages: [],
    } as never);
    return { result };
  });
}

const handler = createMcpHandler(
  (server) => {
    // ─────────────────────────────────────────────────────────────
    // READ TOOLS
    // ─────────────────────────────────────────────────────────────

    server.tool(
      'nuravolt_list_plants',
      'List the solar PV / BESS / Wind / Hybrid plants this API key has access to. Call this first to discover plant ids before any plant-scoped tool. Returns id, slug, name, asset_type, status, capacity, location.',
      {
        assetType: z
          .enum(['PV', 'BESS', 'WIND', 'HYBRID'])
          .optional()
          .describe('Filter by asset type. Omit for all.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_list_plants', 'listPlants', args, extra.authInfo, 'plants:read'),
    );

    server.tool(
      'nuravolt_list_inverters',
      'List the inverters at a plant with their model and rated capacity. ALWAYS call this before nuravolt_diagnose_inverter or nuravolt_get_inverter_classification to obtain a real inverter id — never invent ids.',
      {
        plantId: z.string().describe('Plant id or slug returned by nuravolt_list_plants.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_list_inverters', 'listInverters', args, extra.authInfo, 'inverters:read'),
    );

    server.tool(
      'nuravolt_get_soiling_forecast',
      'Get the 365-day soiling forecast for a PV plant. Returns daily predicted soiling ratio (SR), confidence bounds, and cleaning recommendations. Optionally includes rain-driven recovery events.',
      {
        plantId: z.string().describe('Plant id or slug.'),
        days: z.number().int().min(1).max(365).default(30).describe('Forecast horizon in days. Default 30, max 365.'),
        includeWeather: z.boolean().default(false).describe('Include 7-day weather-adjusted recovery events.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_soiling_forecast', 'getSoilingForecast', args, extra.authInfo, 'soiling:read'),
    );

    server.tool(
      'nuravolt_get_inverter_classification',
      'Deterministic rule-based maintenance classification for one inverter. Returns likely cause (SOILING/SHADING/THERMAL/STRING_DEGRADATION/BYPASS_DIODE/INVERTER_DERATE/NORMAL), confidence, ETA, and recommended action. Fast and free — call before nuravolt_diagnose_inverter to get a grounded baseline.',
      {
        plantId: z.string(),
        inverterId: z.string().describe('Inverter id returned by nuravolt_list_inverters.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_inverter_classification', 'getInverterClassification', args, extra.authInfo, 'faults:read'),
    );

    server.tool(
      'nuravolt_diagnose_inverter',
      'Run AI diagnosis (Bedrock-backed) for a specific inverter using 30 days of digital-twin metrics. Returns severity, fault hypothesis, and recommended actions. PRECONDITION: call nuravolt_list_inverters first to obtain a real inverter id.',
      {
        plantId: z.string(),
        inverterId: z.string(),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_diagnose_inverter', 'getInverterDiagnosis', args, extra.authInfo, 'diagnosis:run'),
    );

    server.tool(
      'nuravolt_get_chart',
      'Fetch a daily timeseries for a plant (or one inverter) over a range preset. Twin metrics (power_ac, temperature, voltage_dc, current_dc) return predicted vs actual; measured metrics (energy_daily, irradiance_poa/ghi, soiling_ratio, temp_ambient/module, power_dc) return daily telemetry. Returns summary stats plus a compact series.',
      {
        plantId: z.string().describe('Plant id or slug.'),
        inverterId: z.string().optional(),
        metric: z.enum([
          'power_ac', 'temperature', 'voltage_dc', 'current_dc',
          'energy_daily', 'irradiance_poa', 'irradiance_ghi', 'soiling_ratio',
          'temp_ambient', 'temp_module', 'power_dc',
        ]),
        range: z.enum(['last_7d', 'last_14d', 'last_30d', 'last_month']).default('last_30d'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_chart', 'getChart', args, extra.authInfo, 'plants:read'),
    );

    server.tool(
      'nuravolt_get_irradiance_quality',
      'Assess the quality of a plant\'s on-site irradiance measurement by comparing the on-site sensor track against the Open-Meteo reference model. Returns correlation, bias, RMSE, a monthly trend, and quality alerts (calibration drift, systematic deviation). If the result says no_data the plant has no on-site sensor data.',
      {
        plantId: z.string().describe('Plant id or slug.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_irradiance_quality', 'getIrradianceQuality', args, extra.authInfo, 'soiling:read'),
    );

    server.tool(
      'nuravolt_get_bess_revenue',
      'Return ancillary-services and wholesale revenue for a BESS plant over the last N days. Breakdown covers Dynamic Containment, Dynamic Moderation, Dynamic Regulation, Balancing Mechanism, Capacity Market, and wholesale arbitrage.',
      {
        plantId: z.string(),
        days: z.number().int().min(1).max(30).default(7),
        by: z.enum(['service', 'day']).default('service'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_bess_revenue', 'getBessRevenue', args, extra.authInfo, 'bess:read'),
    );

    server.tool(
      'nuravolt_get_warranty_position',
      'Get the BESS warranty guardian position for a battery plant: health score, state of health against the contractual capacity floor, cycle budget consumption, projected floor crossing, open violations, and the latest capacity test. Backed by the weekly audit dossier. Returns no_warranty_dossier when the audit job has not covered the plant yet.',
      {
        plantId: z.string().describe('BESS or hybrid plant id or slug from nuravolt_list_plants.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_warranty_position', 'getWarrantyPosition', args, extra.authInfo, 'bess:read'),
    );

    server.tool(
      'nuravolt_get_optimizer_audit',
      'Get the dispatch strategy benchmark for a battery plant: capture ratio against a perfect foresight optimum on the same day ahead prices, revenue gap, and annualized gap. Always keep the perfect foresight framing from the returned note. Returns no_optimizer_audit when the audit job has not covered the plant yet.',
      {
        plantId: z.string().describe('BESS or hybrid plant id or slug from nuravolt_list_plants.'),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_get_optimizer_audit', 'getOptimizerAudit', args, extra.authInfo, 'bess:read'),
    );

    server.tool(
      'nuravolt_list_tickets',
      'List maintenance tickets with optional plant/status/priority filters. Status values: NEW, VALIDATED, ASSIGNED, IN_PROGRESS, DONE, WONT_FIX. Priority values: CRITICAL, HIGH, MEDIUM, LOW.',
      {
        plantId: z.string().optional(),
        status: z
          .array(z.enum(['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'WONT_FIX']))
          .optional(),
        priority: z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_list_tickets', 'listTickets', args, extra.authInfo, 'tickets:read'),
    );

    server.tool(
      'nuravolt_search_knowledge_base',
      "Search the organization's uploaded knowledge base (manuals, datasheets, runbooks, prior incident reports) for passages relevant to the query. Returns ranked excerpts with document title and chunk index for citation. Use BEFORE answering questions that depend on equipment specs, fault codes, or OEM procedures.",
      {
        query: z.string().min(3).describe('Natural-language search query. Be specific.'),
        plantId: z.string().optional().describe('Optional plant id/slug to bias toward plant-specific docs.'),
        limit: z.number().int().min(1).max(10).default(5),
      },
      async (args, extra) =>
        runChatToolViaGuard('nuravolt_search_knowledge_base', 'searchKnowledgeBase', args, extra.authInfo, 'kb:read'),
    );

    // ─────────────────────────────────────────────────────────────
    // WRITE TOOLS
    // ─────────────────────────────────────────────────────────────

    server.tool(
      'nuravolt_create_ticket',
      'Create a maintenance/inspection ticket (status=NEW). PERSISTS to the database — the customer\'s ticketing queue will pick it up immediately. Provide an idempotency_key (any string) to make retries safe: replays return the original ticket id without creating a duplicate.',
      {
        idempotency_key: z
          .string()
          .min(1)
          .max(64)
          .describe('Caller-chosen unique key. Same key + tool = same result, no duplicate row.'),
        plantId: z.string(),
        inverterId: z.string().optional(),
        title: z.string().min(5).max(120),
        description: z.string().min(10),
        priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
        trigger_type: z
          .enum([
            'SOILING_FORECAST',
            'PERFORMANCE_ANOMALY',
            'THRESHOLD_ALERT',
            'SCHEDULED_MAINTENANCE',
            'MANUAL_CREATION',
          ])
          .default('MANUAL_CREATION'),
        estimated_energy_loss_kwh: z.number().nonnegative().optional(),
        estimated_revenue_impact_eur: z.number().nonnegative().optional(),
      },
      async (args, extra) => {
        const { idempotency_key, ...rest } = args;
        return guarded(
          extra.authInfo,
          'nuravolt_create_ticket',
          args,
          'tickets:write',
          idempotency_key,
          async (ctx) => {
            const out: WriteResult = await createTicket(ctx, rest);
            return out;
          },
        );
      },
    );

    server.tool(
      'nuravolt_update_ticket_status',
      'Move a ticket forward in the workflow. Allowed transitions: NEW → VALIDATED|WONT_FIX, VALIDATED → ASSIGNED|IN_PROGRESS|WONT_FIX, ASSIGNED → IN_PROGRESS|WONT_FIX, IN_PROGRESS → DONE|WONT_FIX. Writes a TicketHistory row. Provide idempotency_key to make retries safe.',
      {
        idempotency_key: z.string().min(1).max(64),
        ticketId: z.string(),
        newStatus: z.enum(['VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'WONT_FIX']),
        reason: z.string().max(500).optional(),
      },
      async (args, extra) => {
        const { idempotency_key, ...rest } = args;
        return guarded(
          extra.authInfo,
          'nuravolt_update_ticket_status',
          args,
          'tickets:write',
          idempotency_key,
          async (ctx) => updateTicketStatus(ctx, rest),
        );
      },
    );

    server.tool(
      'nuravolt_comment_on_ticket',
      'Add a comment to an existing ticket. The comment is attributed to the API key (mcp_key_<id>) so it\'s clear in the timeline that it came from an external AI assistant. Provide idempotency_key to make retries safe.',
      {
        idempotency_key: z.string().min(1).max(64),
        ticketId: z.string(),
        content: z.string().min(1).max(4000),
      },
      async (args, extra) => {
        const { idempotency_key, ...rest } = args;
        return guarded(
          extra.authInfo,
          'nuravolt_comment_on_ticket',
          args,
          'tickets:write',
          idempotency_key,
          async (ctx) => commentOnTicket(ctx, rest),
        );
      },
    );

    // ─────────────────────────────────────────────────────────────
    // RESOURCES
    // Host AIs can attach these to their context without spending
    // a tool call. Same scope + audit guarantees as tools.
    // ─────────────────────────────────────────────────────────────

    server.resource(
      'plant_overview',
      new ResourceTemplate('nuravolt://plant/{plantSlug}/overview.md', {
        list: async (extra) => {
          const auth = resolveAuth(extra.authInfo);
          if (!auth || !hasScope(auth.scopes, 'plants:read')) return { resources: [] };
          const ctx = await buildCtxForAuth(auth);
          return { resources: await listPlantOverviewResources(ctx) };
        },
      }),
      { mimeType: 'text/markdown' },
      async (uri, variables, extra) => {
        const start = Date.now();
        const auth = resolveAuth(extra.authInfo);
        const plantSlug = String(variables.plantSlug ?? '');
        if (!auth) {
          return {
            contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Unauthenticated' }],
          };
        }
        if (!hasScope(auth.scopes, 'plants:read')) {
          await recordToolCall({
            apiKeyId: auth.apiKeyId,
            orgClerkId: auth.orgClerkId,
            toolName: `resource:plant_overview`,
            args: { plantSlug },
            status: 'forbidden',
            errorReason: 'missing_scope:plants:read',
            durationMs: Date.now() - start,
          });
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'text/markdown',
                text: '# Forbidden\n\nThis API key is missing the `plants:read` scope.',
              },
            ],
          };
        }
        const ctx = await buildCtxForAuth(auth);
        const body = await readPlantOverview(ctx, plantSlug);
        await recordToolCall({
          apiKeyId: auth.apiKeyId,
          orgClerkId: auth.orgClerkId,
          toolName: `resource:plant_overview`,
          args: { plantSlug },
          status: 'success',
          durationMs: Date.now() - start,
        });
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] };
      },
    );

    server.resource(
      'kb_document',
      new ResourceTemplate('nuravolt://kb/{documentId}', {
        list: async (extra) => {
          const auth = resolveAuth(extra.authInfo);
          if (!auth || !hasScope(auth.scopes, 'kb:read')) return { resources: [] };
          return { resources: await listKBResources(auth.orgClerkId) };
        },
      }),
      { mimeType: 'text/markdown' },
      async (uri, variables, extra) => {
        const start = Date.now();
        const auth = resolveAuth(extra.authInfo);
        const documentId = String(variables.documentId ?? '');
        if (!auth) {
          return {
            contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Unauthenticated' }],
          };
        }
        if (!hasScope(auth.scopes, 'kb:read')) {
          await recordToolCall({
            apiKeyId: auth.apiKeyId,
            orgClerkId: auth.orgClerkId,
            toolName: `resource:kb_document`,
            args: { documentId },
            status: 'forbidden',
            errorReason: 'missing_scope:kb:read',
            durationMs: Date.now() - start,
          });
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'text/markdown',
                text: '# Forbidden\n\nThis API key is missing the `kb:read` scope.',
              },
            ],
          };
        }
        const body = await readKBDocument(auth.orgClerkId, documentId);
        await recordToolCall({
          apiKeyId: auth.apiKeyId,
          orgClerkId: auth.orgClerkId,
          toolName: `resource:kb_document`,
          args: { documentId },
          status: 'success',
          durationMs: Date.now() - start,
        });
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] };
      },
    );

    server.tool(
      'nuravolt_schedule_report',
      'Create a recurring email report schedule (creates a ScheduledReport row). PERSISTS immediately. Reports send as portfolio PDFs at 07:00 UTC on the scheduled day; a plantId narrows the report to that plant. Provide idempotency_key to make retries safe.',
      {
        idempotency_key: z.string().min(1).max(64),
        name: z.string().min(3).max(80),
        plantId: z.string().optional().describe('Plant id or slug. Omit for the whole portfolio.'),
        schedule: z.enum(['weekly', 'monthly']),
        dayOfWeek: z.number().int().min(1).max(7).optional().describe('Weekly only: 1=Monday .. 7=Sunday. Default 1.'),
        dayOfMonth: z.number().int().min(1).max(28).optional().describe('Monthly only: 1-28. Default 1.'),
        period: z.enum(['last_7d', 'last_30d', 'last_month']).default('last_7d'),
        recipient_emails: z.array(z.string().email()).min(1).max(10),
        include_summary: z.boolean().default(true),
        include_risk: z.boolean().default(true),
        include_losses: z.boolean().default(true),
      },
      async (args, extra) => {
        const { idempotency_key, ...rest } = args;
        return guarded(
          extra.authInfo,
          'nuravolt_schedule_report',
          args,
          'reports:write',
          idempotency_key,
          async (ctx) => scheduleReport(ctx, rest),
        );
      },
    );

    server.tool(
      'nuravolt_approve_cleaning_schedule',
      'Persist a cleaning schedule for a PV plant (creates a CleaningSchedule row). Use this AFTER analysing soiling forecast and economics. Provide ALL three economics: estimatedEnergyRecoveredMwh, estimatedRevenueRecoveredEur, estimatedCleaningCostEur (positive). The server computes net_benefit, ROI, payback. Provide idempotency_key to make retries safe.',
      {
        idempotency_key: z.string().min(1).max(64),
        plantId: z.string(),
        scheduleName: z.string().min(3).max(80),
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(24),
        rationale: z.string().min(20),
        estimatedEnergyRecoveredMwh: z.number().nonnegative(),
        estimatedRevenueRecoveredEur: z.number().nonnegative(),
        estimatedCleaningCostEur: z.number().positive(),
        avgSrBaseline: z.number().min(0).max(1).optional(),
        avgSrOptimized: z.number().min(0).max(1).optional(),
        validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
      async (args, extra) => {
        const { idempotency_key, ...rest } = args;
        return guarded(
          extra.authInfo,
          'nuravolt_approve_cleaning_schedule',
          args,
          'cleaning:write',
          idempotency_key,
          async (ctx) => approveCleaningSchedule(ctx, rest),
        );
      },
    );
  },
  {
    capabilities: { tools: {}, resources: { listChanged: true } },
  },
  {
    basePath: '/api/mcp',
    verboseLogs: process.env.NODE_ENV !== 'production',
  },
);

const protectedHandler = withMcpAuth(
  handler,
  async (req, bearerToken) => {
    // Two bearer flavours: nv_live_/nv_test_ API keys (org-wide service
    // credentials) and Better Auth OAuth tokens from the MCP connector flow
    // (per-user, Enterprise plan only).
    const result = bearerToken?.startsWith('nv_')
      ? await authenticateMcpRequest(`Bearer ${bearerToken}`)
      : await authenticateMcpOAuth(req.headers);
    if (!result.ok) {
      return undefined;
    }
    return {
      token: bearerToken ?? '',
      clientId: result.ctx.apiKeyId,
      scopes: result.ctx.scopes,
      extra: {
        kind: result.ctx.kind,
        orgClerkId: result.ctx.orgClerkId,
        userClerkId: result.ctx.userClerkId,
        apiKeyId: result.ctx.apiKeyId,
        scopes: result.ctx.scopes,
        origin: getPublicOrigin(req),
      },
    };
  },
  { required: true },
);

export { protectedHandler as GET, protectedHandler as POST, protectedHandler as DELETE };
