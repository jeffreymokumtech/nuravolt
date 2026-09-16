import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import { requireOrg, requirePlantAccess, resolvePlantForRead } from '@/lib/api/tenant';

// ---------- helpers ----------

/** Determine whether the plantId param is a UUID or a slug */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------- GET /api/plants/[plantId] ----------

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

    const where: Prisma.PlantWhereInput = isUuid(plantId)
      ? { id: plantId }
      : { slug: plantId };

    const plant = await prisma.plant.findFirst({
      where,
      include: {
        inverter_groups: {
          include: {
            inverters: {
              orderBy: { external_id: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
        data_sources: {
          orderBy: { is_primary: 'desc' },
        },
        _count: {
          select: {
            tickets: true,
            bess_assets: true,
          },
        },
      },
    });

    if (!plant) {
      return NextResponse.json(
        { error: 'Plant not found' },
        { status: 404 }
      );
    }

    // Compute summary stats
    const totalInverters = plant.inverter_groups.reduce(
      (sum, group) => sum + group.inverters.length,
      0
    );

    return NextResponse.json({
      data: {
        ...plant,
        inverter_count: totalInverters,
      },
    });
  } catch (error) {
    console.error('Error fetching plant:', error);
    return NextResponse.json(
      { error: 'Failed to fetch plant' },
      { status: 500 }
    );
  }
}

// ---------- PATCH /api/plants/[plantId] ----------

export async function PATCH(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: writes require a session and MANAGE access on the plant.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, plantId, 'MANAGE');
    if (!access.ok) return access.response;

    const body = await request.json();

    // requirePlantAccess already resolved uuid-or-slug to the plant row.
    const resolvedId = access.plant.id;

    // Build update data from allowed fields only
    const allowedFields = [
      'name',
      'asset_type',
      'location_name',
      'latitude',
      'longitude',
      'altitude',
      'timezone',
      'capacity_mw',
      'installed_mw',
      'status',
      'commissioning_date',
      'has_weather_station',
      'irradiance_sensor_type',
      'sensor_mounted_at_tilt',
      'has_dustiq_sensor',
      'currency',
      'metadata',
    ] as const;

    const updateData: Record<string, any> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === 'commissioning_date' && body[field] !== null) {
          updateData[field] = new Date(body[field]);
        } else {
          updateData[field] = body[field];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    const plant = await prisma.plant.update({
      where: { id: resolvedId },
      data: updateData,
      include: {
        inverter_groups: {
          include: { inverters: true },
        },
        data_sources: true,
      },
    });

    return NextResponse.json({
      data: plant,
      message: 'Plant updated successfully',
    });
  } catch (error) {
    console.error('Error updating plant:', error);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: 'Plant not found' },
          { status: 404 }
        );
      }
    }

    return NextResponse.json(
      { error: 'Failed to update plant' },
      { status: 500 }
    );
  }
}
