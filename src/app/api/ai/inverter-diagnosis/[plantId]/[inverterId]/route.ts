import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { queryAnalysisResults, resolvePlantId } from '@/lib/db/timeseries';
import { extractJson, invokeBedrockDetailed, modelLabel } from '@/lib/ai/bedrock';
import { recordLLMInteraction } from '@/lib/ai/llm-pricing';
import fs from 'fs/promises';
import path from 'path';
import type { Classification } from '@/lib/maintenance/types';
import { requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';
import { requireFeature } from '@/lib/billing/gate';

/**
 * POST /api/ai/inverter-diagnosis/[plantId]/[inverterId]
 *
 * Generates an AI-powered diagnosis of an inverter by analyzing:
 *  - 30-day twin metrics (power, temperature, DC voltage, DC current)
 *  - Huawei SUN2000-60KTL-M0 fault code reference
 *
 * Returns:
 *  { summary, severity, actions[], fault_hypothesis }
 *
 * Powered by DeepSeek-V3 on AWS Bedrock (data stays in AWS VPC).
 */

const VALID_ACTIONS = [
  'create_ticket',
  'schedule_cleaning',
  'schedule_inspection',
  'monitor',
  'check_shading',
  'check_wiring',
  'verify_grid',
  'replace_sensor',
];

interface TwinStats {
  metric: string;
  avg_predicted: number;
  avg_actual: number;
  avg_residual: number;
  loss_pct: number;
  days: number;
}

async function loadManual(): Promise<any> {
  const p = path.join(process.cwd(), 'public', 'data', 'manuals', 'SUN2000-60KTL-M0.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return null;
  }
}

async function getTwinStats(
  plantUuid: string,
  deviceId: string,
  metricBase: string,
  fromDate: Date,
  toDate: Date
): Promise<TwinStats | null> {
  const rows = await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'digitaltwin',
    metrics: [`${metricBase}_predicted`, `${metricBase}_actual`, `${metricBase}_residual`],
    deviceId,
    from: fromDate,
    to: toDate,
    resolution: 'daily',
    limit: 5000,
  });
  if (rows.length === 0) return null;
  const byMetric: Record<string, number[]> = {
    [`${metricBase}_predicted`]: [],
    [`${metricBase}_actual`]: [],
    [`${metricBase}_residual`]: [],
  };
  for (const row of rows) {
    const v = (row as any).avg_value ?? row.value;
    if (typeof v === 'number' && byMetric[row.metric] !== undefined) {
      byMetric[row.metric].push(v);
    }
  }
  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgPred = avg(byMetric[`${metricBase}_predicted`]);
  const avgAct = avg(byMetric[`${metricBase}_actual`]);
  const avgRes = avg(byMetric[`${metricBase}_residual`]);
  const lossPct = avgPred > 0 ? ((avgPred - avgAct) / avgPred) * 100 : 0;
  return {
    metric: metricBase,
    avg_predicted: Math.round(avgPred * 100) / 100,
    avg_actual: Math.round(avgAct * 100) / 100,
    avg_residual: Math.round(avgRes * 100) / 100,
    loss_pct: Math.round(lossPct * 100) / 100,
    days: byMetric[`${metricBase}_predicted`].length,
  };
}

function fmtClassifierBlock(c: Classification | null): string {
  if (!c) return 'CLASSIFIER: unavailable.';
  const eta = c.etaDays != null ? `${c.etaDays} days` : 'no ETA (monitor only)';
  return [
    'CLASSIFIER (deterministic rule layer):',
    `- Peer-deviation tier: ${c.tier} (PDS = ${c.pds.toFixed(2)}σ vs group ${c.group})`,
    `- Likely cause: ${c.likelyCause} (confidence ${(c.confidence * 100).toFixed(0)}%)`,
    `- Recommended action: ${c.recommendedAction}, ETA: ${eta}`,
    `- Evidence:\n${c.evidence.map((e) => `    • ${e}`).join('\n')}`,
    `- Rule id: ${c.ruleId}`,
  ].join('\n');
}

function buildPrompt(
  inverterId: string,
  stats: Record<string, TwinStats | null>,
  manual: any,
  classification: Classification | null
): string {
  const specs = manual?.specs || {};
  const faults = (manual?.fault_codes || []).slice(0, 21);
  const faultTable = faults
    .map((f: any) => `  ${f.code} [${f.severity}] ${f.name}`)
    .join('\n');
  const patterns = (manual?.common_patterns || [])
    .map(
      (p: any) =>
        `  - ${p.pattern} → ${p.likely_causes.join(', ')} (related alarms: ${p.related_alarms.join(', ')})`
    )
    .join('\n');

  const fmt = (s: TwinStats | null, unit: string) =>
    s
      ? `predicted=${s.avg_predicted}${unit}, actual=${s.avg_actual}${unit}, residual=${s.avg_residual}${unit}, loss=${s.loss_pct}%, days=${s.days}`
      : 'no data';

  return `INVERTER: ${inverterId}
MODEL: SUN2000-60KTL-M0 (Huawei), nominal 60 kW AC, 6 MPPTs × 2 strings = 12 strings total
RATED: max DC power ${specs.max_dc_input_power_w ?? 67400}W, MPPT range ${JSON.stringify(specs.operating_voltage_range_v || [200, 1000])}V, max I/MPPT ${specs.max_input_current_per_mppt_a ?? 22}A
DERATING: starts above ${manual?.environmental?.derating_start_temp_c ?? 45}°C ambient

TWIN METRICS (last 30 days):
- Power AC:     ${fmt(stats.power_ac, ' kW')}
- Temperature:  ${fmt(stats.temperature, '°C')}
- DC Voltage:   ${fmt(stats.voltage_dc, ' V')}
- DC Current:   ${fmt(stats.current_dc, ' A')}

${fmtClassifierBlock(classification)}

MANUAL REFERENCE (Huawei fault codes):
${faultTable}

COMMON DIAGNOSTIC PATTERNS:
${patterns}

TASK: Diagnose this inverter. The CLASSIFIER block above is a deterministic
rule-engine verdict; trust its likely_cause when its confidence ≥ 0.7, and use
your knowledge of Huawei fault codes to attach the correct fault_hypothesis.
You may override the rule only when the twin metrics contradict it — in that
case state the conflict in "reasoning".

Twin shows predicted (ideal) vs actual — positive loss_pct means real output
is below physics-based prediction. The DC voltage twin sees only tracking-
active samples (night values are intentionally excluded). Use:
- Power loss > 5% with normal temp/volt/curr and rule cause = SOILING → cite Huawei "Output Power Anomaly" (or similar). actions=["schedule_cleaning"].
- Elevated temperature residual > 8°C → "Cabinet Over-Temperature" family.
- High current CV / non-uniform → "String Current Imbalance".
- Rule cause = BYPASS_DIODE with RUL ≤ 14 days → urgent / replacement.

Respond with ONLY this JSON structure (no other text):
{
  "summary": "2-3 sentence diagnosis in plain English. Reference the rule cause and at least one twin number.",
  "severity": "normal" | "investigate" | "urgent",
  "actions": ["one or more of: ${VALID_ACTIONS.join(', ')}"],
  "fault_hypothesis": { "code": "XXXX from manual", "name": "...", "confidence": 0.0-1.0 } | null,
  "reasoning": "brief explanation of which twin metrics AND rule signals drove the conclusion"
}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string; inverterId: string } }
) {
  const plantId = params.plantId;
  const inverterId = decodeURIComponent(params.inverterId);
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    // Tenancy: POST triggers paid Bedrock inference — require org + OPERATE access.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const gate = await requireFeature(orgResult.ctx.authOrgId, 'ai:copilot');
    if (gate) return gate;
    const llmBudget = await checkLLMBudget(orgResult.ctx.authOrgId);
    if (!llmBudget.ok) {
      return NextResponse.json(llmBudgetError(llmBudget), { status: 429 });
    }
    const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'OPERATE');
    if (!plantResult.ok) return plantResult.response;

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }

    // Serve a recent diagnosis instead of re-paying for Bedrock inference. The
    // panel's "Re-run" sends { force: true } to bypass this.
    const body = await request.json().catch(() => ({}) as any);
    const force = body?.force === true;
    const CACHE_MS = 6 * 60 * 60 * 1000;
    if (!force) {
      const recent = await prisma.inverterDiagnosis.findFirst({
        where: {
          plant_id: plantUuid,
          device_id: inverterId,
          created_at: { gte: new Date(Date.now() - CACHE_MS) },
        },
        orderBy: { created_at: 'desc' },
      });
      if (recent) {
        return NextResponse.json({
          plantId,
          inverterId,
          plant_uuid: plantUuid,
          diagnosis: {
            summary: recent.summary,
            severity: recent.severity,
            actions: (recent.actions as string[]) ?? [],
            fault_hypothesis: recent.fault_code
              ? { code: recent.fault_code, name: recent.fault_name, confidence: recent.confidence }
              : null,
            reasoning: recent.reasoning,
          },
          stats: recent.stats,
          classification: recent.classification,
          model: recent.model,
          latency_ms: 0,
          generated_at: recent.created_at.toISOString(),
          cached: true,
        });
      }
    }

    // Fetch twin stats + rule-classifier verdict in parallel. The classifier
    // surfaces peer deviation, soiling forecast alignment, and RUL — context
    // the LLM otherwise has to guess at from raw residuals alone.
    const origin = request.nextUrl.origin;
    const classificationUrl =
      `${origin}/api/inverters/${encodeURIComponent(inverterId)}/classification` +
      `?plant_id=${encodeURIComponent(plantId)}`;
    const [power, temp, volt, curr, manual, classification] = await Promise.all([
      getTwinStats(plantUuid, inverterId, 'power_ac', fromDate, toDate),
      getTwinStats(plantUuid, inverterId, 'temperature', fromDate, toDate),
      getTwinStats(plantUuid, inverterId, 'voltage_dc', fromDate, toDate),
      getTwinStats(plantUuid, inverterId, 'current_dc', fromDate, toDate),
      loadManual(),
      fetch(classificationUrl)
        .then(async (r): Promise<Classification | null> => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const stats = {
      power_ac: power,
      temperature: temp,
      voltage_dc: volt,
      current_dc: curr,
    };

    // Fallback: if we have no recent twin data, use the whole available range
    if (!power && !temp && !volt && !curr) {
      const fallbackFrom = new Date('2020-01-01');
      const [p2, t2, v2, c2] = await Promise.all([
        getTwinStats(plantUuid, inverterId, 'power_ac', fallbackFrom, toDate),
        getTwinStats(plantUuid, inverterId, 'temperature', fallbackFrom, toDate),
        getTwinStats(plantUuid, inverterId, 'voltage_dc', fallbackFrom, toDate),
        getTwinStats(plantUuid, inverterId, 'current_dc', fallbackFrom, toDate),
      ]);
      stats.power_ac = p2;
      stats.temperature = t2;
      stats.voltage_dc = v2;
      stats.current_dc = c2;
    }

    if (!stats.power_ac && !stats.temperature && !stats.voltage_dc && !stats.current_dc) {
      return NextResponse.json(
        { error: 'No twin data available for this inverter' },
        { status: 404 }
      );
    }

    const prompt = buildPrompt(inverterId, stats, manual, classification);
    const systemPrompt =
      'You are an expert solar PV inverter diagnostics engineer. You interpret digital twin data ' +
      '(predicted vs actual) and map symptoms to Huawei SUN2000 fault codes. You output strict JSON only.';

    const t0 = Date.now();
    const detailed = await invokeBedrockDetailed(prompt, {
      system: systemPrompt,
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.2,
    });
    const response = detailed.text;
    const latencyMs = Date.now() - t0;

    // Spend row so checkLLMBudget sees this call (was previously unlogged).
    recordLLMInteraction({
      orgClerkId: orgResult.ctx.authOrgId,
      plantId: plantUuid,
      modelId: modelLabel(),
      interactionType: 'ALERT_INTERPRETATION',
      inputTokens: detailed.inputTokens ?? Math.ceil(prompt.length / 4),
      outputTokens: detailed.outputTokens ?? Math.ceil(response.length / 4),
      latencyMs,
    });

    const parsed = extractJson<{
      summary: string;
      severity: string;
      actions: string[];
      fault_hypothesis: any;
      reasoning?: string;
    }>(response);

    if (!parsed) {
      return NextResponse.json(
        {
          error: 'Failed to parse LLM response',
          raw: response,
          latency_ms: latencyMs,
        },
        { status: 502 }
      );
    }

    // Validate actions against whitelist
    parsed.actions = (parsed.actions || []).filter((a) => VALID_ACTIONS.includes(a));

    const modelId = process.env.BEDROCK_MODEL_ID || 'qwen.qwen3-next-80b-a3b';

    // Persist so the panel keeps history and a re-view within 6h skips a paid
    // re-run. Best effort: never fail the response.
    prisma.inverterDiagnosis
      .create({
        data: {
          org_clerk_id: orgResult.ctx.authOrgId,
          plant_id: plantUuid,
          device_id: inverterId,
          severity: parsed.severity ?? 'investigate',
          summary: parsed.summary ?? '',
          fault_code: parsed.fault_hypothesis?.code ?? null,
          fault_name: parsed.fault_hypothesis?.name ?? null,
          confidence:
            typeof parsed.fault_hypothesis?.confidence === 'number'
              ? parsed.fault_hypothesis.confidence
              : null,
          actions: (parsed.actions ?? []) as any,
          reasoning: parsed.reasoning ?? null,
          stats: stats as any,
          classification: (classification ?? null) as any,
          model: modelId,
          latency_ms: latencyMs,
        },
      })
      .catch((e) => console.warn('[diagnosis] persist failed:', e));

    return NextResponse.json({
      plantId,
      inverterId,
      plant_uuid: plantUuid,
      diagnosis: parsed,
      stats,
      classification,
      model: modelId,
      latency_ms: latencyMs,
      generated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Inverter AI diagnosis failed:', error);
    return NextResponse.json(
      {
        error: 'Diagnosis failed',
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/ai/inverter-diagnosis/[plantId]/[inverterId]
 * Returns the most recent stored diagnosis for this inverter (no inference, no
 * cost), or { diagnosis: null } if none has been run yet.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string; inverterId: string } },
) {
  const plantId = params.plantId;
  const inverterId = decodeURIComponent(params.inverterId);

  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const plantResult = await requirePlantAccess(orgResult.ctx, plantId, 'VIEW');
  if (!plantResult.ok) return plantResult.response;

  const latest = await prisma.inverterDiagnosis.findFirst({
    where: { plant_id: plantResult.plant.id, device_id: inverterId },
    orderBy: { created_at: 'desc' },
  });
  if (!latest) {
    return NextResponse.json({ plantId, inverterId, diagnosis: null });
  }

  return NextResponse.json({
    plantId,
    inverterId,
    plant_uuid: plantResult.plant.id,
    diagnosis: {
      summary: latest.summary,
      severity: latest.severity,
      actions: (latest.actions as string[]) ?? [],
      fault_hypothesis: latest.fault_code
        ? { code: latest.fault_code, name: latest.fault_name, confidence: latest.confidence }
        : null,
      reasoning: latest.reasoning,
    },
    stats: latest.stats,
    classification: latest.classification,
    model: latest.model,
    latency_ms: 0,
    generated_at: latest.created_at.toISOString(),
    cached: true,
  });
}
