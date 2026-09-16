import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

export const dynamic = 'force-dynamic';

type StepState = 'done' | 'active' | 'pending' | 'failed';

/**
 * GET /api/plants/[plantId]/onboarding-status
 *
 * Four-step tracker for the post-wizard "what happens next" surface:
 *  1. connection  — a data connection is linked and enabled
 *  2. first_data  — device readings have landed (LatestDeviceSnapshot)
 *  3. coldstart   — the onboarding analytics job produced provisional results
 *  4. trained     — plant-specific models are live (plant left TRAINING)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  const readAccess = await resolvePlantForRead(params.plantId);
  if (!readAccess.ok) return readAccess.response;
  const plant = readAccess.plant;
  if (!plant) {
    return NextResponse.json({ error: 'plant_not_found' }, { status: 404 });
  }

  const dataSources = await prisma.plantDataSource.findMany({
    where: { plant_id: plant.id },
    select: { connection_id: true, enabled: true },
  });
  const connectionIds = dataSources
    .map((ds) => ds.connection_id)
    .filter((id): id is string => Boolean(id));

  const [snapshot, latestJob] = await Promise.all([
    connectionIds.length
      ? prisma.latestDeviceSnapshot.findFirst({
          where: { connection_id: { in: connectionIds } },
          orderBy: { ts: 'desc' },
          select: { ts: true },
        })
      : Promise.resolve(null),
    prisma.analyticsJob.findFirst({
      where: { plant_id: plant.id },
      orderBy: { started_at: 'desc' },
    }),
  ]);

  const hasConnection = connectionIds.length > 0;
  const hasData = Boolean(snapshot);
  const coldstartDone =
    latestJob?.status === 'succeeded' ||
    plant.status === 'OPERATIONAL' ||
    plant.status === 'TRAINING';
  const trained = plant.status === 'OPERATIONAL';

  const step = (done: boolean, prevDone: boolean, failed = false): StepState =>
    failed ? 'failed' : done ? 'done' : prevDone ? 'active' : 'pending';

  return NextResponse.json({
    plant: { id: plant.id, slug: plant.slug, name: plant.name, status: plant.status },
    steps: [
      {
        key: 'connection',
        label: 'Data connection linked',
        state: step(hasConnection, true),
        hint: hasConnection
          ? `${connectionIds.length} connection${connectionIds.length === 1 ? '' : 's'} linked`
          : 'Connect a data source in the wizard',
      },
      {
        key: 'first_data',
        label: 'First data received',
        state: step(hasData, hasConnection),
        hint: hasData
          ? `Latest reading ${snapshot!.ts.toISOString()}`
          : 'Cloud sources are polled every 15 minutes',
      },
      {
        key: 'coldstart',
        label: 'Provisional analytics ready',
        state: step(coldstartDone, hasData, latestJob?.status === 'failed'),
        hint:
          latestJob?.status === 'failed'
            ? `Analytics job failed: ${latestJob.error ?? 'unknown error'}`
            : coldstartDone
              ? 'Digital twin and soiling estimates are live (provisional)'
              : 'First estimates appear within about a day of data arriving',
      },
      {
        key: 'trained',
        label: 'Plant-specific models trained',
        state: step(trained, coldstartDone),
        hint: trained
          ? 'Models are trained on your plant data'
          : 'Trains automatically after a few weeks of your own data',
      },
    ],
    latest_job: latestJob
      ? {
          id: latestJob.id,
          type: latestJob.job_type,
          status: latestJob.status,
          started_at: latestJob.started_at,
          finished_at: latestJob.finished_at,
          error: latestJob.error,
        }
      : null,
  });
}
