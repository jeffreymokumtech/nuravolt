import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { WindRULResponse, WindComponentRUL, WindComponent } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * GET /api/wind/plants/[plantId]/rul
 *
 * Returns RUL predictions for wind turbine components.
 * Query params:
 *   - turbineId: filter by specific turbine
 *   - component: filter by component type
 *   - urgent: if "true", only return urgent predictions (<30 days)
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
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:fault_detection');
      if (gate) return gate;
    }

    const { searchParams } = new URL(request.url);

    const turbineIdFilter = searchParams.get('turbineId');
    const componentFilter = searchParams.get('component') as WindComponent | null;
    const urgentOnly = searchParams.get('urgent') === 'true';

    const rulPath = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId,
      'rul.json'
    );

    try {
      await fs.access(rulPath);
    } catch {
      return NextResponse.json(
        { error: `Wind plant data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const rulData = await fs.readFile(rulPath, 'utf-8');
    const data = JSON.parse(rulData);
    let predictions: WindComponentRUL[] = data.predictions || [];

    // Apply filters
    if (turbineIdFilter) {
      predictions = predictions.filter((p) => p.turbineId === turbineIdFilter);
    }
    if (componentFilter) {
      predictions = predictions.filter((p) => p.component === componentFilter);
    }
    if (urgentOnly) {
      predictions = predictions.filter((p) => p.isUrgent);
    }

    // Sort by RUL ascending (most critical first)
    predictions.sort((a, b) => a.estimatedRUL - b.estimatedRUL);

    // Count critical predictions (< 90 days)
    const criticalCount = predictions.filter((p) => p.estimatedRUL < 90).length;

    const response: WindRULResponse = {
      predictions,
      criticalCount,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/rul:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
