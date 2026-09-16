import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { PowerCurveResponse, PowerCurveAnalysis } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]/power-curve
 *
 * Returns power curve analysis for fleet or specific turbine.
 * Query params:
 *   - turbineId: optional, specific turbine (default: fleet-level)
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

    const { searchParams } = new URL(request.url);
    const turbineId = searchParams.get('turbineId');

    const baseDir = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId,
      'power_curve'
    );

    // Determine which file to load
    const fileName = turbineId
      ? `power_curve_${turbineId}.json`
      : 'power_curve_fleet.json';
    const curvePath = path.join(baseDir, fileName);

    try {
      await fs.access(curvePath);
    } catch {
      // If specific turbine not found, try fleet
      if (turbineId) {
        const fleetPath = path.join(baseDir, 'power_curve_fleet.json');
        try {
          await fs.access(fleetPath);
          const fleetData = await fs.readFile(fleetPath, 'utf-8');
          const analysis: PowerCurveAnalysis = JSON.parse(fleetData);
          return NextResponse.json({ analysis } as PowerCurveResponse);
        } catch {
          return NextResponse.json(
            { error: `Power curve data not found for plantId: ${plantId}` },
            { status: 404 }
          );
        }
      }
      return NextResponse.json(
        { error: `Power curve data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const curveData = await fs.readFile(curvePath, 'utf-8');
    const analysis: PowerCurveAnalysis = JSON.parse(curveData);

    const response: PowerCurveResponse = {
      analysis,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/power-curve:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
