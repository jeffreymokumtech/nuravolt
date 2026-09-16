import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * GET /api/soiling/inverters/[inverterId]
 *
 * Returns per-inverter soiling intelligence including:
 * - Soiling ratio statistics
 * - Loss disaggregation (IEA PVPS Task 13)
 * - Performance metrics
 * - Fleet comparison (ranking, deviation)
 * - Anomaly detection
 * - Data quality assessment
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { inverterId: string } }
) {
  try {
    const { inverterId } = params;

    // Convert inverterId from URL format (INV_01_001) to file format
    // Inverter IDs in URLs might be like "INV_01_001" but files are "INV_01_001.json"
    const fileName = `${inverterId}.json`;

    // Try to find the inverter data file
    // First, try to determine the plant from the inverterId pattern
    // For now, assume 'alpha1' - in production, this could be a query param or derived
    const plantId = 'alpha1';

    // Tenancy: route serves static fixtures for a fixed plant; org-owned plants
    // need a session + PlantAccess, demo/unaffiliated stay publicly readable.
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:per_inverter_soiling');
      if (gate) return gate;
    }

    const inverterPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'inverters',
      fileName
    );

    // Check if file exists
    try {
      await fs.access(inverterPath);
    } catch {
      return NextResponse.json(
        { error: `Inverter data not found for inverterId: ${inverterId}` },
        { status: 404 }
      );
    }

    // Read inverter data
    const inverterData = await fs.readFile(inverterPath, 'utf-8');
    const inverter = JSON.parse(inverterData);

    // Build response
    const response = {
      inverterId: inverter.inverterId,
      groupId: inverter.groupId,
      soilingRatio: {
        current: inverter.soilingRatio.mean, // Most recent measurement
        mean: inverter.soilingRatio.mean,
        median: inverter.soilingRatio.median,
        std: inverter.soilingRatio.std,
        min: inverter.soilingRatio.min,
        max: inverter.soilingRatio.max,
      },
      lossDisaggregation: {
        method: inverter.lossDisaggregation.method,
        percentages: inverter.lossDisaggregation.percentages,
        energy_kWh: inverter.lossDisaggregation.energy_kWh,
      },
      performance: {
        performanceRatio: inverter.performance.performanceRatio,
        capacityFactor: inverter.performance.capacityFactor,
        availability_pct: inverter.performance.availability_pct,
        avgPowerNormalized: inverter.performance.avgPowerNormalized,
        productionRate: inverter.performance.productionRate,
      },
      fleetComparison: {
        rank: inverter.fleetComparison.rank,
        totalInverters: 150, // Should come from fleet summary
        deviationFromMean_pct: inverter.fleetComparison.deviationFromMean_pct,
        zScore: inverter.fleetComparison.zScore,
        severity: inverter.fleetComparison.severity,
      },
      anomalies: {
        total: inverter.anomalyDetection.totalAnomalies,
        rate_pct: inverter.anomalyDetection.anomalyRate_pct,
        recent: inverter.anomalyDetection.periods
          .sort((a: any, b: any) => new Date(b.start).getTime() - new Date(a.start).getTime())
          .slice(0, 5) // Most recent 5 anomalies
          .map((p: any) => ({
            start: p.start,
            end: p.end,
            duration_hours: p.duration_hours,
            severity: p.severity,
            type: p.type,
            deviation_pct: p.deviation_pct,
          })),
      },
      dataQuality: {
        completeness_pct: inverter.dataQuality.completeness_pct,
        validRecords: inverter.dataQuality.validRecords,
        totalRecords: inverter.dataQuality.totalRecords,
      },
      metadata: {
        analysisStart: inverter.metadata.analysisStart,
        analysisEnd: inverter.metadata.analysisEnd,
        lastUpdated: inverter.metadata.generatedAt,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/inverters/[inverterId]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
