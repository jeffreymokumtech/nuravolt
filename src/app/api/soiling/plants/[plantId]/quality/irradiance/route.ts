import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { IrradianceComparisonData } from '@/types/soiling';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';

/**
 * GET /api/soiling/plants/[plantId]/quality/irradiance
 *
 * Returns irradiance quality comparison data including:
 * - On-site vs Open-Meteo comparison metrics
 * - Monthly and hourly breakdowns
 * - Quality alerts
 * - Scatter plot data
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
    // 'quality_irradiance'); the fixture path below stays as the demo source.
    const plantUuid = readAccess.plant?.id;
    let artifactData: IrradianceComparisonData | null = null;
    if (plantUuid) {
      const artifact = await readArtifact<IrradianceComparisonData>(
        plantUuid,
        'quality_irradiance',
      );
      if (artifact?.payload?.overallMetrics) artifactData = artifact.payload;
    }

    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const baseSubdir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    const dataPath = path.join(
      process.cwd(),
      'public',
      'data',
      baseSubdir,
      plantId,
      'quality',
      'irradiance_comparison.json'
    );

    // Check if file exists (skipped when a DB artifact already provided data)
    try {
      if (!artifactData) await fs.access(dataPath);
    } catch {
      // Return empty placeholder if no data
      const placeholder: IrradianceComparisonData = {
        metadata: {
          plantId,
          generatedAt: new Date().toISOString(),
          period: { start: '', end: '' },
          location: { latitude: 0, longitude: 0 },
          onSiteSensorType: 'Unknown',
          openMeteoSource: 'ERA5'
        },
        overallMetrics: {
          correlation: 0,
          rmse: 0,
          mae: 0,
          bias: 0,
          biasPct: 0,
          r_squared: 0,
          sampleCount: 0
        },
        monthlyMetrics: [],
        hourlyMetrics: [],
        alerts: [],
        scatterData: []
      };

      return NextResponse.json(placeholder);
    }

    // Artifact wins; fixture otherwise.
    const data =
      artifactData ??
      (JSON.parse(await fs.readFile(dataPath, 'utf-8')) as IrradianceComparisonData);

    // Apply any query parameters
    const url = new URL(request.url);
    const includeScatter = url.searchParams.get('includeScatter') !== 'false';
    const alertsOnly = url.searchParams.get('alertsOnly') === 'true';

    // Return alerts only if requested
    if (alertsOnly) {
      return NextResponse.json({
        metadata: data.metadata,
        overallMetrics: data.overallMetrics,
        alertCount: data.alerts.length,
        alerts: data.alerts
      });
    }

    // Optionally exclude scatter data to reduce payload
    if (!includeScatter) {
      const { scatterData, ...rest } = data;
      return NextResponse.json(rest);
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/quality/irradiance:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
