import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type {
  CyclingMetricsResponse,
  CyclingMetricsSummary,
  SoHHistoryPoint,
  CapacityTest,
} from '@/types/bess';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import prisma from '@/libs/prisma';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Aggregate the per-cycle rainflow_data (real ASTM E1049 histogram written by
 * nuravolt/pipeline/bess_intelligence.py) across daily records into a DoD
 * distribution + a real stress-weighted cycle count. Stress weight per cycle ≈
 * (DoD / 0.8) ** 1.3 (the chemistry DoD-stress exponent) — replaces the old
 * fabricated `× 1.1`. `hasRainflow` is false for legacy rows without the field,
 * so callers can fall back to the daily-average bucketing.
 */
function aggregateRainflow(records: Array<{ rainflow_data: unknown }>) {
  const ranges = [
    { dodRange: '0-20%', lo: 0.0, hi: 0.2, count: 0 },
    { dodRange: '20-40%', lo: 0.2, hi: 0.4, count: 0 },
    { dodRange: '40-60%', lo: 0.4, hi: 0.6, count: 0 },
    { dodRange: '60-80%', lo: 0.6, hi: 0.8, count: 0 },
    { dodRange: '80-100%', lo: 0.8, hi: 1.0, count: 0 },
  ];
  let stress = 0;
  for (const r of records) {
    const rf = r.rainflow_data as { buckets?: Array<Record<string, unknown>> } | null;
    if (!rf || !Array.isArray(rf.buckets)) continue;
    for (const b of rf.buckets) {
      const cycles = Number(b.cycles) || 0;
      if (cycles <= 0) continue;
      const mid = (Number(b.dod_min) + Number(b.dod_max)) / 2;
      stress += cycles * Math.pow(Math.max(mid, 0.01) / 0.8, 1.3);
      const tgt = ranges.find((x) => mid >= x.lo && mid < x.hi) ?? ranges[ranges.length - 1];
      tgt.count += cycles;
    }
  }
  const distTotal = ranges.reduce((s, x) => s + x.count, 0);
  return {
    hasRainflow: distTotal > 0,
    stressWeightedCycles: Math.round(stress * 10) / 10,
    dodDistribution: ranges.map((x) => ({
      dodRange: x.dodRange,
      count: Math.round(x.count * 10) / 10,
      percentage: distTotal > 0 ? Math.round((x.count / distTotal) * 100) : 0,
    })),
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/cycling
 *
 * Returns cycling metrics, rainflow analysis, and SoH history.
 * DB-first: plants with BessAsset rows are served from Postgres
 * (BessCycleRecord + BessCapacityTest); the static fixture JSON remains the
 * fallback for demo/showcase slugs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string; assetId: string } }
) {
  try {
    const { plantId, assetId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    // Database branch.
    if (readAccess.plant) {
      const dbAsset =
        (await prisma.bessAsset.findFirst({
          where: {
            plant_id: readAccess.plant.id,
            OR: [{ id: assetId }, { external_asset_id: assetId }],
          },
        })) ??
        (await prisma.bessAsset.findFirst({
          where: { plant_id: readAccess.plant.id },
          orderBy: { created_at: 'asc' },
        }));

      if (dbAsset) {
        const [daily, capacityRows] = await Promise.all([
          prisma.bessCycleRecord.findMany({
            where: { asset_id: dbAsset.id },
            orderBy: { cycle_date: 'asc' },
          }),
          prisma.bessCapacityTest.findMany({
            where: { asset_id: dbAsset.id },
            orderBy: { test_date: 'asc' },
          }),
        ]);

        const latest = daily.length ? daily[daily.length - 1] : null;
        const totalCycles = latest ? Number(latest.cumulative_cycles) : 0;
        const avg = (f: (d: (typeof daily)[number]) => number) =>
          daily.length
            ? daily.reduce((sum, d) => sum + f(d), 0) / daily.length
            : 0;

        // Real rainflow histogram + stress-weighted cycles from the stored
        // rainflow_data (ASTM E1049). Falls back to daily-avg bucketing for
        // legacy rows without the field.
        const rf = aggregateRainflow(daily);

        const metrics: CyclingMetricsSummary = {
          assetId: dbAsset.id,
          period: {
            start: daily.length ? isoDay(daily[0].cycle_date) : '',
            end: latest ? isoDay(latest.cycle_date) : '',
            days: daily.length,
          },
          totals: {
            equivalentFullCycles: totalCycles,
            throughputMwh: latest
              ? Number(latest.cumulative_throughput_kwh) / 1000
              : 0,
            energyChargedMwh:
              daily.reduce((s, d) => s + Number(d.energy_in_kwh), 0) / 1000,
            energyDischargedMwh:
              daily.reduce((s, d) => s + Number(d.energy_out_kwh), 0) / 1000,
          },
          averages: {
            dailyCycles: avg((d) => Number(d.equivalent_cycles)),
            dod: avg((d) => Number(d.avg_dod ?? 0)),
            cRate: avg((d) => Number(d.avg_c_rate ?? 0)),
            temperature: avg((d) => Number(d.avg_temp_c ?? 0)),
            roundTripEfficiency: avg((d) =>
              Number(d.round_trip_efficiency ?? 0)
            ),
          },
          limits: {
            maxDod: daily.length
              ? Math.max(...daily.map((d) => Number(d.avg_dod ?? 0)))
              : 0,
            maxCRate: daily.length
              ? Math.max(...daily.map((d) => Number(d.max_c_rate ?? 0)))
              : 0,
            maxTemp: daily.length
              ? Math.max(...daily.map((d) => Number(d.max_temp_c ?? 0)))
              : 0,
            minTemp: daily.length
              ? Math.min(...daily.map((d) => Number(d.min_temp_c ?? 0)))
              : 0,
          },
          stressMetrics: {
            highSocHoursTotal: daily.reduce(
              (s, d) => s + Number(d.high_soc_hours ?? 0),
              0
            ),
            highTempHoursTotal: daily.reduce(
              (s, d) => s + Number(d.high_temp_hours ?? 0),
              0
            ),
            stressWeightedCycles: rf.hasRainflow ? rf.stressWeightedCycles : totalCycles,
          },
          dailyRecords: daily.map((d) => ({
            date: isoDay(d.cycle_date),
            equivalentCycles: Number(d.equivalent_cycles),
            throughputKwh: Number(d.energy_in_kwh) + Number(d.energy_out_kwh),
            avgDod: Number(d.avg_dod ?? 0),
            avgCRate: Number(d.avg_c_rate ?? 0),
            avgTemp: Number(d.avg_temp_c ?? 0),
            roundTripEfficiency: Number(d.round_trip_efficiency ?? 0),
            stressWeightedCycles: aggregateRainflow([d]).hasRainflow
              ? aggregateRainflow([d]).stressWeightedCycles
              : Number(d.equivalent_cycles),
          })),
        };

        // Real rainflow DoD distribution (falls back to daily-avg bucketing for
        // legacy rows with no rainflow_data).
        let dodDistribution = rf.dodDistribution;
        if (!rf.hasRainflow) {
          const dodBuckets = [
            { range: '0-20%', min: 0, max: 0.2, count: 0 },
            { range: '20-40%', min: 0.2, max: 0.4, count: 0 },
            { range: '40-60%', min: 0.4, max: 0.6, count: 0 },
            { range: '60-80%', min: 0.6, max: 0.8, count: 0 },
            { range: '80-100%', min: 0.8, max: 1.0, count: 0 },
          ];
          for (const d of daily) {
            const dod = Number(d.avg_dod ?? 0);
            const bucket = dodBuckets.find((b) => dod >= b.min && dod < b.max);
            if (bucket) bucket.count += Number(d.equivalent_cycles);
          }
          const totalCyclesForDist = dodBuckets.reduce((sum, b) => sum + b.count, 0);
          dodDistribution = dodBuckets.map((b) => ({
            dodRange: b.range,
            count: Math.round(b.count * 10) / 10,
            percentage: totalCyclesForDist > 0 ? Math.round((b.count / totalCyclesForDist) * 100) : 0,
          }));
        }

        // SoH history: capacity tests plus the asset's current SoH as the
        // latest (estimated) point.
        const sohHistoryPoints: SoHHistoryPoint[] = capacityRows.map((t) => ({
          date: isoDay(t.test_date),
          soh: Number(t.soh_result),
          source: 'capacity_test',
          isCapacityTest: true,
          capacityKwh: Number(t.measured_capacity_kwh),
        }));
        if (dbAsset.current_soh != null) {
          const currentDate = isoDay(dbAsset.last_updated ?? dbAsset.updated_at);
          const lastPoint = sohHistoryPoints[sohHistoryPoints.length - 1];
          if (!lastPoint || lastPoint.date < currentDate) {
            sohHistoryPoints.push({
              date: currentDate,
              soh: Number(dbAsset.current_soh),
              source: 'estimated',
              isCapacityTest: false,
            });
          }
        }

        const capacityTestsTransformed: CapacityTest[] = capacityRows.map(
          (t) => ({
            id: t.id,
            assetId: dbAsset.id,
            testDate: t.test_date.toISOString(),
            measuredCapacityKwh: Number(t.measured_capacity_kwh),
            sohResult: Number(t.soh_result),
            capacityRetention: Number(t.capacity_retention),
            testType: t.test_type as 'standard' | 'partial' | 'estimated',
            ambientTempC: numOrNull(t.ambient_temp_c),
            initialSoc: numOrNull(t.initial_soc),
            testProtocol: t.test_protocol,
            cRateUsed: numOrNull(t.c_rate_used),
            durationHours: numOrNull(t.duration_hours),
            isValid: t.is_valid,
            invalidationReason: t.invalidation_reason,
            notes: t.notes,
          })
        );

        const response: CyclingMetricsResponse & { _source: string } = {
          assetId: dbAsset.id,
          metrics,
          rainflowAnalysis: {
            totalCycles,
            dodDistribution,
            avgCycleDepth: metrics.averages.dod,
            deepCycleRatio:
              dodDistribution
                .filter((d) => d.dodRange === '80-100%')
                .reduce((sum, d) => sum + d.percentage, 0) / 100,
          },
          sohHistory: sohHistoryPoints,
          capacityTests: capacityTestsTransformed,
          metadata: {
            generatedAt: new Date().toISOString(),
            analysisMethod: 'rainflow_counting',
          },
          _source: 'database',
        };
        return NextResponse.json(response);
      }
    }

    const baseSubdir = bessFixtureSubdir(plantId);
    const basePath = path.join(process.cwd(), 'public', 'data', baseSubdir, plantId);

    // Load cycling, SoH history, and capacity test data
    const [cyclingData, sohData, capacityData, assetData] = await Promise.all([
      fs.readFile(path.join(basePath, 'cycling_metrics.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'soh_history.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'capacity_tests.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'asset_info.json'), 'utf-8').catch(() => null),
    ]);

    if (!cyclingData) {
      return NextResponse.json(
        { error: `Cycling data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const cyclingInfo = JSON.parse(cyclingData);
    const sohHistory = sohData ? JSON.parse(sohData) : [];
    const capacityTests = capacityData ? JSON.parse(capacityData) : [];
    const assetInfo = assetData ? JSON.parse(assetData) : { asset_id: 'unknown' };

    const dailyMetrics = cyclingInfo.daily_metrics || [];

    // Build cycling metrics summary
    const metrics: CyclingMetricsSummary = {
      assetId: assetInfo.asset_id,
      period: {
        start: dailyMetrics[0]?.date || '',
        end: dailyMetrics[dailyMetrics.length - 1]?.date || '',
        days: dailyMetrics.length,
      },
      totals: {
        equivalentFullCycles: cyclingInfo.total_cycles,
        throughputMwh: cyclingInfo.total_throughput_mwh,
        energyChargedMwh: cyclingInfo.total_throughput_mwh / 2,
        energyDischargedMwh: cyclingInfo.total_throughput_mwh / 2 * 0.88,
      },
      averages: {
        dailyCycles: dailyMetrics.length > 0
          ? dailyMetrics.reduce((sum: number, d: any) => sum + d.equivalent_cycles, 0) / dailyMetrics.length
          : 0,
        dod: dailyMetrics.length > 0
          ? dailyMetrics.reduce((sum: number, d: any) => sum + d.avg_dod, 0) / dailyMetrics.length
          : 0.6,
        cRate: dailyMetrics.length > 0
          ? dailyMetrics.reduce((sum: number, d: any) => sum + (d.avg_c_rate || 0.3), 0) / dailyMetrics.length
          : 0.3,
        temperature: dailyMetrics.length > 0
          ? dailyMetrics.reduce((sum: number, d: any) => sum + (d.avg_temp_c || 25), 0) / dailyMetrics.length
          : 25,
        roundTripEfficiency: dailyMetrics.length > 0
          ? dailyMetrics.reduce((sum: number, d: any) => sum + (d.round_trip_efficiency || 0.88), 0) / dailyMetrics.length
          : 0.88,
      },
      limits: {
        maxDod: Math.max(...dailyMetrics.map((d: any) => d.avg_dod), 0.6),
        maxCRate: Math.max(...dailyMetrics.map((d: any) => d.max_c_rate || 0.6), 0.6),
        maxTemp: Math.max(...dailyMetrics.map((d: any) => d.max_temp_c || 30), 30),
        minTemp: Math.min(...dailyMetrics.map((d: any) => d.min_temp_c || 20), 20),
      },
      stressMetrics: {
        highSocHoursTotal: dailyMetrics.reduce((sum: number, d: any) => sum + (d.high_soc_hours || 0), 0),
        highTempHoursTotal: dailyMetrics.reduce((sum: number, d: any) => sum + (d.high_temp_hours || 0), 0),
        stressWeightedCycles: cyclingInfo.total_cycles * 1.1,
      },
      dailyRecords: dailyMetrics.map((d: any) => ({
        date: d.date,
        equivalentCycles: d.equivalent_cycles,
        throughputKwh: (d.energy_in_kwh || 0) + (d.energy_out_kwh || 0),
        avgDod: d.avg_dod,
        avgCRate: d.avg_c_rate || 0.3,
        avgTemp: d.avg_temp_c || 25,
        roundTripEfficiency: d.round_trip_efficiency || 0.88,
        stressWeightedCycles: d.equivalent_cycles * 1.1,
      })),
    };

    // Calculate DoD distribution for rainflow analysis
    const dodBuckets = [
      { range: '0-20%', min: 0, max: 0.2, count: 0 },
      { range: '20-40%', min: 0.2, max: 0.4, count: 0 },
      { range: '40-60%', min: 0.4, max: 0.6, count: 0 },
      { range: '60-80%', min: 0.6, max: 0.8, count: 0 },
      { range: '80-100%', min: 0.8, max: 1.0, count: 0 },
    ];

    dailyMetrics.forEach((d: any) => {
      const dod = d.avg_dod;
      const bucket = dodBuckets.find(b => dod >= b.min && dod < b.max);
      if (bucket) bucket.count += d.equivalent_cycles;
    });

    const totalCyclesForDist = dodBuckets.reduce((sum, b) => sum + b.count, 0);
    const dodDistribution = dodBuckets.map(b => ({
      dodRange: b.range,
      count: Math.round(b.count * 10) / 10,
      percentage: totalCyclesForDist > 0 ? Math.round(b.count / totalCyclesForDist * 100) : 0,
    }));

    // Transform SoH history
    const sohHistoryPoints: SoHHistoryPoint[] = sohHistory.map((point: any) => ({
      date: point.date,
      soh: point.soh,
      source: point.source === 'capacity_test' ? 'capacity_test' : 'estimated',
      isCapacityTest: point.source === 'capacity_test',
      capacityKwh: point.source === 'capacity_test' ? point.soh * assetInfo.nominal_capacity_kwh : undefined,
    }));

    // Transform capacity tests
    const capacityTestsTransformed: CapacityTest[] = capacityTests.map((test: any) => ({
      id: test.id,
      assetId: assetInfo.asset_id,
      testDate: test.test_date,
      measuredCapacityKwh: test.measured_capacity_kwh,
      sohResult: test.soh_result,
      capacityRetention: test.capacity_retention,
      testType: test.test_type as 'standard' | 'partial' | 'estimated',
      ambientTempC: test.ambient_temp_c,
      initialSoc: test.initial_soc || null,
      testProtocol: test.test_protocol || null,
      cRateUsed: test.c_rate_used,
      durationHours: test.duration_hours || null,
      isValid: test.is_valid,
      invalidationReason: test.invalidation_reason || null,
      notes: test.notes || null,
    }));

    const response: CyclingMetricsResponse = {
      assetId: assetInfo.asset_id,
      metrics,
      rainflowAnalysis: {
        totalCycles: cyclingInfo.total_cycles,
        dodDistribution,
        avgCycleDepth: metrics.averages.dod,
        deepCycleRatio: dodDistribution.filter(d => d.dodRange === '80-100%').reduce((sum, d) => sum + d.percentage, 0) / 100,
      },
      sohHistory: sohHistoryPoints,
      capacityTests: capacityTestsTransformed,
      metadata: {
        generatedAt: new Date().toISOString(),
        analysisMethod: 'rainflow_counting',
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]/assets/[assetId]/cycling:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
