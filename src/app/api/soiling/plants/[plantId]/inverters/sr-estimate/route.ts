import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Per-Inverter Soiling Ratio Estimates API
 *
 * GET /api/soiling/plants/[plantId]/inverters/sr-estimate
 *
 * Query parameters:
 * - date: Specific date (YYYY-MM-DD), defaults to most recent
 * - days: Number of historical days to return (1-30, default: 7)
 * - variant: Model variant ('dustiq' or 'pseudo', default: 'pseudo')
 * - inverter: Filter to specific inverter ID
 *
 * Returns per-inverter SR estimates with confidence scores.
 */

interface InverterSREstimate {
  inverterId: string;
  date: string;
  soilingRatio: number;
  confidence: number;
  deviationFromFleet: number;
  isAnomaly: boolean;
}

interface PerInverterSRResponse {
  metadata: {
    plantId: string;
    modelVariant: string;
    generatedAt: string;
    totalInverters: number;
    dateRange: {
      start: string;
      end: string;
    };
  };
  summary: {
    currentDate: string;
    fleetMeanSR: number;
    fleetStdSR: number;
    anomalyCount: number;
    cleaningRecommended: boolean;
  };
  inverters: Record<string, {
    currentSR: number;
    sr7dAvg: number;
    confidence: number;
    history: Array<{
      date: string;
      sr: number;
      confidence: number;
    }>;
  }>;
}

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
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:per_inverter_soiling');
      if (gate) return gate;
    }

    const { searchParams } = new URL(request.url);

    const dateParam = searchParams.get('date');
    const daysParam = searchParams.get('days');
    const variant = searchParams.get('variant') || 'pseudo';
    const inverterId = searchParams.get('inverter');

    const days = Math.min(30, Math.max(1, daysParam ? parseInt(daysParam, 10) : 7));

    // Load per-inverter SR data
    const srDataPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'per_inverter',
      `${plantId}_per_inverter_sr.json`
    );

    // Check if file exists
    let srData: any;
    try {
      await fs.access(srDataPath);
      const fileContent = await fs.readFile(srDataPath, 'utf-8');
      srData = JSON.parse(fileContent);
    } catch {
      // Try alternative path without plant prefix
      const altPath = path.join(
        process.cwd(),
        'public',
        'data',
        'soiling',
        plantId,
        'per_inverter_sr.json'
      );
      try {
        await fs.access(altPath);
        const fileContent = await fs.readFile(altPath, 'utf-8');
        srData = JSON.parse(fileContent);
      } catch {
        // Not an error: org plants without accumulated per-inverter telemetry
        // simply have no artifact yet. A 200 keeps the dashboard's probe from
        // spraying console 404s while staying explicit about the absence.
        return NextResponse.json({
          available: false,
          reason: `No per-inverter SR artifact for plantId: ${plantId}`,
          message: 'Run scripts/generate_per_inverter_soiling.py (or the backfill) to generate estimates',
        });
      }
    }

    // Validate model variant matches
    if (srData.metadata?.model_variant && srData.metadata.model_variant !== variant) {
      console.warn(
        `Requested variant '${variant}' but loaded '${srData.metadata.model_variant}'`
      );
    }

    // Filter inverters if specific one requested
    let inverters = srData.inverters || {};
    if (inverterId) {
      if (inverters[inverterId]) {
        inverters = { [inverterId]: inverters[inverterId] };
      } else {
        return NextResponse.json(
          { error: `Inverter not found: ${inverterId}` },
          { status: 404 }
        );
      }
    }

    // Calculate fleet statistics
    const inverterList = Object.entries(inverters);
    const currentSRs = inverterList
      .map(([, data]: [string, any]) => data.current_sr)
      .filter((sr: number) => sr != null);

    const fleetMeanSR = currentSRs.length > 0
      ? currentSRs.reduce((a: number, b: number) => a + b, 0) / currentSRs.length
      : 0;

    const fleetStdSR = currentSRs.length > 0
      ? Math.sqrt(
          currentSRs.reduce(
            (sum: number, sr: number) => sum + Math.pow(sr - fleetMeanSR, 2),
            0
          ) / currentSRs.length
        )
      : 0;

    // Count anomalies (more than 2 std from mean)
    const anomalyThreshold = 2 * fleetStdSR;
    const anomalyCount = currentSRs.filter(
      (sr: number) => Math.abs(sr - fleetMeanSR) > anomalyThreshold
    ).length;

    // Cleaning recommendation (if average SR below 0.97)
    const cleaningRecommended = fleetMeanSR < 0.97;

    // Determine date range
    const allHistories = inverterList
      .flatMap(([, data]: [string, any]) => data.history || [])
      .map((h: any) => h.date)
      .sort();

    const mostRecentDate = allHistories.length > 0
      ? allHistories[allHistories.length - 1]
      : dateParam || new Date().toISOString().split('T')[0];

    // Limit history to requested days
    const processedInverters: Record<string, any> = {};
    for (const [invId, data] of Object.entries(inverters) as [string, any][]) {
      const history = (data.history || [])
        .slice(0, days)
        .map((h: any) => ({
          date: h.date,
          sr: h.sr,
          confidence: h.confidence,
        }));

      processedInverters[invId] = {
        currentSR: data.current_sr,
        sr7dAvg: data.sr_7d_avg,
        confidence: data.confidence,
        history,
      };
    }

    // Build response
    const response: PerInverterSRResponse = {
      metadata: {
        plantId,
        modelVariant: srData.metadata?.model_variant || variant,
        generatedAt: srData.metadata?.generated_at || new Date().toISOString(),
        totalInverters: Object.keys(processedInverters).length,
        dateRange: {
          start: allHistories[0] || mostRecentDate,
          end: mostRecentDate,
        },
      },
      summary: {
        currentDate: mostRecentDate,
        fleetMeanSR: parseFloat(fleetMeanSR.toFixed(4)),
        fleetStdSR: parseFloat(fleetStdSR.toFixed(4)),
        anomalyCount,
        cleaningRecommended,
      },
      inverters: processedInverters,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/inverters/sr-estimate:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
