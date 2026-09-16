import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { PollingService } from '@/lib/services/polling-service';

/**
 * POST|GET /api/cron/poll-connections
 *
 * Scheduler for cloud vendor connectors (Huawei FusionSolar + SolarEdge +
 * Sungrow iSolarCloud + the synthetic sample_api harness today; Solarman joins
 * CLOUD_CONNECTOR_TYPES later). Triggered every 15 min by
 * .github/workflows/poll-connections.yml.
 *
 * For every enabled + connected connection of a cloud type that is due per its
 * polling_interval, runs one poll (realtime KPIs → bronze/live Parquet in the
 * lake + LatestDeviceSnapshot upserts + PollingJob log row).
 *
 * Auth: Bearer CRON_SECRET in production (same convention as
 * /api/cron/send-reports).
 *
 * Query params:
 *   ?dry_run=1 — list due connections without polling them
 */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Connection types this cron is responsible for.
 *
 * NOTE: 'sungrow_api' is listed here so a Sungrow connection is scheduled the
 * moment PollingService learns to poll it. PollingService.pollByType() has no
 * sungrow_api case yet, so until that lands a Sungrow connection reports one
 * failed job per run rather than being silently skipped forever. No Sungrow
 * connection can exist yet either (the create route's allow-list omits the
 * type), so this is inert today.
 */
const CLOUD_CONNECTOR_TYPES = [
  'huawei_api',
  'solaredge_api',
  'sungrow_api',
  'sample_api',
] as const;

async function handle(request: NextRequest): Promise<NextResponse> {
  // Auth check: verify CRON_SECRET in production
  if (process.env.NODE_ENV === 'production') {
    const authHeader = request.headers.get('authorization');
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dry_run') === '1' || searchParams.get('dry_run') === 'true';

  const now = Date.now();

  try {
    const connections = await prisma.dataConnection.findMany({
      where: {
        enabled: true,
        status: 'connected',
        type: { in: [...CLOUD_CONNECTOR_TYPES] },
      },
      include: {
        field_mappings: { where: { is_confirmed: true } },
      },
    });

    const due = connections.filter(connection => {
      if (!connection.last_poll_time) return true;
      const intervalMs = (connection.polling_interval || 900) * 1000;
      return now - connection.last_poll_time.getTime() >= intervalMs;
    });

    const results: Array<Record<string, any>> = [];

    if (dryRun) {
      for (const connection of due) {
        results.push({
          connection_id: connection.id,
          name: connection.name,
          type: connection.type,
          due: true,
          dry_run: true,
          last_poll_time: connection.last_poll_time?.toISOString() ?? null,
          polling_interval_s: connection.polling_interval,
        });
      }
      return NextResponse.json({
        ok: true,
        dry_run: true,
        checked: connections.length,
        due: due.length,
        results,
      });
    }

    const pollingService = new PollingService();
    let failures = 0;

    try {
      // Sequential on purpose: cloud vendor APIs (FusionSolar especially)
      // rate-limit aggressively; parallel polling multiplies the risk.
      for (const connection of due) {
        try {
          const job = await pollingService.pollConnection(connection);
          if (job.status === 'failed') failures += 1;
          results.push({
            connection_id: connection.id,
            name: connection.name,
            type: connection.type,
            job_id: job.id,
            status: job.status,
            records_fetched: job.recordsFetched ?? 0,
            records_processed: job.recordsProcessed ?? 0,
            error: job.errorMessage ?? null,
          });
        } catch (error) {
          failures += 1;
          results.push({
            connection_id: connection.id,
            name: connection.name,
            type: connection.type,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } finally {
      // Releases the legacy S3 buffer flush interval so the function can exit.
      await pollingService.cleanup().catch((): void => undefined);
    }

    return NextResponse.json({
      ok: failures === 0,
      checked: connections.length,
      due: due.length,
      polled: results.length,
      failures,
      results,
    });
  } catch (error) {
    console.error('[cron/poll-connections] failed:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
