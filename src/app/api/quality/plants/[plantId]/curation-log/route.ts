import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';

export const runtime = 'nodejs';

type CurationAction =
  | 'acknowledge'
  | 'exclude_from_kpi'
  | 'satellite_fallback_engaged'
  | 'sensor_swapped'
  | 'incident_opened'
  | 'incident_closed';

interface CurationEntry {
  ts: string;
  actor: string;
  action: CurationAction;
  stream_id: string;
  reason: string;
}

interface CurationLogResponse {
  plant_id: string;
  generated_at: string;
  entries: CurationEntry[];
  coverage?: string;
}

/**
 * GET /api/quality/plants/[plantId]/curation-log
 *
 * Merged, time-sorted operator-action + incident log for the DQ Hub.
 * Pulls from THREE Prisma tables:
 *   - DataQualityAcknowledgement  → action='acknowledge'
 *   - DataStreamExclusion         → action='exclude_from_kpi'
 *   - DataQualityIncident         → action='incident_opened' (+ 'incident_closed' when closed_at in range)
 *
 * Satellite fallback engagements are intentionally NOT sourced here — they are
 * system events from a separate stream and live outside the operator-action log.
 *
 * Query params:
 *   - days  (default 30, max 90) — window size in days back from now
 *   - limit (default 50, max 200) — max number of entries returned
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { ctx } = orgResult;

  const { plantId } = params;
  const generatedAt = new Date().toISOString();

  // Parse + clamp query params
  const { searchParams } = new URL(request.url);
  const daysRaw = parseInt(searchParams.get('days') || '30', 10);
  const limitRaw = parseInt(searchParams.get('limit') || '50', 10);
  const days = Math.min(
    Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1),
    90
  );
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1),
    200
  );

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const baseWhere = {
      org_clerk_id: ctx.authOrgId,
      plant_id: plantId,
    };

    // Pull all three sources in parallel.
    // - Acknowledgements: by acknowledged_at in range
    // - Exclusions:        by starts_at in range (operator action; ends_at is
    //                      not a separate operator action so we don't emit it)
    // - Incidents:         opened_at in range OR closed_at in range
    //                      (we need both because a close can happen in the
    //                      window even if the open was earlier)
    const [acks, exclusions, incidents] = await Promise.all([
      prisma.dataQualityAcknowledgement.findMany({
        where: {
          ...baseWhere,
          acknowledged_at: { gte: since, lte: now },
        },
        orderBy: { acknowledged_at: 'desc' },
        take: limit,
      }),
      prisma.dataStreamExclusion.findMany({
        where: {
          ...baseWhere,
          starts_at: { gte: since, lte: now },
        },
        orderBy: { starts_at: 'desc' },
        take: limit,
      }),
      prisma.dataQualityIncident.findMany({
        where: {
          ...baseWhere,
          OR: [
            { opened_at: { gte: since, lte: now } },
            { closed_at: { gte: since, lte: now } },
          ],
        },
        orderBy: { opened_at: 'desc' },
        take: limit,
      }),
    ]);

    const entries: CurationEntry[] = [];

    for (const ack of acks) {
      entries.push({
        ts: ack.acknowledged_at.toISOString(),
        actor: ack.acknowledged_by,
        action: 'acknowledge',
        stream_id: ack.stream_id,
        reason: ack.reason ?? '',
      });
    }

    for (const ex of exclusions) {
      entries.push({
        ts: ex.starts_at.toISOString(),
        actor: ex.created_by,
        action: 'exclude_from_kpi',
        stream_id: ex.stream_id,
        reason: ex.reason ?? '',
      });
    }

    for (const inc of incidents) {
      // Emit incident_opened only if opened_at is inside the window.
      if (inc.opened_at >= since && inc.opened_at <= now) {
        entries.push({
          ts: inc.opened_at.toISOString(),
          actor: inc.opened_by,
          // Incidents are plant-scoped, not stream-scoped; use empty string.
          stream_id: '',
          action: 'incident_opened',
          reason: inc.summary,
        });
      }

      // Emit incident_closed when the close happened inside the window.
      if (inc.closed_at && inc.closed_at >= since && inc.closed_at <= now) {
        entries.push({
          ts: inc.closed_at.toISOString(),
          actor: 'system',
          stream_id: '',
          action: 'incident_closed',
          reason: inc.summary,
        });
      }
    }

    // Sort merged set by ts desc, then truncate to limit.
    entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const trimmed = entries.slice(0, limit);

    const response: CurationLogResponse = {
      plant_id: plantId,
      generated_at: generatedAt,
      entries: trimmed,
    };

    return NextResponse.json(response);
  } catch (error) {
    // If the DQ persistence tables don't exist yet (migration not applied),
    // degrade gracefully with an empty log + coverage flag — matching the
    // /quality/today "not_yet_enabled" pattern.
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeMissingTable =
      /relation .* does not exist|no such table|P2021|Unknown arg|table .* does not exist/i.test(
        message
      );
    const looksLikeDbUnreachable =
      /Can't reach database|ECONNREFUSED|P1001|P1002|database server at/i.test(
        message
      );

    if (looksLikeMissingTable || looksLikeDbUnreachable) {
      const fallback: CurationLogResponse = {
        plant_id: plantId,
        generated_at: generatedAt,
        entries: [],
        coverage: 'persistence_not_yet_applied',
      };
      return NextResponse.json(fallback);
    }

    console.error(
      'Error in /api/quality/plants/[plantId]/curation-log:',
      error
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
