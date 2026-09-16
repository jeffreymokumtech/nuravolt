import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { ConnectionType, ConnectionStatus } from '@prisma/client';
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

interface UpdateConnectionRequest {
  name?: string;
  description?: string;
  config?: Record<string, any>;
  polling_interval?: number;
  enabled?: boolean;
}

// GET /api/connections/[connectionId] - Get connection details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { connectionId } = await params;

    const connection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
      include: {
        field_mappings: {
          orderBy: { confidence_score: 'desc' },
        },
        discovered_plants: {
          orderBy: { name: 'asc' },
        },
        polling_jobs: {
          take: 10,
          orderBy: { started_at: 'desc' },
        },
        structure_analysis: true,
        generated_configs: {
          where: { is_active: true },
        },
        _count: {
          select: {
            field_mappings: true,
            discovered_plants: true,
            polling_jobs: true,
            audit_logs: true,
          },
        },
      },
    });

    if (!connection || !ownsConnection(ctx, connection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Sanitize sensitive config data. PollingJob.bytes_processed is a BigInt
    // (JSON.stringify throws on it — surfaced by the first successful poll).
    const sanitizedConnection = {
      ...connection,
      config: sanitizeConfig(connection.config as Record<string, any>),
      polling_jobs: connection.polling_jobs.map(job => ({
        ...job,
        bytes_processed: job.bytes_processed == null ? null : Number(job.bytes_processed),
      })),
    };

    return NextResponse.json({ data: sanitizedConnection });
  } catch (error) {
    console.error('Error fetching connection:', error);
    return NextResponse.json(
      { error: 'Failed to fetch connection' },
      { status: 500 }
    );
  }
}

// PATCH /api/connections/[connectionId] - Update connection
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

    const { connectionId } = await params;
    const body = await request.json() as UpdateConnectionRequest;

    // Check connection exists and belongs to the caller's org
    const existingConnection = await prisma.dataConnection.findUnique({
      where: {
        id: connectionId,
      },
    });

    if (!existingConnection || !ownsConnection(ctx, existingConnection)) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    // Build update data
    const updateData: any = {};
    const oldValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};

    if (body.name !== undefined) {
      oldValues.name = existingConnection.name;
      newValues.name = body.name;
      updateData.name = body.name;
    }

    if (body.description !== undefined) {
      oldValues.description = existingConnection.description;
      newValues.description = body.description;
      updateData.description = body.description;
    }

    if (body.config !== undefined) {
      // Merge config (don't replace entirely to preserve sensitive fields)
      const existingConfig = existingConnection.config as Record<string, any> || {};
      updateData.config = { ...existingConfig, ...body.config };
      newValues.config = 'updated';
    }

    if (body.polling_interval !== undefined) {
      oldValues.polling_interval = existingConnection.polling_interval;
      newValues.polling_interval = body.polling_interval;
      updateData.polling_interval = body.polling_interval;
    }

    if (body.enabled !== undefined) {
      oldValues.enabled = existingConnection.enabled;
      newValues.enabled = body.enabled;
      updateData.enabled = body.enabled;

      // Update status if disabling
      if (!body.enabled) {
        updateData.status = 'disabled';
      } else if (existingConnection.status === 'disabled') {
        updateData.status = 'pending';
      }
    }

    // Update connection
    const updatedConnection = await prisma.dataConnection.update({
      where: { id: connectionId },
      data: updateData,
    });

    // Log audit event
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'updated',
        user_id: ctx.userId,
        success: true,
        old_values: oldValues,
        new_values: newValues,
      },
    });

    return NextResponse.json({
      data: {
        ...updatedConnection,
        config: sanitizeConfig(updatedConnection.config as Record<string, any>),
      },
      message: 'Connection updated successfully',
    });
  } catch (error) {
    console.error('Error updating connection:', error);
    return NextResponse.json(
      { error: 'Failed to update connection' },
      { status: 500 }
    );
  }
}

// DELETE /api/connections/[connectionId] - Delete connection
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

    // Log audit event before deletion
    await prisma.connectionAudit.create({
      data: {
        connection_id: connectionId,
        action: 'deleted',
        user_id: ctx.userId,
        success: true,
        old_values: {
          name: connection.name,
          type: connection.type,
        },
      },
    });

    // Delete connection (cascade will delete related records)
    await prisma.dataConnection.delete({
      where: { id: connectionId },
    });

    return NextResponse.json({
      message: 'Connection deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting connection:', error);
    return NextResponse.json(
      { error: 'Failed to delete connection' },
      { status: 500 }
    );
  }
}

// Helper: Remove sensitive data from config
function sanitizeConfig(config: Record<string, any>): Record<string, any> {
  if (!config) return {};

  const sensitiveKeys = ['password', 'token', 'secret', 'api_key', 'apiKey', 'credentials'];
  const sanitized = { ...config };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '********';
    }
  }

  return sanitized;
}
