import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { DataSourceCorrelationData } from '@/types/soiling';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { readArtifact } from '@/lib/analysis/artifacts';

/**
 * GET /api/soiling/plants/[plantId]/quality/correlation
 *
 * Returns data source correlation analysis including:
 * - Zone-level correlations with on-site vs Open-Meteo
 * - Conditional analysis (uniform vs non-uniform periods)
 * - Detected patterns
 * - Recommendations
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
    // 'quality_correlation'); the fixture path below stays as the demo source.
    const plantUuid = readAccess.plant?.id;
    let artifactData: DataSourceCorrelationData | null = null;
    if (plantUuid) {
      const artifact = await readArtifact<DataSourceCorrelationData>(
        plantUuid,
        'quality_correlation',
      );
      if (artifact?.payload?.overallAnalysis) artifactData = artifact.payload;
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
      'data_source_correlation.json'
    );

    // Check if file exists (skipped when a DB artifact already provided data)
    try {
      if (!artifactData) await fs.access(dataPath);
    } catch {
      // Return empty placeholder if no data
      const placeholder: DataSourceCorrelationData = {
        metadata: {
          plantId,
          generatedAt: new Date().toISOString(),
          period: { start: '', end: '' },
          cvThreshold: 0.10,
          minSampleSize: 50
        },
        overallAnalysis: {
          uniformPeriods: {
            count: 0,
            zoneCorrelations: []
          },
          nonUniformPeriods: {
            count: 0,
            zoneCorrelations: []
          }
        },
        conditionalAnalysis: [],
        patterns: [],
        recommendations: []
      };

      return NextResponse.json(placeholder);
    }

    // Artifact wins; fixture otherwise.
    const data =
      artifactData ??
      (JSON.parse(await fs.readFile(dataPath, 'utf-8')) as DataSourceCorrelationData);

    // Apply any query parameters
    const url = new URL(request.url);
    const summaryOnly = url.searchParams.get('summaryOnly') === 'true';

    // Return summary only if requested
    if (summaryOnly) {
      return NextResponse.json({
        metadata: data.metadata,
        uniformPeriodCount: data.overallAnalysis.uniformPeriods.count,
        nonUniformPeriodCount: data.overallAnalysis.nonUniformPeriods.count,
        patternCount: data.patterns.length,
        recommendationCount: data.recommendations.length,
        recommendations: data.recommendations
      });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/quality/correlation:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
