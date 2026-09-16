import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import { requireOrg, requirePlantAccess, resolvePlantForRead } from '@/lib/api/tenant';

// ---------- helpers ----------

function generateGroupSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ---------- types ----------

interface InverterInput {
  external_id: string;
  name?: string;
  model?: string;
  serial_number?: string;
  nominal_power_kw?: number;
  mppt_count?: number;
  strings_per_mppt?: number;
}

interface CreateInverterGroupRequest {
  name: string;
  tilt: number;
  azimuth: number;
  inverter_model?: string;
  inverter_nominal_power_kw?: number;
  mppt_count?: number;
  strings_per_mppt?: number;
  gamma_pdc?: number;
  metadata?: Record<string, any>;
  inverters?: InverterInput[];
}

// ---------- GET /api/plants/[plantId]/inverter-groups ----------

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

    const groups = await prisma.inverterGroup.findMany({
      where: { plant_id: resolvedId },
      orderBy: { name: 'asc' },
      include: {
        inverters: {
          orderBy: { external_id: 'asc' },
        },
        _count: {
          select: { inverters: true },
        },
      },
    });

    return NextResponse.json({ data: groups });
  } catch (error) {
    console.error('Error fetching inverter groups:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inverter groups' },
      { status: 500 }
    );
  }
}

// ---------- POST /api/plants/[plantId]/inverter-groups ----------

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

    const body = (await request.json()) as CreateInverterGroupRequest;

    // Validate required fields
    if (!body.name || body.tilt == null || body.azimuth == null) {
      return NextResponse.json(
        { error: 'Missing required fields: name, tilt, azimuth' },
        { status: 400 }
      );
    }

    // Validate inverters have external_id
    if (body.inverters && body.inverters.length > 0) {
      const missingIds = body.inverters.filter((inv) => !inv.external_id);
      if (missingIds.length > 0) {
        return NextResponse.json(
          { error: 'All inverters must have an external_id' },
          { status: 400 }
        );
      }
    }

    const slug = generateGroupSlug(body.name);

    // Use a transaction to create the group and its inverters atomically
    const group = await prisma.$transaction(async (tx) => {
      const newGroup = await tx.inverterGroup.create({
        data: {
          plant_id: resolvedId,
          name: body.name,
          slug,
          tilt: body.tilt,
          azimuth: body.azimuth,
          inverter_model: body.inverter_model,
          inverter_nominal_power_kw: body.inverter_nominal_power_kw,
          mppt_count: body.mppt_count,
          strings_per_mppt: body.strings_per_mppt,
          gamma_pdc: body.gamma_pdc,
          metadata: body.metadata || undefined,
        },
      });

      // Create inverters if provided
      if (body.inverters && body.inverters.length > 0) {
        await tx.inverter.createMany({
          data: body.inverters.map((inv) => ({
            group_id: newGroup.id,
            external_id: inv.external_id,
            name: inv.name,
            model: inv.model || body.inverter_model,
            serial_number: inv.serial_number,
            nominal_power_kw: inv.nominal_power_kw || body.inverter_nominal_power_kw,
            mppt_count: inv.mppt_count || body.mppt_count,
            strings_per_mppt: inv.strings_per_mppt || body.strings_per_mppt,
            enabled: true,
          })),
        });
      }

      // Return the group with its inverters
      return tx.inverterGroup.findUnique({
        where: { id: newGroup.id },
        include: {
          inverters: {
            orderBy: { external_id: 'asc' },
          },
          _count: {
            select: { inverters: true },
          },
        },
      });
    });

    return NextResponse.json(
      {
        data: group,
        message: 'Inverter group created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating inverter group:', error);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Unique constraint violation on [plant_id, slug]
      if (error.code === 'P2002') {
        return NextResponse.json(
          { error: 'An inverter group with this name already exists for this plant' },
          { status: 409 }
        );
      }
      // Foreign key constraint failure
      if (error.code === 'P2003') {
        return NextResponse.json(
          { error: 'Referenced plant does not exist' },
          { status: 400 }
        );
      }
    }

    return NextResponse.json(
      { error: 'Failed to create inverter group' },
      { status: 500 }
    );
  }
}
