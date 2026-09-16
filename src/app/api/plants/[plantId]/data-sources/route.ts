import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import { requireOrg, requirePlantAccess, resolvePlantForRead } from '@/lib/api/tenant';

// ---------- types ----------

interface CreateDataSourceRequest {
  name: string;
  source_type: string;
  purpose: string;
  connection_id?: string;
  provides_metrics?: string[];
  polling_interval?: number;
  is_primary?: boolean;
  enabled?: boolean;
}

// ---------- GET /api/plants/[plantId]/data-sources ----------

export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(params.plantId);
    if (!readAccess.ok) return readAccess.response;

    const resolvedId = readAccess.plant?.id;
    if (!resolvedId) {
      return NextResponse.json(
        { error: 'Plant not found' },
        { status: 404 }
      );
    }

    const dataSources = await prisma.plantDataSource.findMany({
      where: { plant_id: resolvedId },
      orderBy: [
        { is_primary: 'desc' },
        { name: 'asc' },
      ],
      include: {
        connection: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
          },
        },
      },
    });

    return NextResponse.json({ data: dataSources });
  } catch (error) {
    console.error('Error fetching data sources:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data sources' },
      { status: 500 }
    );
  }
}

// ---------- POST /api/plants/[plantId]/data-sources ----------

export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    // Tenancy: writes require a session and MANAGE access on the plant.
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const access = await requirePlantAccess(orgResult.ctx, params.plantId, 'MANAGE');
    if (!access.ok) return access.response;
    const resolvedId = access.plant.id;

    const body = (await request.json()) as CreateDataSourceRequest;

    // Validate required fields
    if (!body.name || !body.source_type || !body.purpose) {
      return NextResponse.json(
        { error: 'Missing required fields: name, source_type, purpose' },
        { status: 400 }
      );
    }

    // Validate enums
    const validSourceTypes = [
      'SCADA', 'WEATHER_STATION', 'SATELLITE_IRR', 'DUSTIQ',
      'GRID_METER', 'MANUAL_CSV', 'API_WEATHER',
    ];
    if (!validSourceTypes.includes(body.source_type)) {
      return NextResponse.json(
        { error: `Invalid source_type. Must be one of: ${validSourceTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const validPurposes = [
      'INVERTER_DATA', 'WEATHER_DATA', 'IRRADIANCE_DATA',
      'SOILING_MEASUREMENT', 'GRID_METERING', 'SUPPLEMENTARY',
    ];
    if (!validPurposes.includes(body.purpose)) {
      return NextResponse.json(
        { error: `Invalid purpose. Must be one of: ${validPurposes.join(', ')}` },
        { status: 400 }
      );
    }

    // If connection_id provided, verify it exists
    if (body.connection_id) {
      const connection = await prisma.dataConnection.findUnique({
        where: { id: body.connection_id },
        select: { id: true },
      });
      if (!connection) {
        return NextResponse.json(
          { error: 'Referenced connection not found' },
          { status: 400 }
        );
      }
    }

    const dataSource = await prisma.plantDataSource.create({
      data: {
        plant_id: resolvedId,
        connection_id: body.connection_id || null,
        name: body.name,
        source_type: body.source_type as any,
        purpose: body.purpose as any,
        provides_metrics: body.provides_metrics || [],
        polling_interval: body.polling_interval || 900,
        is_primary: body.is_primary ?? false,
        enabled: body.enabled ?? true,
      },
      include: {
        connection: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
          },
        },
      },
    });

    return NextResponse.json(
      {
        data: dataSource,
        message: 'Data source added successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating data source:', error);

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return NextResponse.json(
        { error: 'Referenced plant or connection does not exist' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create data source' },
      { status: 500 }
    );
  }
}
