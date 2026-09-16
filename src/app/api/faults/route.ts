import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import type { FaultDetectionResponse, ReactiveFault, PredictiveFault } from '@/types/faults';
import { resolvePlantId, queryAnalysisResults } from '@/lib/db/timeseries';
import type { AnalysisRow } from '@/lib/db/timeseries';
import { resolvePlantForRead, requireOrg, requirePlantAccess } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { readArtifact } from '@/lib/analysis/artifacts';

// Plant ID aliases (map old names to current names)
const PLANT_ID_ALIASES: Record<string, string> = {
  'alpha1': 'alpha',
  'alpha1_1': 'alpha',
};

// Static fault data files (real detection results from Python scripts)
// New structure: public/data/faults/{plantId}/fault_detection_results.json
const STATIC_FAULT_FILES: Record<string, string> = {
  'alpha': 'public/data/faults/alpha/fault_detection_results.json',
  'eta': 'public/data/faults/eta/fault_detection_results.json',
  'ribera': 'public/data/faults/ribera/fault_detection_results.json',
  // Showcase plants (anonymised, public-demo surface — see /showcase)
  'helios': 'public/data/showcase/faults/helios/fault_detection_results.json',
  'zephyr': 'public/data/showcase/faults/zephyr/fault_detection_results.json',
};

/**
 * Create empty fault response when no data is available
 * This replaces the demo data fallback with a clear "no data" response
 */
function createEmptyFaultResponse(plantId: string, currency: string, electricityPrice: number): FaultDetectionResponse {
  return {
    reactive_faults: [],
    predictive_faults: [],
    summary: {
      current_loss_kwh: 0,
      projected_loss_kwh: 0,
      current_loss_value: 0,
      projected_loss_value: 0,
      currency,
      reactive_count: 0,
      predictive_count: 0,
      critical_count: 0,
      urgent_count: 0,
    },
  };
}

/**
 * GET /api/faults?plantId=xxx&currency=EUR
 *
 * Get fault detection results for a plant.
 * Returns real detection results only - NO demo/simulated data fallback.
 *
 * If no fault data is found, returns empty results (not fake data).
 * Run fault detection first: python scripts/run_fault_detection.py --plant-id {plantId}
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    let plantId = searchParams.get('plantId');
    const currency = searchParams.get('currency') || 'EUR';
    const electricityPrice = parseFloat(searchParams.get('electricityPrice') || '0.12');

    if (!plantId) {
      return NextResponse.json(
        { error: 'Missing required parameter: plantId' },
        { status: 400 }
      );
    }

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:fault_detection');
      if (gate) return gate;
    }

    // Enhanced fault telemetry (health/RUL/cascade/maintenance) is served
    // DB-first from the synthesized `faults_enhanced` artifact. Returns
    // { enhanced: null } when absent so the dashboard falls back to the live
    // plant-classifications view.
    if (searchParams.get('enhanced')) {
      const plantUuid = readAccess.plant?.id ?? (await resolvePlantId(plantId));
      const art = plantUuid ? await readArtifact(plantUuid, 'faults_enhanced') : null;
      return NextResponse.json({
        enhanced: art?.payload ?? null,
        _source: art ? 'database' : 'none',
      });
    }

    // Resolve plant ID alias
    const resolvedPlantId = PLANT_ID_ALIASES[plantId] || plantId;

    // DB-first: try TimescaleDB, fallback to static JSON
    try {
      const plantUuid = await resolvePlantId(plantId) ?? await resolvePlantId(resolvedPlantId);
      if (plantUuid) {
        const rows = await queryAnalysisResults({
          plantId: plantUuid,
          domain: 'faults',
          limit: 5_000,
        }) as AnalysisRow[];

        if (rows.length > 0) {
          // Reconstruct the FaultDetectionResponse from long-format rows.
          // Each row has metric like 'reactive_fault' or 'predictive_fault'
          // with full fault data stored in row.metadata.
          const reactiveFaults: ReactiveFault[] = [];
          const predictiveFaults: PredictiveFault[] = [];
          let totalCurrentLoss = 0;
          let totalProjectedLoss = 0;
          let criticalCount = 0;
          let urgentCount = 0;

          for (const row of rows) {
            if (row.metric === 'reactive_fault' && row.metadata) {
              const fault = row.metadata as ReactiveFault;
              reactiveFaults.push(fault);
              totalCurrentLoss += fault.energy_loss_kwh ?? 0;
              if (fault.severity === 'critical') criticalCount++;
            } else if (row.metric === 'predictive_fault' && row.metadata) {
              const fault = row.metadata as PredictiveFault;
              predictiveFaults.push(fault);
              totalProjectedLoss += fault.projected_energy_loss_kwh ?? 0;
              if (fault.urgency === 'urgent') urgentCount++;
            }
          }

          const dbResponse: FaultDetectionResponse = {
            plant_id: plantId,
            timestamp: new Date().toISOString(),
            reactive_faults: reactiveFaults,
            predictive_faults: predictiveFaults,
            summary: {
              current_loss_kwh: totalCurrentLoss,
              projected_loss_kwh: totalProjectedLoss,
              current_loss_value: totalCurrentLoss * electricityPrice,
              projected_loss_value: totalProjectedLoss * electricityPrice,
              currency,
              reactive_count: reactiveFaults.length,
              predictive_count: predictiveFaults.length,
              critical_count: criticalCount,
              urgent_count: urgentCount,
            },
          };

          return NextResponse.json(dbResponse, { status: 200 });
        }
      }
    } catch (dbError) {
      console.warn('DB query failed for faults, falling back to JSON:', dbError);
    }

    // Fallback: Try to load from static fault files (real detection results from Python scripts)
    // New structure: public/data/faults/{plantId}/fault_detection_results.json
    const staticFilePath = STATIC_FAULT_FILES[plantId] || STATIC_FAULT_FILES[resolvedPlantId];
    if (staticFilePath) {
      const fullStaticPath = path.join(process.cwd(), staticFilePath);
      if (fs.existsSync(fullStaticPath)) {
        try {
          const staticData = JSON.parse(fs.readFileSync(fullStaticPath, 'utf-8'));
          console.log(`Loaded real fault data from ${staticFilePath}`);
          // Adjust currency if needed
          if (currency !== 'EUR') {
            staticData.summary.currency = currency;
          }
          return NextResponse.json(staticData as FaultDetectionResponse, { status: 200 });
        } catch (err) {
          console.error(`Failed to load static fault file: ${err}`);
        }
      }
    }

    // Also try the subdirectory structure directly for any plant
    const subdirPath = path.join(process.cwd(), 'public/data/faults', plantId, 'fault_detection_results.json');
    if (fs.existsSync(subdirPath)) {
      try {
        const staticData = JSON.parse(fs.readFileSync(subdirPath, 'utf-8'));
        console.log(`Loaded real fault data from ${subdirPath}`);
        if (currency !== 'EUR') {
          staticData.summary.currency = currency;
        }
        return NextResponse.json(staticData as FaultDetectionResponse, { status: 200 });
      } catch (err) {
        console.error(`Failed to load fault file from subdirectory: ${err}`);
      }
    }

    // No real fault data found - return empty response (NOT demo data)
    // This is intentional: we only show real detection results
    console.log(`No fault data found for plant ${plantId}. Run: python scripts/run_fault_detection.py --plant-id ${plantId}`);
    const emptyResponse = createEmptyFaultResponse(plantId, currency, electricityPrice);
    return NextResponse.json(emptyResponse, { status: 200 });

  } catch (error) {
    console.error('Fault detection API error:', error);
    // Return empty data on error (NOT demo data)
    const plantId = request.nextUrl.searchParams.get('plantId') || 'unknown';
    const currency = request.nextUrl.searchParams.get('currency') || 'EUR';
    const electricityPrice = parseFloat(request.nextUrl.searchParams.get('electricityPrice') || '0.12');
    const emptyResponse = createEmptyFaultResponse(plantId, currency, electricityPrice);
    return NextResponse.json(emptyResponse, { status: 200 });
  }
}

/**
 * POST /api/faults
 *
 * Fault detection runs offline. The onboarding/analytics pipeline
 * (nuravolt/pipeline/faults_synth.py) synthesizes the `faults_enhanced`
 * artifact and writes the `analysis_results` domain 'faults' rows; the Node
 * runtime only reads those, and GET serves them. This handler used to spawn a
 * Python interpreter, which cannot exist on serverless, so it is now an honest
 * 501 rather than a guaranteed crash. No client posts here.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'Fault detection runs offline; results are served via GET /api/faults',
      code: 'offline_compute',
    },
    { status: 501 }
  );
}
