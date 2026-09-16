import { NextRequest, NextResponse } from 'next/server';
import { queryAnalysisResults, resolvePlantId } from '@/lib/db/timeseries';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/digitaltwin/[plantId]/timeseries
 *
 * Returns twin predicted vs actual timeseries for a specific device.
 *
 * Query params:
 *  - device_id (required) — e.g. "INV 01.032" or "PLANT"
 *  - metric — power_ac | temperature | voltage_dc | current_dc (default: power_ac)
 *  - from=YYYY-MM-DD (default: last 30 days)
 *  - to=YYYY-MM-DD (default: today)
 *  - fleet=1 — when set, returns plant-wide P10/P50/P90 across all inverters for
 *    the same metric per day, so the UI can render a fleet-percentile band
 *    behind the predicted/actual lines.
 *
 * All metrics are stored directly in analysis_results:
 *  - power_ac: inverter AC power (kW)
 *  - temperature: inverter temperature (°C)
 *  - voltage_dc: mean DC voltage across MPPTs (V)
 *  - current_dc: sum of DC string currents (A) at inverter level
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const deviceId = searchParams.get('device_id');
  const metric = searchParams.get('metric') || 'power_ac';
  const includeFleet = searchParams.get('fleet') === '1';

  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required' }, { status: 400 });
  }

  const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date();
  const fromDate = searchParams.get('from')
    ? new Date(searchParams.get('from')!)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }

    const rows = await queryAnalysisResults({
      plantId: plantUuid,
      domain: 'digitaltwin',
      metrics: [`${metric}_predicted`, `${metric}_actual`, `${metric}_residual`],
      deviceId,
      from: fromDate,
      to: toDate,
      resolution: 'daily',
      limit: 5000,
    });

    const byDate: Record<string, { predicted?: number; actual?: number; residual?: number }> = {};
    for (const row of rows) {
      const date = (row as any).bucket
        ? new Date((row as any).bucket).toISOString().split('T')[0]
        : new Date(row.time).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = {};
      const value = (row as any).avg_value ?? row.value ?? 0;
      if (row.metric === `${metric}_predicted`) byDate[date].predicted = value;
      else if (row.metric === `${metric}_actual`) byDate[date].actual = value;
      else if (row.metric === `${metric}_residual`) byDate[date].residual = value;
    }

    const series = Object.entries(byDate)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Provenance for the UI: synth-derived channels (electrical-synth-*) get
    // an honest caption. Daily aggregates drop model_version, so one cheap
    // raw-row lookup.
    let modelVersion: string | null = null;
    if (series.length > 0) {
      const mv = await prisma.$queryRawUnsafe<{ model_version: string | null }[]>(
        `SELECT model_version FROM analysis_results
         WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
           AND metric = $2 AND device_id = $3 AND model_version IS NOT NULL
         ORDER BY time DESC LIMIT 1`,
        plantUuid,
        `${metric}_predicted`,
        deviceId
      );
      modelVersion = mv[0]?.model_version ?? null;
    }

    let fleet:
      | {
          scope: 'group' | 'plant';
          groupSize: number;
          series: Array<{ date: string; p10: number; p50: number; p90: number; count: number }>;
        }
      | undefined;

    if (includeFleet) {
      // Prefer peer-group scope: inverters within the same InverterGroup share
      // weather, age, and electrical configuration, so they're a tighter null
      // hypothesis than the entire plant. Fall back to plant-wide when the
      // device has no group (e.g., legacy fixtures) or when the group only
      // contains the device itself.
      //
      // The Inverter table stores `external_id` with underscores ("INV_01_003")
      // while analysis_results / SCADA use spaces+dots ("INV 01.003"). We
      // convert between the two forms for the lookup, then back for the
      // downstream query.
      const toExternalId = (scadaId: string) =>
        scadaId.replace(/ /, '_').replace('.', '_');
      const toScadaId = (externalId: string) =>
        externalId.replace('_', ' ').replace('_', '.');

      const siblingRows = await prisma.$queryRawUnsafe<{ external_id: string }[]>(
        `SELECT i.external_id
         FROM "Inverter" i
         JOIN "InverterGroup" g ON g.id = i.group_id
         WHERE g.plant_id = $1
           AND i.group_id = (
             SELECT i2.group_id FROM "Inverter" i2
             JOIN "InverterGroup" g2 ON g2.id = i2.group_id
             WHERE g2.plant_id = $1 AND i2.external_id = $2
             LIMIT 1
           )`,
        plantUuid,
        toExternalId(deviceId),
      );

      const siblingIds = siblingRows.map((r) => toScadaId(r.external_id));
      const usePeerGroup = siblingIds.length >= 3;

      const fleetSql = usePeerGroup
        ? `
        SELECT
          bucket::date AS day,
          percentile_cont(0.10) WITHIN GROUP (ORDER BY avg_value) AS p10,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_value) AS p50,
          percentile_cont(0.90) WITHIN GROUP (ORDER BY avg_value) AS p90,
          COUNT(DISTINCT device_id) AS count
        FROM analysis_daily
        WHERE plant_id = $1::uuid
          AND domain = 'digitaltwin'
          AND metric = $2
          AND device_id = ANY($3::text[])
          AND bucket >= $4 AND bucket <= $5
        GROUP BY bucket::date
        ORDER BY day
      `
        : `
        SELECT
          bucket::date AS day,
          percentile_cont(0.10) WITHIN GROUP (ORDER BY avg_value) AS p10,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_value) AS p50,
          percentile_cont(0.90) WITHIN GROUP (ORDER BY avg_value) AS p90,
          COUNT(DISTINCT device_id) AS count
        FROM analysis_daily
        WHERE plant_id = $1::uuid
          AND domain = 'digitaltwin'
          AND metric = $2
          AND device_id LIKE 'INV%'
          AND device_id != 'PLANT'
          AND bucket >= $3 AND bucket <= $4
        GROUP BY bucket::date
        ORDER BY day
      `;
      const fleetParams = usePeerGroup
        ? [plantUuid, `${metric}_actual`, siblingIds, fromDate, toDate]
        : [plantUuid, `${metric}_actual`, fromDate, toDate];

      const fleetRows = await prisma.$queryRawUnsafe<any[]>(fleetSql, ...fleetParams);
      fleet = {
        scope: usePeerGroup ? 'group' : 'plant',
        groupSize: usePeerGroup ? siblingIds.length : 0,
        series: fleetRows.map((r) => ({
          date: new Date(r.day).toISOString().split('T')[0],
          p10: Number(r.p10) ?? 0,
          p50: Number(r.p50) ?? 0,
          p90: Number(r.p90) ?? 0,
          count: Number(r.count) ?? 0,
        })),
      };
    }

    return NextResponse.json({
      plantId, deviceId, metric,
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      series,
      ...(fleet ? { fleet } : {}),
      ...(modelVersion ? { modelVersion } : {}),
      _source: rows.length > 0 ? 'database' : 'empty',
    });
  } catch (error) {
    console.error('Failed to fetch twin timeseries:', error);
    return NextResponse.json(
      { error: 'Failed to fetch twin timeseries' },
      { status: 500 }
    );
  }
}
