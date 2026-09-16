import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { queryAnalysisResults, resolvePlantId } from '@/lib/db/timeseries';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/digitaltwin/[plantId]/parquet-query
 *
 * Per-device twin timeseries for the MPPT / string drill-down. This used to
 * execSync a Python + DuckDB read of a local Parquet file, which cannot run on
 * Vercel (no Python, and the twin Parquet is laptop-only), so it 500'd on prod.
 * It now reads Postgres via the same queryAnalysisResults path as the working
 * ../timeseries route.
 *
 * Per-MPPT / per-string granularity is only present in analysis_results once
 * the offline aggregation writes those device_ids (see docs/DEMO_ACCOUNT.md);
 * until then this returns an honest empty series (not a 500 and not fabricated
 * data), and the drill-down page falls back to its snapshot overlay.
 *
 * Query params:
 *  - device_id (required) — "INV 01.032.MPPT-1", "INV 01.032.STR-1", or "INV 01.032"
 *  - type — power | temperature | mppt_voltage | string_current | string_current_sum
 *  - from / to = YYYY-MM-DD (default: last 30 days)
 */

const TWIN_TYPES = ['power', 'temperature', 'mppt_voltage', 'string_current', 'string_current_sum'] as const;
type TwinType = (typeof TWIN_TYPES)[number];

const METRIC_BASE: Record<TwinType, string> = {
  power: 'power_ac',
  temperature: 'temperature',
  mppt_voltage: 'mppt_voltage',
  string_current: 'string_current',
  string_current_sum: 'string_current',
};

// Strings per MPPT; overridable to match the array wiring.
const STRINGS_PER_MPPT = Number(process.env.STRINGS_PER_MPPT || 2);

/** Child string device_ids for an MPPT id: "INV X.Y.MPPT-2" -> STR-3, STR-4. */
function childStringIds(mpptDeviceId: string): string[] {
  const m = mpptDeviceId.match(/^(.*)\.MPPT-(\d+)$/);
  if (!m) return [];
  const base = m[1];
  const k = parseInt(m[2], 10);
  const ids: string[] = [];
  for (let s = (k - 1) * STRINGS_PER_MPPT + 1; s <= k * STRINGS_PER_MPPT; s++) {
    ids.push(`${base}.STR-${s}`);
  }
  return ids;
}

type DateBucket = Record<string, { predicted?: number; actual?: number; residual?: number }>;

async function bucketForDevice(
  plantUuid: string,
  deviceId: string,
  metricBase: string,
  from: Date,
  to: Date,
): Promise<DateBucket> {
  const rows = await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'digitaltwin',
    metrics: [`${metricBase}_predicted`, `${metricBase}_actual`, `${metricBase}_residual`],
    deviceId,
    from,
    to,
    resolution: 'daily',
    limit: 5000,
  });
  const byDate: DateBucket = {};
  for (const row of rows) {
    const date = ((row as any).bucket ? new Date((row as any).bucket) : new Date(row.time))
      .toISOString()
      .split('T')[0];
    if (!byDate[date]) byDate[date] = {};
    const value = (row as any).avg_value ?? row.value ?? 0;
    if (row.metric === `${metricBase}_predicted`) byDate[date].predicted = value;
    else if (row.metric === `${metricBase}_actual`) byDate[date].actual = value;
    else if (row.metric === `${metricBase}_residual`) byDate[date].residual = value;
  }
  return byDate;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const deviceId = searchParams.get('device_id');
  const twinType = (searchParams.get('type') || 'power') as TwinType;

  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required', series: [] }, { status: 400 });
  }
  if (!TWIN_TYPES.includes(twinType)) {
    return NextResponse.json(
      { error: `type must be one of: ${TWIN_TYPES.join(', ')}`, series: [] },
      { status: 400 },
    );
  }

  const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date();
  const fromDate = searchParams.get('from')
    ? new Date(searchParams.get('from')!)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found', series: [] }, { status: 404 });
    }

    const metricBase = METRIC_BASE[twinType];

    let byDate: DateBucket;
    if (twinType === 'string_current_sum') {
      // Sum the child strings under this MPPT, per date + field.
      byDate = {};
      const children = childStringIds(deviceId);
      for (const child of children) {
        const childBucket = await bucketForDevice(plantUuid, child, metricBase, fromDate, toDate);
        for (const [date, v] of Object.entries(childBucket)) {
          if (!byDate[date]) byDate[date] = {};
          for (const field of ['predicted', 'actual', 'residual'] as const) {
            if (typeof v[field] === 'number') {
              byDate[date][field] = (byDate[date][field] ?? 0) + (v[field] as number);
            }
          }
        }
      }
    } else {
      byDate = await bucketForDevice(plantUuid, deviceId, metricBase, fromDate, toDate);
    }

    const series = Object.entries(byDate)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Provenance: surface the twin's model_version so the drill-down can render
    // an honest caption (e.g. snapshot-derived vs physics-synth vs trained).
    let modelVersion: string | null = null;
    if (series.length > 0) {
      const lookupDevice =
        twinType === 'string_current_sum' ? childStringIds(deviceId)[0] ?? deviceId : deviceId;
      const mv = await prisma.$queryRawUnsafe<{ model_version: string | null }[]>(
        `SELECT model_version FROM analysis_results
         WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
           AND device_id = $2 AND model_version IS NOT NULL
         ORDER BY time DESC LIMIT 1`,
        plantUuid,
        lookupDevice,
      );
      modelVersion = mv[0]?.model_version ?? null;
    }

    return NextResponse.json({
      plantId,
      deviceId,
      twinType,
      period: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
      },
      series,
      count: series.length,
      modelVersion,
      _source: series.length > 0 ? 'database' : 'empty',
    });
  } catch (error) {
    console.error('parquet-query failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch twin timeseries', series: [] },
      { status: 500 },
    );
  }
}
