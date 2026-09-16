import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, type OrgContext } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Ownership rule: a dashboard belongs to the caller when its organization_id
 * matches the session org (Better Auth org id) or its owner_id matches the
 * session user. Fully-unowned rows (both null, demo data) are dev-only.
 * Mismatches return 404 (not 403) to avoid existence leaks. Public share
 * access stays on /api/dashboards/public/[token].
 */
function ownsDashboard(
  d: { organization_id: string | null; owner_id: string | null },
  ctx: OrgContext,
): boolean {
  if (d.organization_id === ctx.authOrgId || d.owner_id === ctx.userId) return true;
  return (
    process.env.NODE_ENV === 'development' &&
    d.organization_id === null &&
    d.owner_id === null
  );
}

// GET /api/dashboards/[id] — fetch full dashboard (widgets included)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    // Accept either UUID or slug for convenience.
    const d = await prisma.dashboard.findFirst({
      where: { OR: [{ id: params.id }, { slug: params.id }] },
    });
    if (!d || !ownsDashboard(d, ctx)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ data: d });
  } catch (error) {
    console.error('Dashboard get failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// PUT /api/dashboards/[id] — update
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const body = await req.json();
    const existing = await prisma.dashboard.findFirst({
      where: { OR: [{ id: params.id }, { slug: params.id }] },
      select: { id: true, organization_id: true, owner_id: true },
    });
    if (!existing || !ownsDashboard(existing, ctx)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const updated = await prisma.dashboard.update({
      where: { id: existing.id },
      data: {
        // Only overwrite fields the caller provided.
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.scope_plant_ids !== undefined && { scope_plant_ids: body.scope_plant_ids }),
        ...(body.scope_device_ids !== undefined && { scope_device_ids: body.scope_device_ids }),
        ...(body.default_range !== undefined && { default_range: body.default_range }),
        ...(body.default_from !== undefined && {
          default_from: body.default_from ? new Date(body.default_from) : null,
        }),
        ...(body.default_to !== undefined && {
          default_to: body.default_to ? new Date(body.default_to) : null,
        }),
        ...(body.widgets !== undefined && { widgets: body.widgets }),
      },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error('Dashboard update failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// DELETE /api/dashboards/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const existing = await prisma.dashboard.findFirst({
      where: { OR: [{ id: params.id }, { slug: params.id }] },
      select: { id: true, organization_id: true, owner_id: true },
    });
    if (!existing || !ownsDashboard(existing, ctx)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    await prisma.dashboard.delete({ where: { id: existing.id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Dashboard delete failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
