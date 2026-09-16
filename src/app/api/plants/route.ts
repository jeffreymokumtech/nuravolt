import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma, AssetType, PlantStatus } from '@prisma/client';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireOrg } from '@/lib/api/tenant';
import { createPlantForOrg, type CreatePlantRequest } from '@/lib/plants/create';

// ---------- GET /api/plants ----------

export async function GET(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const isDev = process.env.NODE_ENV === 'development';
    // Org's plants; in dev also unaffiliated (demo) plants so /demo keeps working.
    const orgScope: Prisma.PlantWhereInput = isDev
      ? { OR: [{ organization_id: ctx.org.id }, { organization_id: null }] }
      : { organization_id: ctx.org.id };

    const { searchParams } = new URL(request.url);

    // Pagination
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = Math.min(parseInt(searchParams.get('page_size') || '50', 10), 100);
    const skip = (page - 1) * pageSize;

    // Filters
    const assetType = searchParams.get('asset_type') as AssetType | null;
    const status = searchParams.get('status') as PlantStatus | null;
    const search = searchParams.get('search') || undefined;

    // Build where clause. orgScope and the search filter both use OR, so they
    // are combined under AND to avoid clobbering each other.
    const andClauses: Prisma.PlantWhereInput[] = [orgScope];

    if (search) {
      andClauses.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { location_name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.PlantWhereInput = { AND: andClauses };

    if (assetType) {
      where.asset_type = assetType;
    }

    if (status) {
      where.status = status;
    }

    // Execute queries in parallel
    const [plants, total] = await Promise.all([
      prisma.plant.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [
          { status: 'asc' },
          { name: 'asc' },
        ],
        include: {
          inverter_groups: {
            include: {
              _count: {
                select: { inverters: true },
              },
            },
          },
          data_sources: {
            select: {
              id: true,
              name: true,
              source_type: true,
              purpose: true,
              is_primary: true,
              enabled: true,
            },
          },
          _count: {
            select: {
              inverter_groups: true,
              data_sources: true,
              tickets: true,
            },
          },
        },
      }),
      prisma.plant.count({ where }),
    ]);

    // Shape response with summary stats
    const data = plants.map((plant) => {
      const totalInverters = plant.inverter_groups.reduce(
        (sum, group) => sum + group._count.inverters,
        0
      );

      return {
        id: plant.id,
        slug: plant.slug,
        name: plant.name,
        asset_type: plant.asset_type,
        location_name: plant.location_name,
        latitude: plant.latitude,
        longitude: plant.longitude,
        altitude: plant.altitude,
        timezone: plant.timezone,
        capacity_mw: plant.capacity_mw,
        installed_mw: plant.installed_mw,
        energy_capacity_mwh: plant.energy_capacity_mwh,
        status: plant.status,
        commissioning_date: plant.commissioning_date,
        has_weather_station: plant.has_weather_station,
        irradiance_sensor_type: plant.irradiance_sensor_type,
        sensor_mounted_at_tilt: plant.sensor_mounted_at_tilt,
        has_dustiq_sensor: plant.has_dustiq_sensor,
        currency: plant.currency,
        metadata: plant.metadata,
        created_at: plant.created_at,
        updated_at: plant.updated_at,
        // Summary stats
        inverter_count: totalInverters,
        inverter_group_count: plant._count.inverter_groups,
        data_source_count: plant._count.data_sources,
        ticket_count: plant._count.tickets,
        data_sources: plant.data_sources,
      };
    });

    return NextResponse.json({
      data,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('Error fetching plants:', error);
    return NextResponse.json(
      { error: 'Failed to fetch plants' },
      { status: 500 }
    );
  }
}

// ---------- POST /api/plants ----------

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreatePlantRequest;

    // Validate required fields
    if (!body.name || body.latitude == null || body.longitude == null || body.capacity_mw == null) {
      return NextResponse.json(
        { error: 'Missing required fields: name, latitude, longitude, capacity_mw' },
        { status: 400 }
      );
    }

    // A storage plant is priced and modelled on its energy, not just its power,
    // so the nameplate MWh is required rather than assumed from AC capacity.
    // createPlantForOrg writes it to Plant.energy_capacity_mwh and creates the
    // matching BessAsset in the same transaction.
    const isStorage = body.asset_type === 'BESS' || body.asset_type === 'HYBRID';
    const declaredMwh = Number(body.energy_capacity_mwh ?? body.storage?.energy_capacity_mwh ?? 0);
    if (isStorage && !(declaredMwh > 0)) {
      return NextResponse.json(
        { error: 'Storage plants need an energy capacity in MWh (energy_capacity_mwh).' },
        { status: 400 }
      );
    }

    // The whole creation pipeline (org resolution, plan limits, slug,
    // compliance, transaction, onboarding trigger) lives in the shared
    // service so the DiscoveredPlant promotion path behaves identically.
    const { orgId } = await getChatIds();
    const outcome = await createPlantForOrg(orgId, body);

    if (!outcome.ok) {
      return NextResponse.json(outcome.body, { status: outcome.status });
    }

    return NextResponse.json(
      {
        data: outcome.plant,
        message: 'Plant created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating plant:', error);
    return NextResponse.json(
      { error: 'Failed to create plant' },
      { status: 500 }
    );
  }
}
