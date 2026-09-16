import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';
import prisma from '@/libs/prisma';
import type { DegradedStream } from '@/components/soiling/quality/StreamHealthRow';

export const runtime = 'nodejs';

/** Annotate degraded streams with their open curation state (acknowledged /
 *  excluded) so the hub can render durable state after a reload. Soft-fails
 *  to no annotations when the persistence tables aren't migrated yet. */
async function annotateCuration(
  plantId: string,
  streams: DegradedStream[],
): Promise<void> {
  if (streams.length === 0) return;
  const ids = streams.map((s) => s.stream_id);
  const now = new Date();
  try {
    const [acks, exclusions] = await Promise.all([
      prisma.dataQualityAcknowledgement.findMany({
        where: {
          plant_id: plantId,
          stream_id: { in: ids },
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        select: { stream_id: true },
      }),
      prisma.dataStreamExclusion.findMany({
        where: { plant_id: plantId, stream_id: { in: ids }, ends_at: null },
        select: { stream_id: true },
      }),
    ]);
    const acked = new Set(acks.map((a) => a.stream_id));
    const excluded = new Set(exclusions.map((e) => e.stream_id));
    for (const s of streams) {
      if (excluded.has(s.stream_id)) s.excluded = true;
      else if (acked.has(s.stream_id)) s.acknowledged = true;
    }
  } catch {
    // Persistence tables missing (migration pending) — annotations stay off.
  }
}

/** Persist the freshness scan into DataStreamHealth (denormalised per-stream
 *  snapshot) and read richer attribution back out of it. The table is the
 *  durable home for stream attribution: the request-time scan only knows
 *  "stale_stream", but attribution jobs (or operators) can write a more
 *  specific cause — when one exists, it wins over the generic scan result.
 *  Soft-fails in both directions when the table isn't migrated. */
async function syncStreamHealth(
  plantSlug: string,
  organizationId: string | null,
  streams: DegradedStream[],
): Promise<void> {
  if (streams.length === 0 || !organizationId) return;
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { clerk_org_id: true },
    });
    const orgId = org?.clerk_org_id;
    if (!orgId) return;

    // Read back durable attribution first (richer causes win).
    const existing = await prisma.dataStreamHealth.findMany({
      where: {
        org_clerk_id: orgId,
        plant_id: plantSlug,
        stream_id: { in: streams.map((s) => s.stream_id) },
      },
    });
    const byStream = new Map(existing.map((r) => [r.stream_id, r]));
    for (const s of streams) {
      const durable = byStream.get(s.stream_id);
      if (
        durable?.attribution_cause &&
        !['stale_stream', 'unknown'].includes(durable.attribution_cause)
      ) {
        s.attribution_cause = durable.attribution_cause;
        if (durable.attribution_narrative) {
          s.attribution_narrative = durable.attribution_narrative;
        }
      }
    }

    // Write the fresh scan through (keeps gap/severity/last_good_at current
    // without clobbering richer attribution written by other jobs).
    await Promise.all(
      streams.map((s) => {
        const durable = byStream.get(s.stream_id);
        const keepRicherAttribution =
          durable?.attribution_cause &&
          !['stale_stream', 'unknown'].includes(durable.attribution_cause);
        return prisma.dataStreamHealth.upsert({
          where: {
            org_clerk_id_plant_id_stream_id: {
              org_clerk_id: orgId,
              plant_id: plantSlug,
              stream_id: s.stream_id,
            },
          },
          create: {
            org_clerk_id: orgId,
            plant_id: plantSlug,
            stream_id: s.stream_id,
            label: s.label,
            category: s.category,
            severity: s.severity,
            last_good_at: new Date(s.last_good_at),
            last_value: s.last_value,
            gap_minutes: s.gap_minutes,
            attribution_cause: s.attribution_cause,
            attribution_narrative: s.attribution_narrative,
            affected_kpis: s.affected_kpis,
          },
          update: {
            label: s.label,
            category: s.category,
            severity: s.severity,
            last_good_at: new Date(s.last_good_at),
            last_value: s.last_value,
            gap_minutes: s.gap_minutes,
            ...(keepRicherAttribution
              ? {}
              : {
                  attribution_cause: s.attribution_cause,
                  attribution_narrative: s.attribution_narrative,
                }),
            affected_kpis: s.affected_kpis,
          },
        });
      }),
    );
  } catch {
    // Table missing / DB hiccup — the snapshot still serves without it.
  }
}

/** Resolve the plant's contracted coverage SLA. Configurable per plant via
 *  Plant.metadata.sla_contract_pct; otherwise the platform default 98%,
 *  explicitly labeled as such so the UI never presents the default as a
 *  negotiated contract value. */
function resolveContract(metadata: unknown): {
  contract_pct: number;
  contract_source: 'configured' | 'default';
} {
  if (metadata && typeof metadata === 'object') {
    const v = (metadata as Record<string, unknown>).sla_contract_pct;
    if (typeof v === 'number' && v > 0 && v <= 100) {
      return { contract_pct: v, contract_source: 'configured' };
    }
  }
  return { contract_pct: 98, contract_source: 'default' };
}

/** Compute the daily data-quality snapshot from the plant's own measurements
 *  (freshness of each device/metric stream + month-to-date coverage SLA).
 *  Returns null when the plant has no measurements, so the caller falls back to
 *  the demo fixture. This is the live path for dashboard plants. */
async function computeTodayFromDb(
  plantUuid: string,
  plantId: string,
  plantMetadata: unknown,
  organizationId: string | null,
) {
  const rows = await prisma.$queryRaw<
    Array<{ device_id: string; metric: string; n: bigint; last_time: Date }>
  >`SELECT device_id, metric, COUNT(*)::bigint AS n, MAX(time) AS last_time
    FROM measurements
    WHERE plant_id::text = ${plantUuid} AND time >= NOW() - INTERVAL '35 days'
    GROUP BY device_id, metric`;
  if (!rows.length) return null;

  const now = Date.now();
  const categoryOf = (m: string): DegradedStream['category'] =>
    /irradiance|temp|wind|ghi|poa/i.test(m)
      ? 'met_sensor'
      : /dustiq|soiling/i.test(m)
        ? 'soiling_sensor'
        : 'inverter';

  let fresh = 0, stale_under_1h = 0, stale_under_24h = 0, stale_over_24h = 0;
  const degraded: DegradedStream[] = [];
  for (const r of rows) {
    const ageMin = (now - new Date(r.last_time).getTime()) / 60000;
    if (ageMin < 90) fresh++;
    else if (ageMin < 360) stale_under_1h++;
    else if (ageMin < 1440) stale_under_24h++;
    else stale_over_24h++;
    if (ageMin > 1440) {
      degraded.push({
        stream_id: `${r.device_id}:${r.metric}`,
        label: `${r.device_id} · ${r.metric}`,
        category: categoryOf(r.metric),
        severity: ageMin > 4320 ? 'high' : 'medium',
        last_good_at: new Date(r.last_time).toISOString(),
        last_value: null,
        gap_minutes: Math.round(ageMin),
        attribution_cause: 'stale_stream',
        attribution_narrative: `No fresh samples for ${Math.round(ageMin / 60)}h — check the connector/poller for this stream.`,
        affected_kpis: ['soiling_ratio', 'performance_ratio'],
        recommended_action: 'Verify the data connection is polling',
      });
    }
  }
  degraded.sort((a, b) => b.gap_minutes - a.gap_minutes);

  // Month-to-date coverage SLA: distinct days with data / days elapsed.
  const cov = await prisma.$queryRaw<Array<{ days: bigint }>>`
    SELECT COUNT(DISTINCT date_trunc('day', time))::bigint AS days
    FROM measurements
    WHERE plant_id::text = ${plantUuid} AND time >= date_trunc('month', NOW())`;
  const daysWithData = Number(cov[0]?.days ?? 0);
  const d = new Date();
  const dayOfMonth = d.getUTCDate();
  const daysInMonth = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
  const mtdPct = dayOfMonth > 0 ? Math.min(100, (daysWithData / dayOfMonth) * 100) : 0;
  const rounded = Math.round(mtdPct * 10) / 10;

  // Projected end-of-month coverage: linear run-rate — assume the remaining
  // days land data at the month-to-date daily rate. (This used to just echo
  // mtd_pct, which is not a projection.)
  const runRate = dayOfMonth > 0 ? daysWithData / dayOfMonth : 0;
  const projectedDays = daysWithData + runRate * daysRemaining;
  const projectedEom =
    daysInMonth > 0 ? Math.min(100, (projectedDays / daysInMonth) * 100) : 0;

  const contract = resolveContract(plantMetadata);

  const topDegraded = degraded.slice(0, 5);
  await syncStreamHealth(plantId, organizationId, topDegraded);
  await annotateCuration(plantId, topDegraded);

  return {
    plant_id: plantId,
    generated_at: new Date().toISOString(),
    sla: {
      contract_pct: contract.contract_pct,
      contract_source: contract.contract_source,
      mtd_pct: rounded,
      projected_eom_pct: Math.round(projectedEom * 10) / 10,
      projection_method: 'linear run-rate',
      days_remaining_in_month: daysRemaining,
      iec_reference: 'IEC 61724-1',
    },
    freshness_summary: { total_streams: rows.length, fresh, stale_under_1h, stale_under_24h, stale_over_24h },
    top_degraded: topDegraded,
    satellite_fallback_active: null,
    kpi_impact: [],
    curation_log_recent: [],
    coverage: 'enabled',
    _source: 'computed',
  };
}

/**
 * GET /api/soiling/plants/[plantId]/quality/today
 *
 * Returns the Wave-1 daily data-quality snapshot for a plant including:
 * - SLA freshness summary
 * - Top degraded streams
 * - Satellite fallback status
 * - KPI impact and curation log
 *
 * Returns a "not_yet_enabled" placeholder when the fixture is missing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // DB-first: compute from the plant's own measurements. Real (dashboard)
    // plants have no fixture, so this is the live path; demo/showcase plants
    // with no DB measurements fall through to the fixture.
    try {
      const plantUuid = readAccess.plant?.id;
      if (plantUuid) {
        const computed = await computeTodayFromDb(
          plantUuid,
          plantId,
          (readAccess.plant as { metadata?: unknown } | null)?.metadata,
          (readAccess.plant as { organization_id?: string | null } | null)
            ?.organization_id ?? null,
        );
        if (computed) return NextResponse.json(computed);
      }
    } catch (e) {
      console.warn('quality/today DB compute failed, falling back to fixture:', e);
    }

    // Showcase plants live under public/data/showcase/soiling/{plantId}/.
    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const baseSubdir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    const dataPath = path.join(
      process.cwd(),
      'public',
      'data',
      baseSubdir,
      plantId,
      'quality',
      'today.json'
    );

    try {
      await fs.access(dataPath);
    } catch {
      return NextResponse.json({
        plant_id: plantId,
        generated_at: new Date().toISOString(),
        sla: null,
        freshness_summary: {
          total_streams: 0,
          fresh: 0,
          stale_under_1h: 0,
          stale_under_24h: 0,
          stale_over_24h: 0,
        },
        top_degraded: [],
        satellite_fallback_active: null,
        kpi_impact: [],
        curation_log_recent: [],
        coverage: 'not_yet_enabled',
      });
    }

    const rawData = await fs.readFile(dataPath, 'utf-8');
    const data = JSON.parse(rawData);
    // Label the source so the UI can render freshness relative to the
    // fixture's snapshot instant instead of faking "Xm ago" against now.
    return NextResponse.json({ ...data, _source: 'fixture' });
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/quality/today:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
