import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import prisma from '@/libs/prisma';
import { modelLabel, invokeBedrock, invokeBedrockDetailed, extractJson } from '@/lib/ai/bedrock';
import { ingestKBDocument, parseFile } from '@/lib/ai/kb-ingest';
import { curatedDocsFor, type CuratedDoc } from '@/lib/ai/doc-sources';
import { enumsForModelId, estimateLLMCostUsd } from '@/lib/ai/llm-pricing';

// Prisma enum stamps for the RESOLVED Bedrock model (BEDROCK_MODEL_ID).
const llmEnums = enumsForModelId(modelLabel());

/**
 * POST /api/cron/ingest-docs — the doc agent.
 *
 * Agentic batch that keeps the knowledge base stocked with equipment
 * documentation for whatever hardware the fleet actually runs:
 *
 *   1. Enumerate the fleet's distinct equipment models (inverter groups,
 *      BESS assets, electrolyzers, wind turbine fixtures).
 *   2. For models with no completed KB document yet, gather candidates:
 *      curated official URLs first (src/lib/ai/doc-sources.ts), then web
 *      discovery via Tavily when TAVILY_API_KEY is set.
 *   3. LLM-triage the candidates (is this the official manual for exactly
 *      this model?), fetch the best PDF (25 MB cap), LLM-verify the parsed
 *      text actually matches, then ingest as a GLOBAL document
 *      (org_clerk_id NULL — vendor manuals are public and shared).
 *   4. Retry previously failed documents that carry a source_url.
 *
 * Caps: MAX_NEW_DOCS_PER_RUN ingests, one doc per model per run. Discovery
 * degrades gracefully without the Tavily key (curated URLs still work).
 *
 * Query params: ?dry_run=1 — enumerate + triage, but skip fetch/ingest.
 * Auth: Bearer CRON_SECRET in production (same as the other crons).
 * Driven by .github/workflows/ingest-docs.yml (nightly + dispatch).
 */

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_NEW_DOCS_PER_RUN = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

interface EquipmentModel {
  model: string;
  manufacturer: string | null;
  equipmentType: 'inverter' | 'battery' | 'electrolyzer' | 'wind_turbine';
}

const KNOWN_WIND_BRANDS = ['vestas', 'siemens', 'gamesa', 'enercon', 'nordex', 'ge'];

async function enumerateFleetEquipment(): Promise<EquipmentModel[]> {
  const [groups, bess, h2] = await Promise.all([
    prisma.inverterGroup.findMany({
      where: { inverter_model: { not: null }, plant: { organization_id: { not: null } } },
      select: { inverter_model: true },
      distinct: ['inverter_model'],
    }),
    prisma.bessAsset.findMany({
      where: { model: { not: null }, plant: { organization_id: { not: null } } },
      select: { manufacturer: true, model: true },
      distinct: ['manufacturer', 'model'],
    }),
    prisma.h2Asset.findMany({
      where: { model: { not: null }, plant: { organization_id: { not: null } } },
      select: { manufacturer: true, model: true },
      distinct: ['manufacturer', 'model'],
    }),
  ]);

  const out: EquipmentModel[] = [];
  for (const g of groups) {
    if (g.inverter_model && !/generic/i.test(g.inverter_model)) {
      out.push({ model: g.inverter_model, manufacturer: null, equipmentType: 'inverter' });
    }
  }
  for (const b of bess) {
    if (b.model && !/generic|gridpack/i.test(b.model)) {
      out.push({ model: b.model, manufacturer: b.manufacturer, equipmentType: 'battery' });
    }
  }
  for (const h of h2) {
    if (h.model && !/generic|mw class/i.test(h.model)) {
      out.push({ model: h.model, manufacturer: h.manufacturer, equipmentType: 'electrolyzer' });
    }
  }

  // Wind turbines are fixture-modeled (no Prisma table yet): read the wind
  // summaries shipped with the app.
  try {
    const windDir = path.join(process.cwd(), 'public', 'data', 'wind');
    for (const plant of await fs.readdir(windDir)) {
      try {
        const summary = JSON.parse(
          await fs.readFile(path.join(windDir, plant, 'summary.json'), 'utf-8')
        );
        const model: string | undefined = summary.turbineModel;
        if (model && !/class|generic/i.test(model)) {
          const first = model.split(/[\s-]/)[0]?.toLowerCase();
          out.push({
            model,
            manufacturer: KNOWN_WIND_BRANDS.includes(first) ? model.split(/[\s-]/)[0] : null,
            equipmentType: 'wind_turbine',
          });
        }
      } catch {
        /* not a wind plant dir */
      }
    }
  } catch {
    /* no wind fixtures */
  }

  // Dedup by model string.
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = e.model.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Loose "do we already have a doc for this model" check. */
async function hasCompletedDoc(model: string): Promise<boolean> {
  const needle = `%${model.trim().replace(/[^a-zA-Z0-9]+/g, '%')}%`;
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "KBDocument"
     WHERE processing_status = 'completed'
       AND model_number IS NOT NULL
       AND (regexp_replace(model_number, '[^a-zA-Z0-9]+', '%', 'g') ILIKE $1
            OR model_number ILIKE $1)
     LIMIT 1`,
    needle
  );
  return rows.length > 0;
}

interface Candidate {
  url: string;
  title: string;
  origin: 'curated' | 'discovery';
  /** Known manufacturer (curated entries carry it even when the fleet model string doesn't). */
  manufacturer?: string | null;
}

/**
 * invokeBedrock + LLMInteraction logging (org NULL — the doc agent works on
 * the shared/global corpus). Token counts estimated at 4 chars ≈ 1 token,
 * same convention as interpret-alert-core.
 */
async function loggedInvoke(
  userPrompt: string,
  opts: Parameters<typeof invokeBedrock>[1]
): Promise<string> {
  const startedAt = Date.now();
  const detailed = await invokeBedrockDetailed(userPrompt, opts);
  const raw = detailed.text;
  const inputTokens =
    detailed.inputTokens ??
    Math.ceil((userPrompt.length + (opts?.system?.length ?? 0)) / 4);
  const outputTokens = detailed.outputTokens ?? Math.ceil(raw.length / 4);
  await prisma.lLMInteraction
    .create({
      data: {
        org_clerk_id: null,
        provider: llmEnums.provider,
        model: llmEnums.model,
        interaction_type: 'KNOWLEDGE_QUERY',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateLLMCostUsd(modelLabel(), inputTokens, outputTokens),
        latency_ms: Date.now() - startedAt,
        success: true,
      },
    })
    .catch(() => {});
  return raw;
}

async function discoverCandidates(eq: EquipmentModel): Promise<Candidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const query = `${eq.manufacturer ?? ''} ${eq.model} user manual pdf`.trim();
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return ((data.results as { url: string; title: string }[]) ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      origin: 'discovery' as const,
    }));
  } catch {
    return [];
  }
}

/** LLM triage: pick the best official-manual candidate, or none. */
async function triageCandidates(
  eq: EquipmentModel,
  candidates: Candidate[]
): Promise<Candidate | null> {
  if (candidates.length === 0) return null;
  // Curated entries are pre-vetted — take the first directly.
  const curated = candidates.find((c) => c.origin === 'curated');
  if (curated) return curated;

  try {
    const raw = await loggedInvoke(
      `Equipment: ${eq.manufacturer ?? '(unknown manufacturer)'} ${eq.model} (${eq.equipmentType}).
Candidates (title — url):
${candidates.map((c, i) => `${i}: ${c.title} — ${c.url}`).join('\n')}

Which single candidate is most likely the OFFICIAL vendor manual or datasheet for exactly this model? Prefer the manufacturer's own domain and direct PDF links. Respond as JSON: {"index": <number or -1 if none suitable>, "reason": "<short>"}`,
      {
        system:
          'You vet candidate documentation URLs for industrial equipment. Be conservative: reseller pages, forums and generic brochures are NOT suitable.',
        maxTokens: 200,
        temperature: 0,
        jsonMode: true,
      }
    );
    const parsed = extractJson<{ index: number }>(raw);
    if (parsed && parsed.index >= 0 && parsed.index < candidates.length) {
      return candidates[parsed.index];
    }
  } catch {
    /* triage failure → skip this model this run */
  }
  return null;
}

async function fetchPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'NuraVolt-DocAgent/1.0 (+https://nuravolt.com)' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('pdf') && !url.toLowerCase().includes('.pdf')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_FILE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/** LLM check: does the parsed text actually match the equipment? */
async function verifyRelevance(eq: EquipmentModel, buffer: Buffer): Promise<boolean> {
  try {
    const text = (await parseFile(buffer, 'pdf')).slice(0, 3000);
    if (!text.trim()) return false;
    const raw = await loggedInvoke(
      `Document opening text:\n"""${text}"""\n\nIs this documentation (manual, datasheet, installation or fault-code guide) for the equipment "${eq.manufacturer ?? ''} ${eq.model}" (${eq.equipmentType}) or its product family? JSON: {"relevant": true|false}`,
      { maxTokens: 60, temperature: 0, jsonMode: true }
    );
    const parsed = extractJson<{ relevant: boolean }>(raw);
    return parsed?.relevant === true;
  } catch {
    return false;
  }
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
  const discoveryEnabled = Boolean(process.env.TAVILY_API_KEY);

  const equipment = await enumerateFleetEquipment();
  let ingested = 0;
  let retried = 0;
  const details: Record<string, unknown>[] = [];

  // Retry previously failed URL-sourced docs first (they can be refetched).
  const failed = await prisma.kBDocument.findMany({
    where: { processing_status: 'failed', source_url: { not: null } },
    take: 3,
  });
  for (const doc of failed) {
    if (dryRun || ingested >= MAX_NEW_DOCS_PER_RUN) break;
    const buf = await fetchPdf(doc.source_url!);
    if (!buf) continue;
    await prisma.kBDocument.delete({ where: { id: doc.id } });
    try {
      await ingestKBDocument({
        orgClerkId: doc.org_clerk_id,
        uploadedBy: 'doc-agent',
        title: doc.title,
        fileName: doc.file_name,
        fileType: 'pdf',
        buffer: buf,
        plantId: doc.plant_id,
        equipmentType: doc.equipment_type,
        manufacturer: doc.manufacturer,
        modelNumber: doc.model_number,
        sourceUrl: doc.source_url,
      });
      retried++;
      ingested++;
    } catch {
      /* stays absent; next run retries */
    }
  }

  for (const eq of equipment) {
    if (ingested >= MAX_NEW_DOCS_PER_RUN) {
      details.push({ model: eq.model, status: 'deferred (run cap reached)' });
      continue;
    }
    if (await hasCompletedDoc(eq.model)) {
      details.push({ model: eq.model, status: 'covered' });
      continue;
    }

    const curated: Candidate[] = curatedDocsFor(eq.model, eq.manufacturer).map(
      (d: CuratedDoc) => ({
        url: d.url,
        title: d.title,
        origin: 'curated' as const,
        manufacturer: d.manufacturer,
      })
    );
    const discovered = await discoverCandidates(eq);
    const candidates = [...curated, ...discovered];

    if (candidates.length === 0) {
      details.push({
        model: eq.model,
        status: discoveryEnabled ? 'no candidates found' : 'no curated source (discovery off — set TAVILY_API_KEY)',
      });
      continue;
    }

    const chosen = await triageCandidates(eq, candidates);
    if (!chosen) {
      details.push({ model: eq.model, status: 'no suitable candidate after triage', candidates: candidates.length });
      continue;
    }

    if (dryRun) {
      details.push({ model: eq.model, status: 'would ingest', url: chosen.url, origin: chosen.origin });
      continue;
    }

    const buf = await fetchPdf(chosen.url);
    if (!buf) {
      details.push({ model: eq.model, status: 'fetch failed', url: chosen.url });
      continue;
    }
    if (chosen.origin === 'discovery' && !(await verifyRelevance(eq, buf))) {
      details.push({ model: eq.model, status: 'relevance check failed', url: chosen.url });
      continue;
    }

    try {
      const result = await ingestKBDocument({
        orgClerkId: null, // vendor manuals are global/shared
        uploadedBy: 'doc-agent',
        title: `${chosen.manufacturer ?? eq.manufacturer ?? ''} ${eq.model} documentation`.trim(),
        fileName: chosen.url.split('/').pop()?.split('?')[0] || `${eq.model}.pdf`,
        fileType: 'pdf',
        buffer: buf,
        equipmentType: eq.equipmentType,
        manufacturer: chosen.manufacturer ?? eq.manufacturer,
        modelNumber: eq.model,
        sourceUrl: chosen.url,
      });
      ingested++;
      details.push({
        model: eq.model,
        status: result.duplicate ? 'duplicate (hash match)' : 'ingested',
        chunks: result.document.chunk_count,
        url: chosen.url,
      });
    } catch (e) {
      details.push({ model: eq.model, status: 'ingest failed', error: (e as Error).message });
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    discovery_enabled: discoveryEnabled,
    models_checked: equipment.length,
    ingested,
    retried,
    details,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
