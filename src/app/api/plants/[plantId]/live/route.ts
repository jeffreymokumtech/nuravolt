import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resolvePlantForRead } from '@/lib/api/tenant';

export const dynamic = 'force-dynamic';

/**
 * GET /api/plants/[plantId]/live
 *
 * Latest device readings for the plant (LatestDeviceSnapshot via the plant's
 * data connections): current AC power, today's energy, per-device breakdown,
 * data freshness. Powers the live tile on the plant overview and the fleet
 * home cards.
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

  const sources = await prisma.plantDataSource.findMany({
    where: { plant_id: plant.id, connection_id: { not: null } },
    select: { connection_id: true },
  });
  const connectionIds = sources
    .map((s) => s.connection_id)
    .filter((id): id is string => Boolean(id));

  if (connectionIds.length === 0) {
    return NextResponse.json({
      plant_id: plant.id,
      live: false,
      devices: [],
      total_power_kw: null,
      today_energy_kwh: null,
      latest_ts: null,
    });
  }

  const snapshots = await prisma.latestDeviceSnapshot.findMany({
    where: { connection_id: { in: connectionIds } },
    orderBy: { ts: 'desc' },
  });

  const totalPower = snapshots.reduce((acc, s) => acc + (s.active_power_kw ?? 0), 0);
  const todayEnergy = snapshots.reduce((acc, s) => acc + (s.daily_energy_kwh ?? 0), 0);
  const latestTs = snapshots.length ? snapshots[0].ts : null;
  const staleMinutes = latestTs
    ? Math.round((Date.now() - latestTs.getTime()) / 60000)
    : null;

  return NextResponse.json({
    plant_id: plant.id,
    live: snapshots.length > 0,
    latest_ts: latestTs,
    stale_minutes: staleMinutes,
    total_power_kw: snapshots.length ? Math.round(totalPower * 10) / 10 : null,
    today_energy_kwh: snapshots.length ? Math.round(todayEnergy * 10) / 10 : null,
    devices: snapshots.map((s) => ({
      device_ext_id: s.device_ext_id,
      device_type: s.device_type,
      ts: s.ts,
      active_power_kw: s.active_power_kw,
      daily_energy_kwh: s.daily_energy_kwh,
    })),
  });
}
