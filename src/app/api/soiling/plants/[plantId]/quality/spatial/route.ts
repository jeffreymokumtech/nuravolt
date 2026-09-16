import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { SpatialUniformityData } from '@/types/soiling';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';

/**
 * GET /api/soiling/plants/[plantId]/quality/spatial
 *
 * Returns spatial uniformity analysis data including:
 * - Zone-level performance ratio statistics
 * - Coefficient of variation time series
 * - Non-uniformity alerts
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // DB artifact first: real plants get live analysis written by the
    // onboarding/nightly pipeline into AnalysisArtifact (kind
    // 'quality_spatial'); the fixture path below stays as the demo source.
    const plantUuid = readAccess.plant?.id;
    let artifactData: SpatialUniformityData | null = null;
    if (plantUuid) {
      const artifact = await readArtifact<SpatialUniformityData>(plantUuid, 'quality_spatial');
      if (artifact?.payload?.summary) artifactData = artifact.payload;
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
      'spatial_uniformity.json'
    );

    // Check if file exists (skipped when a DB artifact already provided data)
    try {
      if (!artifactData) await fs.access(dataPath);
    } catch {
      // Return empty placeholder if no data
      const placeholder: SpatialUniformityData = {
        metadata: {
          plantId,
          generatedAt: new Date().toISOString(),
          period: { start: '', end: '' },
          zones: [],
          cvThreshold: 0.10,
          measurementInterval: 'daily'
        },
        summary: {
          totalMeasurements: 0,
          uniformMeasurements: 0,
          nonUniformMeasurements: 0,
          uniformityRate: 0,
          avgCV: 0,
          maxCV: 0,
          alertCount: 0
        },
        zoneStatistics: {},
        timeSeries: [],
        alerts: []
      };

      return NextResponse.json(placeholder);
    }

    // Artifact wins; fixture otherwise.
    const data =
      artifactData ??
      (JSON.parse(await fs.readFile(dataPath, 'utf-8')) as SpatialUniformityData);

    // Apply any query parameters
    const url = new URL(request.url);
    const startDate = url.searchParams.get('start');
    const endDate = url.searchParams.get('end');
    const alertsOnly = url.searchParams.get('alertsOnly') === 'true';

    let response = data;

    // Filter by date range if specified
    if (startDate || endDate) {
      const filteredTimeSeries = data.timeSeries.filter(entry => {
        const entryDate = new Date(entry.timestamp);
        if (startDate && entryDate < new Date(startDate)) return false;
        if (endDate && entryDate > new Date(endDate)) return false;
        return true;
      });

      const filteredAlerts = data.alerts.filter(alert => {
        const alertDate = new Date(alert.startTime);
        if (startDate && alertDate < new Date(startDate)) return false;
        if (endDate && alertDate > new Date(endDate)) return false;
        return true;
      });

      response = {
        ...data,
        timeSeries: filteredTimeSeries,
        alerts: filteredAlerts
      };
    }

    // Return alerts only if requested
    if (alertsOnly) {
      return NextResponse.json({
        metadata: response.metadata,
        alertCount: response.alerts.length,
        alerts: response.alerts
      });
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/quality/spatial:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
