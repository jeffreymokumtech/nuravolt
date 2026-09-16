import { NextRequest, NextResponse } from 'next/server';
import { resolvePlantId } from '@/lib/db/timeseries';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/digitaltwin/[plantId]/inverter-rank-history
 *
 * For each inverter in the plant, returns a daily series of:
 *   - lossPct (power_ac twin loss% on that day)
 *   - rank within fleet (1 = best)
 *   - percentile (0–100, P05 = bottom 5% = severe underperformer)
 *   - pds: Peer Deviation Score = (lossPct − peer_median) / (1.4826 · peer_MAD).
 *     Robust z-score against the inverter's peer group. PDS > 0 = above peer
 *     median loss = worse than peers. PDS > 1 is conspicuous; > 2 is acute.
 *
 * The response also includes a per-inverter `classification` summary derived
 * from PDS persistence, ready for sidebar pills and anomaly-confidence KPIs:
 *   - ACUTE     : PDS > 2 on ≥ 2 of last 3 days
 *   - DEGRADED  : PDS > 1 on ≥ 7 of last 14 days
 *   - CHRONIC   : PDS > 0.5 on ≥ 21 of last 30 days (and not ACUTE/DEGRADED)
 *   - NORMAL    : otherwise
 *
 * Peer set: same InverterGroup as the inverter (typically same combiner /
 * commissioning wave / electrical block, ~30 inverters). Inverters in the
 * same group share weather and configuration, so the band is tighter and the
 * detector more sensitive than plant-wide.
 *
 * Query params:
 *   - days (optional, default 90) — trailing window
 *   - inverter_id (optional) — when set, only return that inverter's series
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const days = Math.max(1, Math.min(parseInt(searchParams.get('days') || '90', 10), 365));
  const inverterFilter = searchParams.get('inverter_id') || undefined;

  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 });
    }

    // Anchor the window on the latest available bucket so the demo surfaces
    // real data even when the fixture ends before "today". Production data
    // typically reaches yesterday, in which case latestBucket ≈ now and the
    // window behaves as a trailing window from today.
    const latestRow = await prisma.$queryRawUnsafe<any[]>(
      `SELECT MAX(bucket) AS latest FROM analysis_daily
        WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
          AND device_id LIKE 'INV%' AND device_id != 'PLANT'
          AND metric IN ('power_ac_predicted', 'power_ac_actual')`,
      plantUuid,
    );
    const latest = latestRow?.[0]?.latest ? new Date(latestRow[0].latest) : new Date();
    const toDate = latest;
    const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);

    // Pull each inverter's peer-group affiliation in one round-trip. We use
    // it both to scope PDS computation and to expose `groupSlug` in the
    // response so the UI can render group context.
    //
    // External-id convention: stored as "INV_01_001" in the Inverter table,
    // appears as "INV 01.001" in analysis_results / SCADA. We normalise on
    // read so callers see the SCADA form everywhere downstream.
    const toScadaId = (externalId: string) =>
      externalId.replace('_', ' ').replace('_', '.');
    const groupRows = await prisma.$queryRawUnsafe<{ external_id: string; group_slug: string }[]>(
      `SELECT i.external_id, g.slug AS group_slug
       FROM "Inverter" i
       JOIN "InverterGroup" g ON g.id = i.group_id
       WHERE g.plant_id = $1`,
      plantUuid,
    );
    const groupByInverter = new Map<string, string>();
    for (const r of groupRows) {
      groupByInverter.set(toScadaId(r.external_id), r.group_slug);
    }

    // Daily per-inverter aggregate of predicted + actual for power_ac.
    const sql = `
      SELECT
        bucket::date AS day,
        device_id,
        AVG(CASE WHEN metric = 'power_ac_predicted' THEN avg_value END) AS predicted,
        AVG(CASE WHEN metric = 'power_ac_actual' THEN avg_value END) AS actual
      FROM analysis_daily
      WHERE plant_id = $1::uuid
        AND domain = 'digitaltwin'
        AND device_id LIKE 'INV%'
        AND device_id != 'PLANT'
        AND metric IN ('power_ac_predicted', 'power_ac_actual')
        AND bucket >= $2 AND bucket <= $3
      GROUP BY bucket::date, device_id
      ORDER BY day, device_id
    `;
    const rows = await prisma.$queryRawUnsafe<any[]>(sql, plantUuid, fromDate, toDate);

    // Bucket entries by day so we can rank/PDS them within day. Also keep a
    // per-day, per-group sub-bucket for peer-group PDS.
    interface Entry { inverterId: string; group: string; loss: number }
    const byDay = new Map<string, Entry[]>();
    for (const r of rows) {
      const day = new Date(r.day).toISOString().split('T')[0];
      const predicted = Number(r.predicted) || 0;
      const actual = Number(r.actual) || 0;
      if (predicted <= 0) continue;
      const loss = ((predicted - actual) / predicted) * 100;
      const group = groupByInverter.get(r.device_id) ?? 'unknown';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ inverterId: r.device_id, group, loss });
    }

    const median = (xs: number[]): number => {
      if (xs.length === 0) return 0;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    const mad = (xs: number[], med: number): number => {
      if (xs.length === 0) return 0;
      const abs = xs.map((v) => Math.abs(v - med));
      return median(abs);
    };

    interface Point {
      date: string;
      rank: number;
      total: number;
      percentile: number;
      lossPct: number;
      pds: number;
    }
    const perInverter = new Map<string, Point[]>();
    const sortedDays = Array.from(byDay.keys()).sort();

    for (const day of sortedDays) {
      const entries = byDay.get(day)!;

      // Plant-wide rank/percentile (preserved for the rank-trajectory chart).
      const sortedByLoss = [...entries].sort((a, b) => a.loss - b.loss);
      const total = sortedByLoss.length;

      // Peer-group robust median + MAD per day. Single-pass.
      const lossByGroup = new Map<string, number[]>();
      for (const e of entries) {
        if (!lossByGroup.has(e.group)) lossByGroup.set(e.group, []);
        lossByGroup.get(e.group)!.push(e.loss);
      }
      const groupStats = new Map<string, { med: number; mad: number }>();
      for (const [g, xs] of lossByGroup.entries()) {
        const med = median(xs);
        const m = mad(xs, med);
        // Scale MAD by 1.4826 so it's a consistent estimator of σ for Gaussian
        // data — keeps PDS interpretable like a robust z-score. Floor at 0.5
        // (loss points) so a perfectly homogeneous group doesn't divide-by-zero.
        const sigma = Math.max(0.5, 1.4826 * m);
        groupStats.set(g, { med, mad: sigma });
      }

      sortedByLoss.forEach((entry, idx) => {
        const rank = idx + 1;
        const rankFromWorst = total - rank + 1;
        const percentile = total > 1
          ? Math.round(((rankFromWorst - 1) / (total - 1)) * 100)
          : 50;
        const stats = groupStats.get(entry.group)!;
        const pds = (entry.loss - stats.med) / stats.mad;

        if (!perInverter.has(entry.inverterId)) perInverter.set(entry.inverterId, []);
        perInverter.get(entry.inverterId)!.push({
          date: day,
          rank,
          total,
          percentile,
          lossPct: Math.round(entry.loss * 100) / 100,
          pds: Math.round(pds * 100) / 100,
        });
      });
    }

    // Persistence-based classification on each inverter's PDS series.
    type Classification = 'ACUTE' | 'DEGRADED' | 'CHRONIC' | 'NORMAL';
    const classify = (series: Point[]): { tier: Classification; reason: string } => {
      const last3 = series.slice(-3);
      const last14 = series.slice(-14);
      const last30 = series.slice(-30);
      const acute = last3.filter((p) => p.pds > 2).length >= 2 && last3.length >= 2;
      const degraded = last14.filter((p) => p.pds > 1).length >= 7;
      const chronic = last30.filter((p) => p.pds > 0.5).length >= 21;
      if (acute) {
        const days = last3.filter((p) => p.pds > 2).length;
        return { tier: 'ACUTE', reason: `PDS > 2 on ${days}/${last3.length} of last 3 days` };
      }
      if (degraded) {
        const days = last14.filter((p) => p.pds > 1).length;
        return { tier: 'DEGRADED', reason: `PDS > 1 on ${days}/${last14.length} of last 14 days` };
      }
      if (chronic) {
        const days = last30.filter((p) => p.pds > 0.5).length;
        return { tier: 'CHRONIC', reason: `PDS > 0.5 on ${days}/${last30.length} of last 30 days` };
      }
      return { tier: 'NORMAL', reason: 'no persistent deviation' };
    };

    const inverters: Record<
      string,
      {
        group: string;
        classification: { tier: Classification; reason: string };
        series: Point[];
      }
    > = {};
    const ids = inverterFilter ? [inverterFilter] : Array.from(perInverter.keys());
    for (const id of ids) {
      if (!perInverter.has(id)) continue;
      const series = perInverter.get(id)!;
      inverters[id] = {
        group: groupByInverter.get(id) ?? 'unknown',
        classification: classify(series),
        series,
      };
    }

    return NextResponse.json({
      plantId,
      period: { from: fromDate.toISOString(), to: toDate.toISOString(), days },
      count: Object.keys(inverters).length,
      inverters,
    });
  } catch (error) {
    console.error('Failed to fetch inverter rank history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inverter rank history' },
      { status: 500 }
    );
  }
}
