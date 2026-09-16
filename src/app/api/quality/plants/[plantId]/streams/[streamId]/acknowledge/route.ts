import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';

export const runtime = 'nodejs';

interface RouteParams {
  params: {
    plantId: string;
    streamId: string;
  };
}

interface AcknowledgeBody {
  reason?: string;
  expires_at?: string;
  acknowledged_by?: string;
  incident_id?: string;
}

// POST /api/quality/plants/[plantId]/streams/[streamId]/acknowledge
// Create a new data-quality acknowledgement for a stream.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId, streamId } = params;

    let body: AcknowledgeBody = {};
    try {
      const raw = await request.text();
      body = raw ? (JSON.parse(raw) as AcknowledgeBody) : {};
    } catch {
      body = {};
    }

    let expiresAt: Date | null = null;
    if (body.expires_at) {
      const parsed = new Date(body.expires_at);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: 'Invalid expires_at: must be an ISO date string' },
          { status: 400 }
        );
      }
      expiresAt = parsed;
    }

    const created = await prisma.dataQualityAcknowledgement.create({
      data: {
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
        stream_id: streamId,
        acknowledged_by: body.acknowledged_by ?? ctx.userId,
        reason: body.reason ?? null,
        expires_at: expiresAt,
        incident_id: body.incident_id ?? null,
      },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Error creating data-quality acknowledgement:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to create acknowledgement';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/quality/plants/[plantId]/streams/[streamId]/acknowledge
// Revoke the most recent open acknowledgement for this stream.
// "Open" = expires_at IS NULL or expires_at > now(). Sets expires_at = now()
// on the chosen row. No-op when nothing is open.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId, streamId } = params;
    const now = new Date();

    const activeRow = await prisma.dataQualityAcknowledgement.findFirst({
      where: {
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
        stream_id: streamId,
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      },
      orderBy: { acknowledged_at: 'desc' },
    });

    if (!activeRow) {
      return NextResponse.json({ revoked: false, row: null }, { status: 200 });
    }

    const updated = await prisma.dataQualityAcknowledgement.update({
      where: { id: activeRow.id },
      data: { expires_at: now },
    });

    return NextResponse.json({ revoked: true, row: updated }, { status: 200 });
  } catch (error) {
    console.error('Error revoking data-quality acknowledgement:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to revoke acknowledgement';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
