import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { WindTurbinesResponse, WindTurbine, TurbineHealthSummary } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]/turbines
 *
 * Returns all turbines for a wind plant with optional health data.
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

    const baseDir = path.join(process.cwd(), 'public', 'data', 'wind', plantId);

    // Load turbines
    const turbinesPath = path.join(baseDir, 'turbines.json');
    try {
      await fs.access(turbinesPath);
    } catch {
      return NextResponse.json(
        { error: `Wind plant data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const turbinesData = await fs.readFile(turbinesPath, 'utf-8');
    const turbines: WindTurbine[] = JSON.parse(turbinesData);

    // Load health data
    let healthMap: Record<string, TurbineHealthSummary> = {};
    const healthPath = path.join(baseDir, 'turbine_health.json');
    try {
      const healthData = await fs.readFile(healthPath, 'utf-8');
      const healthArray: TurbineHealthSummary[] = JSON.parse(healthData);
      healthMap = Object.fromEntries(healthArray.map((h) => [h.turbineId, h]));
    } catch {
      // Health data not available
    }

    // Combine turbines with health
    const turbinesWithHealth = turbines.map((turbine) => ({
      ...turbine,
      health: healthMap[turbine.id] || null,
    }));

    const response: WindTurbinesResponse = {
      turbines: turbinesWithHealth,
      count: turbines.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/turbines:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
