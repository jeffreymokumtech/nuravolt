import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantId } from '@/lib/db/timeseries';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/digitaltwin/[plantId]/inverter-metrics
 *
 * Returns per-inverter aggregated metrics from analysis_results (twin outputs).
 * Used by: group performance cards, group detail page, inverter detail page.
 *
 * Query params:
 *  - from=YYYY-MM-DD (default: all time)
 *  - to=YYYY-MM-DD (default: today)
 *  - group=PV-01 (optional: filter to specific group's inverters)
 *  - spark=N (optional: attach per-inverter `spark` array — the last N daily
 *    actual-power buckets, for the group table trend column)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date();
  const fromDate = searchParams.get('from')
    ? new Date(searchParams.get('from')!)
    : new Date('2020-01-01');

  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }

    // Per-inverter aggregated metrics from daily twin data
    const sql = `
      SELECT
        device_id,
        AVG(CASE WHEN metric = 'power_ac_predicted' THEN value END) AS avg_predicted,
        AVG(CASE WHEN metric = 'power_ac_actual' THEN value END) AS avg_actual,
        AVG(CASE WHEN metric = 'power_ac_residual' THEN value END) AS avg_residual,
        AVG(CASE WHEN metric = 'power_ac_residual' THEN ABS(value) END) AS mae_residual,
        COUNT(DISTINCT CASE WHEN metric = 'power_ac_predicted' THEN time::date END) AS days_with_data
      FROM analysis_results
      WHERE plant_id = $1::uuid
        AND domain = 'digitaltwin'
        AND device_id LIKE 'INV%'
        AND device_id != 'PLANT'
        AND time >= $2 AND time <= $3
      GROUP BY device_id
      ORDER BY device_id
    `;

    const rows = await prisma.$queryRawUnsafe<any[]>(sql, plantUuid, fromDate, toDate);

    // First pass: compute per-inverter metrics
    const rawInverters = rows.map((r) => {
      const avgPredicted = Number(r.avg_predicted) || 0;
      const avgActual = Number(r.avg_actual) || 0;
      const avgResidual = Number(r.avg_residual) || 0;
      const maeResidual = Number(r.mae_residual) || 0;
      // lossPct = signed mean bias (positive = actual under predicted = real loss);
      // maePct = magnitude of day-to-day deviation (always non-negative).
      // A well-tracked inverter shows lossPct ≈ 0 with non-trivial maePct,
      // matching the chart: residual bars cancel out on average but daily
      // noise is still visible. Both are surfaced separately on the UI.
      const lossPct = avgPredicted > 0
        ? ((avgPredicted - avgActual) / avgPredicted) * 100
        : 0;
      const maePct = avgPredicted > 0
        ? (maeResidual / avgPredicted) * 100
        : 0;
      return {
        inverterId: r.device_id as string,
        avgPredicted: Math.round(avgPredicted * 100) / 100,
        avgActual: Math.round(avgActual * 100) / 100,
        avgResidual: Math.round(avgResidual * 100) / 100,
        maeResidual: Math.round(maeResidual * 100) / 100,
        lossPct: Math.round(lossPct * 100) / 100,
        maePct: Math.round(maePct * 100) / 100,
        performanceRatio: avgPredicted > 0 ? avgActual / avgPredicted : 1,
        daysWithData: Number(r.days_with_data) || 0,
      };
    });

    // Second pass: compute fleet stats (rank, z-score) from actual data
    const lossValues = rawInverters.map(i => i.lossPct);
    const fleetMeanLoss = lossValues.length > 0 ? lossValues.reduce((a, b) => a + b, 0) / lossValues.length : 0;
    const fleetStdLoss = lossValues.length > 1
      ? Math.sqrt(lossValues.reduce((s, v) => s + (v - fleetMeanLoss) ** 2, 0) / (lossValues.length - 1))
      : 1;
    const sorted = [...rawInverters].sort((a, b) => a.lossPct - b.lossPct);

    // Optional per-inverter trend sparkline: last N daily actual-power
    // buckets from the daily continuous aggregate (one grouped query).
    const sparkDays = Math.min(30, Number(searchParams.get('spark')) || 0);
    const sparkByDevice = new Map<string, number[]>();
    if (sparkDays > 0) {
      const sparkRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT device_id, bucket::date AS day, avg_value
         FROM analysis_daily
         WHERE plant_id = $1::uuid
           AND domain = 'digitaltwin'
           AND metric = 'power_ac_actual'
           AND device_id LIKE 'INV%'
           AND device_id != 'PLANT'
           AND bucket >= (
             SELECT MAX(bucket) - ($2 || ' days')::interval
             FROM analysis_daily
             WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
               AND metric = 'power_ac_actual'
           )
         ORDER BY device_id, day`,
        plantUuid,
        String(sparkDays)
      );
      for (const r of sparkRows) {
        const arr = sparkByDevice.get(r.device_id) ?? [];
        arr.push(Math.round(Number(r.avg_value) * 10) / 10);
        sparkByDevice.set(r.device_id, arr);
      }
    }

    const inverters = rawInverters.map((inv) => {
      const rank = sorted.findIndex(s => s.inverterId === inv.inverterId) + 1;
      const zScore = fleetStdLoss > 0 ? (inv.lossPct - fleetMeanLoss) / fleetStdLoss : 0;
      const deviation = fleetMeanLoss > 0 ? ((inv.lossPct - fleetMeanLoss) / fleetMeanLoss) * 100 : 0;
      const severity = zScore > 2 ? 'critical' : zScore > 1.5 ? 'major' : zScore > 1 ? 'minor' : 'normal';
      const spark = sparkByDevice.get(inv.inverterId);
      return {
        ...inv,
        rank,
        zScore: Math.round(zScore * 100) / 100,
        deviationFromMean_pct: Math.round(deviation * 100) / 100,
        severity,
        ...(spark && spark.length >= 2 ? { spark } : {}),
      };
    });

    return NextResponse.json({
      plantId,
      _source: 'database',
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      count: inverters.length,
      fleetStats: {
        meanLossPct: Math.round(fleetMeanLoss * 100) / 100,
        stdLossPct: Math.round(fleetStdLoss * 100) / 100,
        totalInverters: inverters.length,
      },
      inverters,
    });
  } catch (error) {
    console.error('Failed to fetch inverter metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inverter metrics' },
      { status: 500 }
    );
  }
}
