import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { WindFaultsResponse, WindFault, WindFaultCategory, WindFaultSeverity } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * GET /api/wind/plants/[plantId]/faults
 *
 * Returns wind turbine faults with optional filtering.
 * Query params:
 *   - status: ACTIVE | ACKNOWLEDGED | RESOLVED
 *   - severity: CRITICAL | HIGH | MEDIUM | LOW
 *   - category: GEARBOX | GENERATOR | BLADE | YAW | MAIN_BEARING | CONVERTER | PITCH | GRID
 *   - turbineId: specific turbine filter
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

    const statusFilter = searchParams.get('status');
    const severityFilter = searchParams.get('severity') as WindFaultSeverity | null;
    const categoryFilter = searchParams.get('category') as WindFaultCategory | null;
    const turbineIdFilter = searchParams.get('turbineId');

    const faultsPath = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId,
      'faults.json'
    );

    try {
      await fs.access(faultsPath);
    } catch {
      return NextResponse.json(
        { error: `Wind plant data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const faultsData = await fs.readFile(faultsPath, 'utf-8');
    const data = JSON.parse(faultsData);
    let faults: WindFault[] = data.faults || [];

    // Apply filters
    if (statusFilter) {
      faults = faults.filter((f) => f.status === statusFilter);
    }
    if (severityFilter) {
      faults = faults.filter((f) => f.faultType.severity === severityFilter);
    }
    if (categoryFilter) {
      faults = faults.filter((f) => f.faultType.category === categoryFilter);
    }
    if (turbineIdFilter) {
      faults = faults.filter((f) => f.turbineId === turbineIdFilter);
    }

    // Sort by detectedAt descending
    faults.sort((a, b) =>
      new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
    );

    const response: WindFaultsResponse = {
      faults,
      total: faults.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/faults:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
