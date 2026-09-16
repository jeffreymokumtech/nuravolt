import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { DataFieldType } from '@prisma/client';
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

interface UpdateMappingRequest {
  original_field: string;
  mapped_field: DataFieldType;
  unit?: string;
  scaling_factor?: number;
  offset?: number;
  validation_rules?: { min?: number; max?: number };
  is_confirmed?: boolean;
}

interface BulkUpdateRequest {
  mappings: UpdateMappingRequest[];
  auto_confirm_threshold?: number;  // Auto-confirm mappings above this confidence
}

// GET /api/connections/[connectionId]/mappings - Get all field mappings
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

    // Parse filters
    const confirmedOnly = searchParams.get('confirmed') === 'true';
    const minConfidence = parseFloat(searchParams.get('min_confidence') || '0');

    // Build where clause
    const where: any = { connection_id: connectionId };

    if (confirmedOnly) {
      where.is_confirmed = true;
    }

    if (minConfidence > 0) {
      where.confidence_score = { gte: minConfidence };
    }

    // Get mappings
    const mappings = await prisma.fieldMapping.findMany({
      where,
      orderBy: [
        { is_confirmed: 'desc' },
        { confidence_score: 'desc' },
        { original_field: 'asc' },
      ],
    });

    // Group by confidence level for UI
    const highConfidence = mappings.filter(m => Number(m.confidence_score) >= 0.85);
    const mediumConfidence = mappings.filter(m => Number(m.confidence_score) >= 0.6 && Number(m.confidence_score) < 0.85);
    const lowConfidence = mappings.filter(m => Number(m.confidence_score) < 0.6);

    return NextResponse.json({
      data: {
        mappings: mappings.map(m => ({
          id: m.id,
          original_field: m.original_field,
          mapped_field: m.mapped_field,
          field_path: m.field_path,
          unit: m.unit,
          scaling_factor: Number(m.scaling_factor),
          offset: Number(m.offset),
          validation_rules: m.validation_rules,
          confidence_score: Number(m.confidence_score),
          is_confirmed: m.is_confirmed,
          created_at: m.created_at,
          updated_at: m.updated_at,
        })),
        summary: {
          total: mappings.length,
          confirmed: mappings.filter(m => m.is_confirmed).length,
          high_confidence: highConfidence.length,
          medium_confidence: mediumConfidence.length,
          low_confidence: lowConfidence.length,
          needs_review: mediumConfidence.length + lowConfidence.length,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching field mappings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch field mappings' },
      { status: 500 }
    );
  }
}

// POST /api/connections/[connectionId]/mappings - Create or update mappings
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
    const body = await request.json() as BulkUpdateRequest;

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

    if (!body.mappings || !Array.isArray(body.mappings)) {
      return NextResponse.json(
        { error: 'Request must include mappings array' },
        { status: 400 }
      );
    }

    const results = {
      created: 0,
      updated: 0,
      errors: [] as string[],
    };

    // Process each mapping
    for (const mapping of body.mappings) {
      try {
        // Validate mapped_field is a valid DataFieldType
        const validTypes = [
          'power_ac', 'power_dc', 'reactive_power',
          'voltage_dc', 'voltage_ac_l1', 'voltage_ac_l2', 'voltage_ac_l3',
          'current_dc', 'current_ac_l1', 'current_ac_l2', 'current_ac_l3',
          'irradiance_poa', 'irradiance_ghi', 'irradiance_dni',
          'temp_module', 'temp_ambient', 'temp_inverter',
          'energy_daily', 'energy_total', 'power_loss', 'financial_impact',
          'wind_speed', 'humidity', 'precipitation', 'soiling_ratio',
          'frequency', 'power_factor',
          'status_code', 'alarm_code',
          'plant_id', 'inverter_id', 'string_id', 'timestamp',
          'unmapped',
        ];

        if (!validTypes.includes(mapping.mapped_field)) {
          results.errors.push(`Invalid field type: ${mapping.mapped_field}`);
          continue;
        }

        // Upsert the mapping
        const existingMapping = await prisma.fieldMapping.findUnique({
          where: {
            connection_id_original_field: {
              connection_id: connectionId,
              original_field: mapping.original_field,
            },
          },
        });

        if (existingMapping) {
          await prisma.fieldMapping.update({
            where: { id: existingMapping.id },
            data: {
              mapped_field: mapping.mapped_field as DataFieldType,
              unit: mapping.unit,
              scaling_factor: mapping.scaling_factor ?? 1.0,
              offset: mapping.offset ?? 0.0,
              validation_rules: mapping.validation_rules,
              is_confirmed: mapping.is_confirmed ?? true,  // Manual updates are confirmed
            },
          });
          results.updated++;
        } else {
          await prisma.fieldMapping.create({
            data: {
              connection_id: connectionId,
              original_field: mapping.original_field,
              mapped_field: mapping.mapped_field as DataFieldType,
              unit: mapping.unit,
              scaling_factor: mapping.scaling_factor ?? 1.0,
              offset: mapping.offset ?? 0.0,
              validation_rules: mapping.validation_rules,
              confidence_score: 1.0,  // Manual mappings get 100% confidence
              is_confirmed: mapping.is_confirmed ?? true,
            },
          });
          results.created++;
        }
      } catch (err) {
        results.errors.push(`Error processing ${mapping.original_field}: ${err}`);
      }
    }

    // Auto-confirm high confidence mappings if threshold provided
    if (body.auto_confirm_threshold) {
      await prisma.fieldMapping.updateMany({
        where: {
          connection_id: connectionId,
          confidence_score: { gte: body.auto_confirm_threshold },
          is_confirmed: false,
        },
        data: {
          is_confirmed: true,
        },
      });
    }

    // Log audit event
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'mappings_updated',
        user_id: ctx.userId,
        success: results.errors.length === 0,
        new_values: {
          created: results.created,
          updated: results.updated,
          errors: results.errors.length,
        },
      },
    });

    return NextResponse.json({
      data: results,
      message: `Successfully processed ${results.created + results.updated} mappings`,
    });
  } catch (error) {
    console.error('Error updating field mappings:', error);
    return NextResponse.json(
      { error: 'Failed to update field mappings' },
      { status: 500 }
    );
  }
}

// DELETE /api/connections/[connectionId]/mappings - Delete all mappings
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;
    const { searchParams } = new URL(request.url);
    const fieldId = searchParams.get('field_id');

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

    if (fieldId) {
      // Delete single mapping
      await prisma.fieldMapping.delete({
        where: { id: fieldId },
      });

      return NextResponse.json({
        message: 'Field mapping deleted successfully',
      });
    } else {
      // Delete all mappings for connection
      const result = await prisma.fieldMapping.deleteMany({
        where: { connection_id: connectionId },
      });

      return NextResponse.json({
        message: `Deleted ${result.count} field mappings`,
      });
    }
  } catch (error) {
    console.error('Error deleting field mappings:', error);
    return NextResponse.json(
      { error: 'Failed to delete field mappings' },
      { status: 500 }
    );
  }
}
