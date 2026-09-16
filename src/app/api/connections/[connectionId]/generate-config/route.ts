import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import {
  generatePlantConfig,
  type GeneratorInput,
  type DeepPartial,
  type PlantConfigJSON,
} from '@/lib/services/plant-config-generator';
import { requireOrg, type OrgContext, hasOrgManageRole, forbidden } from '@/lib/api/tenant';

/** Caller owns the connection; demo identity may also see legacy demo rows. */
function ownsConnection(
  ctx: OrgContext,
  connection: { organization_id: string | null; customer_id: string },
): boolean {
  return (
    connection.organization_id === ctx.org.id ||
    (ctx.isDemo && connection.customer_id === 'demo_customer')
  );
}

interface GenerateConfigRequest {
  plant_id: string;
  overrides?: DeepPartial<PlantConfigJSON>;
}

// POST /api/connections/[connectionId]/generate-config - Generate PlantConfig
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;
    const body = await request.json() as GenerateConfigRequest;

    if (!body.plant_id) {
      return NextResponse.json(
        { error: 'plant_id is required' },
        { status: 400 }
      );
    }

    // Get connection and verify org ownership
    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Get plant
    const plant = await prisma.discoveredPlant.findUnique({
      where: {
        connection_id_external_plant_id: {
          connection_id: connectionId,
          external_plant_id: body.plant_id,
        },
      },
    });

    if (!plant) {
      return NextResponse.json(
        { error: `Plant ${body.plant_id} not found for this connection` },
        { status: 404 }
      );
    }

    // Get confirmed field mappings
    const fieldMappings = await prisma.fieldMapping.findMany({
      where: {
        connection_id: connectionId,
        is_confirmed: true,
      },
    });

    if (fieldMappings.length === 0) {
      return NextResponse.json(
        { error: 'No confirmed field mappings found. Please map fields first.' },
        { status: 400 }
      );
    }

    // Get structure analysis for hierarchy info
    const structureAnalysis = await prisma.dataStructureAnalysis.findUnique({
      where: { connection_id: connectionId },
    });

    // Build generator input
    const input: GeneratorInput = {
      connection,
      plant,
      fieldMappings,
      hierarchy: structureAnalysis ? {
        pattern: structureAnalysis.hierarchy_pattern || undefined,
        inverters: (structureAnalysis.detected_inverters as Record<string, string[]> | null)
          ? Object.entries(structureAnalysis.detected_inverters as Record<string, string[]>).flatMap(
              ([group, invs]) => invs.map(inv => ({ id: inv, group_id: group }))
            )
          : undefined,
      } : undefined,
      overrides: body.overrides,
    };

    // Generate config
    const result = generatePlantConfig(input);

    // Store generated config
    const existingConfig = await prisma.generatedPlantConfig.findFirst({
      where: {
        connection_id: connectionId,
        plant_id: body.plant_id,
        is_active: true,
      },
      orderBy: { version: 'desc' },
    });

    const newVersion = existingConfig ? existingConfig.version + 1 : 1;

    // Deactivate previous version
    if (existingConfig) {
      await prisma.generatedPlantConfig.update({
        where: { id: existingConfig.id },
        data: { is_active: false },
      });
    }

    // Create new config record
    const savedConfig = await prisma.generatedPlantConfig.create({
      data: {
        connection_id: connectionId,
        plant_id: body.plant_id,
        config_json: result.config as any,
        config_yaml: result.yaml,
        version: newVersion,
        is_active: true,
        validation_status: result.validation.isValid ? 'valid' : 'invalid',
        validation_errors: result.validation.errors.length > 0 ? result.validation.errors : null,
        validated_at: new Date(),
      },
    });

    // Log audit
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'config_generated',
        user_id: ctx.userId,
        success: result.validation.isValid,
        new_values: {
          plant_id: body.plant_id,
          version: newVersion,
          validation: result.validation,
        },
      },
    });

    return NextResponse.json({
      data: {
        id: savedConfig.id,
        plant_id: body.plant_id,
        version: newVersion,
        config: result.config,
        yaml: result.yaml,
        validation: result.validation,
      },
    });
  } catch (error) {
    console.error('Error generating PlantConfig:', error);
    return NextResponse.json(
      { error: 'Failed to generate PlantConfig' },
      { status: 500 }
    );
  }
}

// GET /api/connections/[connectionId]/generate-config - List generated configs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { connectionId } = await params;
    const { searchParams } = new URL(request.url);
    const plantId = searchParams.get('plant_id');
    const activeOnly = searchParams.get('active_only') !== 'false';

    // Check connection exists and belongs to the caller's org
    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Build query
    const where: any = { connection_id: connectionId };

    if (plantId) {
      where.plant_id = plantId;
    }

    if (activeOnly) {
      where.is_active = true;
    }

    // Get configs
    const configs = await prisma.generatedPlantConfig.findMany({
      where,
      orderBy: [
        { plant_id: 'asc' },
        { version: 'desc' },
      ],
    });

    return NextResponse.json({
      data: configs.map(c => ({
        id: c.id,
        plant_id: c.plant_id,
        version: c.version,
        is_active: c.is_active,
        validation_status: c.validation_status,
        generated_at: c.generated_at,
      })),
    });
  } catch (error) {
    console.error('Error fetching generated configs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch generated configs' },
      { status: 500 }
    );
  }
}
