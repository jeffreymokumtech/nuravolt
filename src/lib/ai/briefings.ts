import prisma from '@/libs/prisma';
import { extractJson, invokeBedrockDetailed, modelLabel } from '@/lib/ai/bedrock';
import { recordLLMInteraction } from '@/lib/ai/llm-pricing';
import { resolvePlantOrDeny, type ChatAccessContext } from '@/lib/ai/access-control';
import { querySoilingForecastPoints } from '@/lib/db/timeseries';

export interface Briefing {
  bullets: string[];
  generatedAt: string;
  /** Echoed for client cache-keying. */
  scope: { plantId?: string | null; inverterId?: string | null };
}

const BRIEFING_SYSTEM = `You are Shams, NuraVolt's solar operations agent, generating a "what to look at today" briefing for a solar O&M operator who just opened an asset page. Output ONLY a JSON object {"bullets": ["...", "...", "..."]} with EXACTLY 3 bullets, each <= 140 characters.

CRITICAL: Use ONLY the numeric values present in the user message. Never invent or estimate numbers — if a value is not in the input, refer to it qualitatively or say it is unavailable. If the data is genuinely sparse, your bullets should reflect that and recommend the appropriate next action (e.g. "run inverter diagnosis", "check data ingestion") rather than fabricating context.

No preambles, no markdown, no surrounding prose.`;

export async function generatePlantBriefing(args: {
  ctx: ChatAccessContext;
  plantId: string;
}): Promise<Briefing | null> {
  const plant = resolvePlantOrDeny(args.ctx, args.plantId);
  if (!plant) return null;

  // Snapshot the operationally interesting state in 2 queries.
  const [openTicketsByPriority, recentForecast] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['priority', 'status'],
      where: {
        org_clerk_id: args.ctx.orgClerkId,
        plant_id: plant.id,
        status: { in: ['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS'] },
      },
      _count: { _all: true },
    }),
    // analysis_results is the canonical soiling store; the Prisma
    // SoilingForecast table has no writer and would always read empty.
    querySoilingForecastPoints(plant.id, 14).catch(() => []),
  ]);

  const ticketsLine = openTicketsByPriority.length
    ? openTicketsByPriority
        .map((g) => `${g._count._all} ${g.priority}/${g.status}`)
        .join(', ')
    : 'no open tickets';

  const srValues = recentForecast
    .map((f) => Number(f.soiling_ratio))
    .filter((n) => !isNaN(n));
  const avgSr = srValues.length
    ? (srValues.reduce((a, b) => a + b, 0) / srValues.length).toFixed(3)
    : 'n/a';
  const cleaningFlagged = recentForecast.some((f) => f.is_cleaning_needed);

  const prompt = `Plant: ${plant.name} (slug=${plant.slug}, capacity=${plant.capacity_mw ?? '?'} MW, country=${plant.country ?? '?'})
Status: ${plant.status}
Open tickets: ${ticketsLine}
Soiling forecast (next 14 days): avg SR=${avgSr}, cleaning_needed=${cleaningFlagged ? 'yes (at least one day)' : 'no'}
Forecast points returned: ${recentForecast.length}

Produce the briefing JSON now.`;

  try {
    const startedAt = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system: BRIEFING_SYSTEM,
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.2,
    });
    const raw = detailed.text;
    recordLLMInteraction({
      orgClerkId: args.ctx.orgClerkId,
      modelId: modelLabel(),
      interactionType: 'CHAT',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(raw.length / 4),
      latencyMs: Date.now() - startedAt,
    });
    const parsed = extractJson<{ bullets?: string[] }>(raw);
    const bullets = Array.isArray(parsed?.bullets)
      ? parsed!.bullets!.filter((b) => typeof b === 'string').slice(0, 3)
      : [];
    if (bullets.length === 0) return null;
    return {
      bullets,
      generatedAt: new Date().toISOString(),
      scope: { plantId: plant.slug },
    };
  } catch (e) {
    console.warn('[briefing/plant] LLM call failed:', e);
    return null;
  }
}

export async function generateInverterBriefing(args: {
  ctx: ChatAccessContext;
  plantId: string;
  inverterId: string;
}): Promise<Briefing | null> {
  const plant = resolvePlantOrDeny(args.ctx, args.plantId);
  if (!plant) return null;

  const openTickets = await prisma.ticket.findMany({
    where: {
      org_clerk_id: args.ctx.orgClerkId,
      plant_id: plant.id,
      inverter_id: args.inverterId,
      status: { in: ['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS'] },
    },
    orderBy: { created_at: 'desc' },
    take: 5,
    select: {
      title: true,
      priority: true,
      status: true,
      trigger_type: true,
      created_at: true,
    },
  });

  const ticketsLine = openTickets.length
    ? openTickets
        .map(
          (t) =>
            `[${t.priority}/${t.status}] ${t.title} (${t.trigger_type}, ${t.created_at.toISOString().slice(0, 10)})`
        )
        .join('\n')
    : 'no open tickets for this inverter';

  const prompt = `Plant: ${plant.name} (slug=${plant.slug})
Inverter: ${args.inverterId}
Open tickets:
${ticketsLine}

NOTE: We have NOT pre-fetched any digital-twin numeric data (power, temperature, voltage, current) for this briefing — only the ticket list above. Do NOT fabricate numbers. Acceptable bullets:
- Reference the open tickets above (their priority, status, age, trigger).
- Recommend running the inverter diagnosis (which the user can ask via "diagnose this inverter") if no recent ticket already covers performance.
- Note absence of recent tickets/activity if the list is empty.

Produce the briefing JSON now.`;

  try {
    const startedAt = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system: BRIEFING_SYSTEM,
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.2,
    });
    const raw = detailed.text;
    recordLLMInteraction({
      orgClerkId: args.ctx.orgClerkId,
      modelId: modelLabel(),
      interactionType: 'CHAT',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(raw.length / 4),
      latencyMs: Date.now() - startedAt,
    });
    const parsed = extractJson<{ bullets?: string[] }>(raw);
    const bullets = Array.isArray(parsed?.bullets)
      ? parsed!.bullets!.filter((b) => typeof b === 'string').slice(0, 3)
      : [];
    if (bullets.length === 0) return null;
    return {
      bullets,
      generatedAt: new Date().toISOString(),
      scope: { plantId: plant.slug, inverterId: args.inverterId },
    };
  } catch (e) {
    console.warn('[briefing/inverter] LLM call failed:', e);
    return null;
  }
}

// ============================================================================
// Cross-fleet insight synthesizer (Phase K Polish #6)
// ============================================================================

const FLEET_INSIGHTS_SYSTEM = `You are Shams, NuraVolt's solar operations agent, generating a weekly portfolio-level briefing for a senior O&M manager overseeing a fleet of solar PV / BESS plants.

You will receive aggregated state across ALL plants in the manager's organization. Produce a JSON object:
{
  "headline": "<1 sentence summarizing fleet posture this week>",
  "action_items": [
    {"priority": "high|medium|low", "plant_slug": "...", "summary": "..."},
    ...
  ],
  "emerging_risks": [
    {"risk": "<short title>", "affected_plants": ["..."], "evidence": "<one-sentence basis>"},
    ...
  ]
}

Hard rules:
- 3-5 action items total, ordered by priority.
- 0-3 emerging risks. Skip if nothing emerges.
- Cite ONLY values present in the input. Never invent numbers.
- Risks must cluster across ≥2 plants OR a single very-high-stakes plant — never a single small-plant blip.
- Action items name a specific plant slug + a single decision the manager would make this week.
- No markdown, no preamble.`;

export interface FleetActionItem {
  priority: 'high' | 'medium' | 'low';
  plant_slug: string;
  summary: string;
}

export interface FleetRisk {
  risk: string;
  affected_plants: string[];
  evidence: string;
}

export interface FleetInsights {
  headline: string;
  action_items: FleetActionItem[];
  emerging_risks: FleetRisk[];
  generated_at: string;
  scope: { org_clerk_id: string; n_plants: number };
}

/**
 * Generate a weekly portfolio briefing across every plant the org has access to.
 *
 * Cost: ~1 LLM call per org per week. The call ingests aggregated state
 * (no per-row data), so the prompt stays under 4K tokens even for 100+ plant fleets.
 */
export async function generateFleetInsights(args: {
  ctx: ChatAccessContext;
}): Promise<FleetInsights | null> {
  // The access context already resolved the caller's plants through the
  // org/PlantAccess ACL (Plant has no org_clerk_id column — its org link is
  // the organization relation).
  const plants = args.ctx.plants.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    country: p.country,
    capacity_mw: p.capacity_mw,
    status: p.status,
    asset_type: p.asset_type,
  }));
  if (plants.length === 0) return null;

  // Aggregate per-plant snapshot (open tickets + recent soiling forecast)
  const plantIds = plants.map((p) => p.id);
  const [ticketsByPlant, forecastsByPlant] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['plant_id', 'priority', 'status'],
      where: {
        org_clerk_id: args.ctx.orgClerkId,
        plant_id: { in: plantIds },
        status: { in: ['NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS'] },
      },
      _count: { _all: true },
    }),
    // analysis_results is the canonical soiling store (see single-plant path).
    Promise.all(
      plantIds.map((id) => querySoilingForecastPoints(id, 7).catch(() => [])),
    ).then((perPlant) => perPlant.flat()),
  ]);

  // Build per-plant rows for the prompt
  const ticketsByPlantId = new Map<string, { high: number; med: number; low: number; total: number }>();
  for (const row of ticketsByPlant) {
    const cur = ticketsByPlantId.get(row.plant_id) ?? { high: 0, med: 0, low: 0, total: 0 };
    if (row.priority === 'HIGH' || row.priority === 'CRITICAL') cur.high += row._count._all;
    else if (row.priority === 'MEDIUM') cur.med += row._count._all;
    else cur.low += row._count._all;
    cur.total += row._count._all;
    ticketsByPlantId.set(row.plant_id, cur);
  }

  const forecastByPlantId = new Map<string, { avgLoss: number; cleaningFlagged: boolean }>();
  const lossSums = new Map<string, { sum: number; count: number; cleaning: boolean }>();
  for (const f of forecastsByPlant) {
    const cur = lossSums.get(f.plant_id) ?? { sum: 0, count: 0, cleaning: false };
    const loss = Number(f.soiling_loss_pct ?? 0);
    if (!isNaN(loss)) {
      cur.sum += loss;
      cur.count += 1;
    }
    if (f.is_cleaning_needed) cur.cleaning = true;
    lossSums.set(f.plant_id, cur);
  }
  for (const [pid, agg] of lossSums) {
    forecastByPlantId.set(pid, {
      avgLoss: agg.count ? agg.sum / agg.count : 0,
      cleaningFlagged: agg.cleaning,
    });
  }

  const rows = plants
    .map((p) => {
      const t = ticketsByPlantId.get(p.id) ?? { high: 0, med: 0, low: 0, total: 0 };
      const f = forecastByPlantId.get(p.id) ?? { avgLoss: 0, cleaningFlagged: false };
      return `${p.slug.padEnd(20)} | ${p.country ?? '?'} | ${p.asset_type} | ` +
        `${p.capacity_mw ?? '?'} MW | ${p.status} | ` +
        `tickets: ${t.high}H/${t.med}M/${t.low}L | ` +
        `7d soiling loss: ${f.avgLoss.toFixed(2)}% (clean=${f.cleaningFlagged ? 'YES' : 'no'})`;
    })
    .join('\n');

  const prompt = `Organization fleet snapshot — ${plants.length} plants:

${rows}

Legend: tickets = open ticket counts by priority (H=high+critical, M=medium, L=low).
soiling loss = average forecast loss over next 7 days (%). clean=YES means at least
one of those days flagged cleaning_needed.

Produce the fleet insights JSON now.`;

  try {
    const startedAt = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system: FLEET_INSIGHTS_SYSTEM,
      jsonMode: true,
      maxTokens: 1000,
      temperature: 0.2,
    });
    const raw = detailed.text;
    recordLLMInteraction({
      orgClerkId: args.ctx.orgClerkId,
      modelId: modelLabel(),
      interactionType: 'REPORT_GENERATION',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(raw.length / 4),
      latencyMs: Date.now() - startedAt,
    });
    const parsed = extractJson<{
      headline?: string;
      action_items?: FleetActionItem[];
      emerging_risks?: FleetRisk[];
    }>(raw);
    if (!parsed || !parsed.headline) return null;
    return {
      headline: parsed.headline,
      action_items: (parsed.action_items ?? []).slice(0, 5),
      emerging_risks: (parsed.emerging_risks ?? []).slice(0, 3),
      generated_at: new Date().toISOString(),
      scope: { org_clerk_id: args.ctx.orgClerkId, n_plants: plants.length },
    };
  } catch (e) {
    console.warn('[fleet-insights] LLM call failed:', e);
    return null;
  }
}
