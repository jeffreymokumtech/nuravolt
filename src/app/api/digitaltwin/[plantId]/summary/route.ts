import { NextRequest, NextResponse } from 'next/server';
import { queryAnalysisResults, resolvePlantId } from '@/lib/db/timeseries';
import prisma from '@/libs/prisma';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * Distinct + latest twin model versions written for a plant's PLANT-level
 * predicted rows. `modelVersions` (plant-scope, flagship non-physics first)
 * drives the "live · <models>" label; `modelVersion` is the latest within the
 * returned data window. Stale seed rows are excluded.
 */
async function modelVersionsFor(
  plantUuid: string,
  windowFromIso: string,
  windowToIso: string
): Promise<{ modelVersion: string | null; modelVersions: string[] }> {
  try {
    const [all, latest] = await Promise.all([
      prisma.$queryRawUnsafe<{ model_version: string }[]>(
        `SELECT DISTINCT model_version FROM analysis_results
         WHERE plant_id = $1::uuid AND domain = 'digitaltwin' AND device_id = 'PLANT'
           AND metric = 'power_ac_predicted' AND model_version IS NOT NULL
           AND model_version <> 'e2e-seed'`,
        plantUuid
      ),
      prisma.$queryRawUnsafe<{ model_version: string | null }[]>(
        `SELECT model_version FROM analysis_results
         WHERE plant_id = $1::uuid AND domain = 'digitaltwin' AND device_id = 'PLANT'
           AND metric = 'power_ac_predicted' AND model_version IS NOT NULL
           AND time >= $2::timestamptz AND time <= $3::timestamptz
         ORDER BY time DESC LIMIT 1`,
        plantUuid,
        windowFromIso,
        windowToIso
      ),
    ]);
    // Flagship (non-physics) first so the label reads e.g.
    // "hybrid-catboost-v1 + physics-v1".
    const modelVersions = all
      .map((r) => r.model_version)
      .sort((a, b) => (a.startsWith('physics') ? 1 : 0) - (b.startsWith('physics') ? 1 : 0));
    return { modelVersion: latest[0]?.model_version ?? null, modelVersions };
  } catch {
    return { modelVersion: null, modelVersions: [] };
  }
}

/**
 * Zero-fill missing night hours across the hourly grid so a DB-backed plant
 * renders the dip to zero at night exactly like the fixture path (the pipeline
 * only writes daylight rows). Fills 00..23 UTC for each calendar day that
 * already has >= 1 real row; fully-empty days stay stitched (an outage day is
 * not a genuine zero-production day). Daylight outage hours keep their existing
 * predicted-only rows (actual gap) — deliberately more honest than the fixture.
 */
function fillNightHours(series: SeriesRow[]): SeriesRow[] {
  if (series.length === 0) return series;
  const present = new Set(series.map((r) => r.date));
  const daysWithData = new Set(series.map((r) => r.date.slice(0, 10)));
  const windowHasActuals = series.some((r) => r.actual_kw != null);
  const filled: SeriesRow[] = [...series];
  for (const day of daysWithData) {
    for (let h = 0; h < 24; h++) {
      const [y, m, d] = day.split('-').map(Number);
      const key = new Date(Date.UTC(y, m - 1, d, h)).toISOString();
      if (present.has(key)) continue;
      filled.push({
        date: key,
        predicted_kw: 0,
        actual_kw: windowHasActuals ? 0 : null,
        residual_kw: windowHasActuals ? 0 : null,
        loss_pct: null,
        predicted_mwh: 0,
        actual_mwh: windowHasActuals ? 0 : null,
      });
    }
  }
  return filled.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * GET /api/digitaltwin/[plantId]/summary
 *
 * Returns plant-level digital twin predicted vs actual power.
 * Data is pre-aggregated at training time (device_id='PLANT').
 *
 * Query params:
 *  - from=YYYY-MM-DD (default: last 30 days)
 *  - to=YYYY-MM-DD (default: today)
 *  - resolution=hourly|daily|weekly|monthly (default: hourly; windows over
 *    120 days are clamped to daily or coarser to protect the raw path)
 *
 * Falls back to plant_power_history.json (served in the identical response
 * shape as the DB branch, with metadata.data_end so clients can anchor
 * presets to the last day with data), then legacy training summaries.
 */

type SeriesRow = {
  date: string;
  predicted_kw: number | null;
  actual_kw: number | null;
  residual_kw: number | null;
  loss_pct: number | null;
  predicted_mwh: number | null;
  actual_mwh: number | null;
};

/** Roll daily rows up to ISO-week or month buckets: MWh sums, avg kW, loss from energy totals. */
function rollupDaily(series: SeriesRow[], resolution: 'weekly' | 'monthly'): SeriesRow[] {
  const buckets = new Map<string, SeriesRow[]>();
  for (const row of series) {
    const d = new Date(row.date + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) continue;
    let key: string;
    if (resolution === 'monthly') {
      key = row.date.slice(0, 7) + '-01';
    } else {
      const day = (d.getUTCDay() + 6) % 7; // Monday-start week
      const start = new Date(d.getTime() - day * 86400000);
      key = start.toISOString().slice(0, 10);
    }
    const arr = buckets.get(key);
    if (arr) arr.push(row);
    else buckets.set(key, [row]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const measured = rows.filter((r) => r.actual_mwh != null);
      const predMwh = rows.reduce((s, r) => s + (r.predicted_mwh ?? 0), 0);
      const actMwh = measured.reduce((s, r) => s + (r.actual_mwh ?? 0), 0);
      const measPredMwh = measured.reduce((s, r) => s + (r.predicted_mwh ?? 0), 0);
      const avg = (get: (r: SeriesRow) => number | null, src: SeriesRow[]) => {
        const vals = src.map(get).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      return {
        date,
        predicted_kw: avg((r) => r.predicted_kw, rows),
        actual_kw: measured.length ? avg((r) => r.actual_kw, measured) : null,
        residual_kw: measured.length ? avg((r) => r.residual_kw, measured) : null,
        loss_pct: measPredMwh > 0 ? ((measPredMwh - actMwh) / measPredMwh) * 100 : null,
        predicted_mwh: predMwh,
        actual_mwh: measured.length ? actMwh : null,
      };
    });
}
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date();
  const fromDate = searchParams.get('from')
    ? new Date(searchParams.get('from')!)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const requested = searchParams.get('resolution') ?? 'hourly';
  const spanDays = Math.max(1, (toDate.getTime() - fromDate.getTime()) / 86400000);
  // Long windows never hit the raw-hourly path.
  let resolution: 'hourly' | 'daily' | 'weekly' | 'monthly' =
    requested === 'daily' || requested === 'weekly' || requested === 'monthly'
      ? requested
      : 'hourly';
  if (resolution === 'hourly' && spanDays > 120) resolution = 'daily';

  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    const plantUuid = await resolvePlantId(plantId);

    if (plantUuid) {
      // Query pre-aggregated plant-level rows (device_id='PLANT').
      // These are written by the training script — no server-side SUM needed.
      const fetchRows = (from: Date, to: Date) =>
        queryAnalysisResults({
          plantId: plantUuid,
          domain: 'digitaltwin',
          metrics: ['power_ac_predicted', 'power_ac_actual', 'power_ac_residual'],
          deviceId: 'PLANT',
          from,
          to,
          // Weekly/monthly roll up from the daily continuous aggregate.
          resolution: resolution === 'hourly' ? 'raw' : 'daily',
          limit: 50000,
        });

      let rows = await fetchRows(fromDate, toDate);
      if (rows.length === 0) {
        // The requested window may sit entirely past the plant's last data
        // (clients default to wall-clock "now"). Re-anchor the same span to
        // the true data end instead of silently falling through to fixtures.
        const latest = await queryAnalysisResults({
          plantId: plantUuid,
          domain: 'digitaltwin',
          metrics: ['power_ac_predicted'],
          deviceId: 'PLANT',
          resolution: resolution === 'hourly' ? 'raw' : 'daily',
          limit: 1,
        });
        if (latest.length > 0) {
          const endTs = new Date((latest[0] as any).bucket ?? latest[0].time);
          if (endTs < fromDate) {
            rows = await fetchRows(new Date(endTs.getTime() - spanDays * 86400000), endTs);
          }
        }
      }

      if (rows.length > 0) {
        // Bucket rows by timestamp. Track metric *presence* so we can tell a
        // warmup day (twin predicted, no measurement yet) apart from a day of
        // genuine zero production. Predicted-only days get null actuals/loss so
        // the chart gaps and loss statistics ignore them (a missing actual is
        // not a 100% loss).
        // predSamples/actSamples = number of hourly rows behind each daily
        // average (the aggregate's sample_count). Energy integrates avg_kW over
        // exactly those hours; the twin only writes daylight rows, so a flat
        // ×24 would ~2x-overstate daily MWh. Hourly rows carry no sample_count,
        // so each contributes 1 hour.
        const byBucket: Record<
          string,
          { predicted: number; actual: number; residual: number; hasActual: boolean; predSamples: number; actSamples: number }
        > = {};

        for (const row of rows) {
          const ts = (row as any).bucket
            ? new Date((row as any).bucket).toISOString()
            : new Date(row.time).toISOString();
          // For daily and coarser, truncate to date
          const key = resolution === 'hourly' ? ts : ts.split('T')[0];
          if (!byBucket[key]) byBucket[key] = { predicted: 0, actual: 0, residual: 0, hasActual: false, predSamples: 0, actSamples: 0 };

          const value = (row as any).avg_value ?? row.value ?? 0;
          const samples = Number((row as any).sample_count ?? 1) || 1;
          if (row.metric === 'power_ac_predicted') {
            byBucket[key].predicted += value;
            byBucket[key].predSamples = Math.max(byBucket[key].predSamples, samples);
          } else if (row.metric === 'power_ac_actual') {
            byBucket[key].actual += value;
            byBucket[key].hasActual = true;
            byBucket[key].actSamples = Math.max(byBucket[key].actSamples, samples);
          } else if (row.metric === 'power_ac_residual') byBucket[key].residual += value;
        }

        const buckets = Object.entries(byBucket)
          .map(([date, v]) => ({ date, ...v }))
          .sort((a, b) => a.date.localeCompare(b.date));

        let series: SeriesRow[] = buckets.map((v) => ({
          date: v.date,
          predicted_kw: Math.round(v.predicted),
          actual_kw: v.hasActual ? Math.round(v.actual) : null,
          residual_kw: v.hasActual ? Math.round(v.residual) : null,
          loss_pct: v.hasActual && v.predicted > 0 ? ((v.predicted - v.actual) / v.predicted) * 100 : null,
          predicted_mwh: (v.predicted * v.predSamples) / 1000,
          actual_mwh: v.hasActual ? (v.actual * v.actSamples) / 1000 : null,
        }));

        // Energy + loss statistics over *measured* days only, so warmup days
        // with no telemetry don't masquerade as total generation loss.
        const measured = buckets.filter((d) => d.hasActual);
        const total_predicted_kwh = measured.reduce((s, d) => s + d.predicted * d.predSamples, 0);
        const total_actual_kwh = measured.reduce((s, d) => s + d.actual * d.actSamples, 0);

        const dataEnd = series.length ? series[series.length - 1].date.slice(0, 10) : null;
        const dataStart = series.length ? series[0].date.slice(0, 10) : null;
        // Provenance label from the real data window (before night-fill).
        const { modelVersion, modelVersions } = dataStart && dataEnd
          ? await modelVersionsFor(plantUuid, `${dataStart}T00:00:00Z`, `${dataEnd}T23:59:59Z`)
          : { modelVersion: null, modelVersions: [] };
        if (resolution === 'hourly') {
          series = fillNightHours(series);
        } else if (resolution === 'weekly' || resolution === 'monthly') {
          series = rollupDaily(series, resolution);
        }

        return NextResponse.json({
          plantId,
          _source: 'database',
          _resolution: resolution,
          modelVersion,
          modelVersions,
          period: { from: fromDate.toISOString(), to: toDate.toISOString() },
          metadata: { data_start: dataStart, data_end: dataEnd },
          daily: series,
          summary: {
            total_predicted_mwh: total_predicted_kwh / 1000,
            total_actual_mwh: total_actual_kwh / 1000,
            total_loss_mwh: (total_predicted_kwh - total_actual_kwh) / 1000,
            avg_loss_pct:
              total_predicted_kwh > 0
                ? ((total_predicted_kwh - total_actual_kwh) / total_predicted_kwh) * 100
                : 0,
            measured_days: measured.length,
            predicted_only_days: buckets.length - measured.length,
          },
        });
      }
    }

    // Fixture fallback: plant_power_history.json served in the exact
    // DB-branch contract so the client keeps a single code path.
    try {
      const historyPath = path.join(
        process.cwd(),
        `public/data/digitaltwin/${plantId}/plant_power_history.json`
      );
      const history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
      const dataEnd: string = history.metadata?.data_end ?? '';
      const dataStart: string = history.metadata?.data_start ?? '';

      // Anchor the window to the fixture's data end when the request sits
      // past it (fixtures are pinned in time; clients default to now).
      let from = fromDate;
      let to = toDate;
      if (dataEnd && new Date(dataEnd) < fromDate) {
        to = new Date(dataEnd + 'T23:59:59Z');
        from = new Date(to.getTime() - spanDays * 86400000);
      }
      const fromKey = from.toISOString().slice(0, 10);
      const toKey = to.toISOString().slice(0, 10);

      let series: SeriesRow[] = [];
      let effResolution = resolution;
      if (resolution === 'hourly') {
        // Serve the 3-hourly tail when it covers the window; else daily.
        const recent = (history.recent ?? []).filter((r: any) => {
          const day = String(r.timestamp).slice(0, 10);
          return day >= fromKey && day <= toKey;
        });
        series = recent.map((r: any) => ({
          date: r.timestamp,
          predicted_kw: r.predicted_kw ?? null,
          actual_kw: r.actual_kw ?? null,
          residual_kw: r.residual_kw ?? null,
          loss_pct:
            r.predicted_kw > 0 ? ((r.predicted_kw - r.actual_kw) / r.predicted_kw) * 100 : null,
          predicted_mwh: r.predicted_kw != null ? (r.predicted_kw * 3) / 1000 : null,
          actual_mwh: r.actual_kw != null ? (r.actual_kw * 3) / 1000 : null,
        }));
      }
      if (series.length === 0) {
        // Window predates the intraday tail — honest downgrade to daily so
        // clients label the axis correctly.
        if (resolution === 'hourly') effResolution = 'daily';
        series = (history.daily ?? [])
          .filter((r: any) => r.date >= fromKey && r.date <= toKey)
          .map((r: any) => ({
            date: r.date,
            predicted_kw: r.predicted_kw ?? null,
            actual_kw: r.actual_kw ?? null,
            residual_kw: r.residual_kw ?? null,
            loss_pct: r.loss_pct ?? null,
            predicted_mwh: r.predicted_mwh ?? null,
            actual_mwh: r.actual_mwh ?? null,
          }));
      }

      if (series.length > 0) {
        const measured = series.filter((r) => r.actual_mwh != null);
        const totalPred = measured.reduce((s, r) => s + (r.predicted_mwh ?? 0), 0);
        const totalAct = measured.reduce((s, r) => s + (r.actual_mwh ?? 0), 0);
        if (resolution === 'weekly' || resolution === 'monthly') {
          series = rollupDaily(series, resolution);
        }
        return NextResponse.json({
          plantId,
          _source: 'json',
          _resolution: effResolution,
          period: { from: from.toISOString(), to: to.toISOString() },
          metadata: { data_start: dataStart, data_end: dataEnd },
          daily: series,
          summary: {
            total_predicted_mwh: totalPred,
            total_actual_mwh: totalAct,
            total_loss_mwh: totalPred - totalAct,
            avg_loss_pct: totalPred > 0 ? ((totalPred - totalAct) / totalPred) * 100 : 0,
            measured_days: measured.length,
            predicted_only_days: 0,
          },
        });
      }
    } catch {
      // No history fixture — fall through to the legacy summaries.
    }

    // Fallback to static JSON
    const tryFiles = [
      `public/data/digitaltwin/${plantId}/training_summary_v2.json`,
      `public/data/digitaltwin/${plantId}/digital_twins_summary.json`,
    ];

    for (const file of tryFiles) {
      const fullPath = path.join(process.cwd(), file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const data = JSON.parse(content);
        return NextResponse.json({ ...data, _source: 'json' });
      } catch {
        // Try next file
      }
    }

    return NextResponse.json(
      { error: 'No digital twin data available for this plant', plantId },
      { status: 404 }
    );
  } catch (error) {
    console.error('Failed to fetch digital twin summary:', error);
    return NextResponse.json(
      { error: 'Failed to fetch digital twin summary' },
      { status: 500 }
    );
  }
}
