import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type {
  LabeledEventsResponse,
  LabeledFaultEvent,
  WindFaultCategory,
  WindFaultSeverity
} from '@/types/wind';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * GET /api/wind/plants/[plantId]/labeled-events
 *
 * Returns labeled fault events from the CARE dataset.
 * These are ground-truth events used for validation and demo purposes.
 *
 * Query params:
 *   - turbineId: Filter by specific turbine
 *   - category: Filter by fault category
 *   - severity: Filter by severity level
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

    const turbineIdFilter = searchParams.get('turbineId');
    const categoryFilter = searchParams.get('category') as WindFaultCategory | null;
    const severityFilter = searchParams.get('severity') as WindFaultSeverity | null;

    const eventsPath = path.join(
      process.cwd(),
      'public',
      'data',
      'wind',
      plantId,
      'labeled_events.json'
    );

    try {
      await fs.access(eventsPath);
    } catch {
      return NextResponse.json(
        { error: `Labeled events data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const eventsData = await fs.readFile(eventsPath, 'utf-8');
    let events: LabeledFaultEvent[] = JSON.parse(eventsData);

    // Apply filters
    if (turbineIdFilter) {
      events = events.filter((e) => e.turbineId === turbineIdFilter);
    }
    if (categoryFilter) {
      events = events.filter((e) => e.faultType.category === categoryFilter);
    }
    if (severityFilter) {
      events = events.filter((e) => e.faultType.severity === severityFilter);
    }

    // Sort by eventStart descending
    events.sort((a, b) =>
      new Date(b.eventStart).getTime() - new Date(a.eventStart).getTime()
    );

    // Calculate category and severity breakdowns
    const byCategory: Record<WindFaultCategory, number> = {
      GEARBOX: 0,
      GENERATOR: 0,
      BLADE: 0,
      YAW: 0,
      MAIN_BEARING: 0,
      CONVERTER: 0,
      PITCH: 0,
      GRID: 0,
    };

    const bySeverity: Record<WindFaultSeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    for (const event of events) {
      if (event.faultType.category in byCategory) {
        byCategory[event.faultType.category]++;
      }
      if (event.faultType.severity in bySeverity) {
        bySeverity[event.faultType.severity]++;
      }
    }

    const response: LabeledEventsResponse = {
      events,
      total: events.length,
      byCategory,
      bySeverity,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/wind/plants/[plantId]/labeled-events:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
