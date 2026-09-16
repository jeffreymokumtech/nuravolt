import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { WindPlantResponse, WindPlantSummary } from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]
 *
 * Returns wind plant summary data.
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

    const summaryPath = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId,
      'summary.json'
    );

    try {
      await fs.access(summaryPath);
    } catch {
      return NextResponse.json(
        { error: `Wind plant data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const summaryData = await fs.readFile(summaryPath, 'utf-8');
    const plant: WindPlantSummary = JSON.parse(summaryData);

    const response: WindPlantResponse = {
      plant,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
