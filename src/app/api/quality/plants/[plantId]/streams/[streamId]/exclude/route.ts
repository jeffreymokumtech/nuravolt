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

interface ExcludeBody {
  kpi_names?: string[];
  ends_at?: string;
  created_by?: string;
  reason?: string;
  incident_id?: string;
}

// POST /api/quality/plants/[plantId]/streams/[streamId]/exclude
// Create a new data-stream exclusion for a stream.
// kpi_names defaults to [] which means "exclude from ALL KPI rollups".
// ends_at null/omitted = open-ended exclusion.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId, streamId } = params;

    let body: ExcludeBody = {};
    try {
      const raw = await request.text();
      body = raw ? (JSON.parse(raw) as ExcludeBody) : {};
    } catch {
      body = {};
    }

    let endsAt: Date | null = null;
    if (body.ends_at) {
      const parsed = new Date(body.ends_at);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: 'Invalid ends_at: must be an ISO date string' },
          { status: 400 }
        );
      }
      endsAt = parsed;
    }

    if (body.kpi_names !== undefined && !Array.isArray(body.kpi_names)) {
      return NextResponse.json(
        { error: 'Invalid kpi_names: must be an array of strings' },
        { status: 400 }
      );
    }

    const created = await prisma.dataStreamExclusion.create({
      data: {
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
        stream_id: streamId,
        kpi_names: body.kpi_names ?? [],
        ends_at: endsAt,
        created_by: body.created_by ?? ctx.userId,
        reason: body.reason ?? null,
        incident_id: body.incident_id ?? null,
      },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Error creating data-stream exclusion:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to create exclusion';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/quality/plants/[plantId]/streams/[streamId]/exclude
// Close any active (open-ended) exclusion for this (plant, stream) by setting
// ends_at = now() on every row where ends_at IS NULL.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId, streamId } = params;
    const now = new Date();

    const result = await prisma.dataStreamExclusion.updateMany({
      where: {
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
        stream_id: streamId,
        ends_at: null,
      },
      data: { ends_at: now },
    });

    return NextResponse.json({ closed_count: result.count }, { status: 200 });
  } catch (error) {
    console.error('Error closing data-stream exclusion:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to close exclusion';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
