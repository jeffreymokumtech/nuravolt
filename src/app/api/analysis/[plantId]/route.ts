import { NextRequest, NextResponse } from 'next/server';
import {
  queryAnalysisResults,
  resolvePlantId,
  type AnalysisQuery,
} from '@/lib/db/timeseries';
import { resolvePlantForRead } from '@/lib/api/tenant';

// Valid analysis domains
const VALID_DOMAINS = ['soiling', 'digitaltwin', 'fault', 'bess'] as const;
type AnalysisDomain = (typeof VALID_DOMAINS)[number];

// ---------------------------------------------------------------------------
// GET /api/analysis/[plantId]
//
// Query params:
//   domain     - required: "soiling" | "digitaltwin" | "fault" | "bess"
//   metrics    - comma-separated metric names
//   device     - single device ID
//   from       - ISO 8601 start date
//   to         - ISO 8601 end date
//   resolution - "raw" | "daily" (default "daily")
//   limit      - max rows (default 10000, max 100000)
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  try {
    const { plantId: slugOrId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(slugOrId);
    if (!readAccess.ok) return readAccess.response;

    // Resolve the plant slug or UUID to the canonical UUID
    const plantId = await resolvePlantId(slugOrId);
    if (!plantId) {
      return NextResponse.json(
        { error: `Plant not found: ${slugOrId}` },
        { status: 404 },
      );
    }

    const searchParams = request.nextUrl.searchParams;

    // Domain is required
    const domain = searchParams.get('domain') as AnalysisDomain | null;
    if (!domain) {
      return NextResponse.json(
        { error: `Missing required query parameter: domain. Valid values: ${VALID_DOMAINS.join(', ')}` },
        { status: 400 },
      );
    }
    if (!VALID_DOMAINS.includes(domain)) {
      return NextResponse.json(
        { error: `Invalid domain "${domain}". Valid values: ${VALID_DOMAINS.join(', ')}` },
        { status: 400 },
      );
    }

    // Parse optional params
    const metricsParam = searchParams.get('metrics');
    const deviceParam = searchParams.get('device');
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const resolution = (searchParams.get('resolution') || 'daily') as 'raw' | 'daily';
    const limit = Math.min(
      parseInt(searchParams.get('limit') || '10000', 10) || 10_000,
      100_000,
    );

    // Validate resolution
    if (resolution !== 'raw' && resolution !== 'daily') {
      return NextResponse.json(
        { error: 'resolution must be "raw" or "daily"' },
        { status: 400 },
      );
    }

    // Validate date params
    let from: Date | undefined;
    let to: Date | undefined;
    if (fromParam) {
      from = new Date(fromParam);
      if (isNaN(from.getTime())) {
        return NextResponse.json(
          { error: '"from" must be a valid ISO 8601 date' },
          { status: 400 },
        );
      }
    }
    if (toParam) {
      to = new Date(toParam);
      if (isNaN(to.getTime())) {
        return NextResponse.json(
          { error: '"to" must be a valid ISO 8601 date' },
          { status: 400 },
        );
      }
    }

    const query: AnalysisQuery = {
      plantId,
      domain,
      metrics: metricsParam ? metricsParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      deviceId: deviceParam || undefined,
      from,
      to,
      resolution,
      limit,
    };

    const rows = await queryAnalysisResults(query);

    return NextResponse.json({
      plant_id: plantId,
      domain,
      resolution,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error('Analysis query error:', error);
    return NextResponse.json(
      { error: 'Failed to query analysis results' },
      { status: 500 },
    );
  }
}
