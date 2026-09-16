import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import prisma from '@/libs/prisma';
import type { Prisma } from '@prisma/client';
import { requireOrg, type OrgContext } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Tenancy: Dashboard carries owner_id (user id) and organization_id (Better
 * Auth org id, same id space the legacy clerk_org_id columns use). A dashboard
 * is visible to its org or its owner. In dev, fully-unowned rows (both null,
 * demo data) stay visible so /demo keeps working.
 */
function dashboardScope(ctx: OrgContext): Prisma.DashboardWhereInput {
  const owned: Prisma.DashboardWhereInput[] = [
    { organization_id: ctx.authOrgId },
    { owner_id: ctx.userId },
  ];
  if (process.env.NODE_ENV === 'development') {
    owned.push({ organization_id: null, owner_id: null });
  }
  return { OR: owned };
}

import { slugifyDashboardTitle as slugify } from '@/lib/reports/slug';

// GET /api/dashboards — list
export async function GET() {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const items = await prisma.dashboard.findMany({
      where: dashboardScope(ctx),
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        scope_plant_ids: true,
        default_range: true,
        widgets: true,
        share_token: true,
        created_at: true,
        updated_at: true,
      },
    });
    // Widgets count only (keep list payload small).
    const data = items.map((d) => ({
      ...d,
      widget_count: Array.isArray(d.widgets) ? (d.widgets as unknown[]).length : 0,
      widgets: undefined,
    }));
    return NextResponse.json({ data });
  } catch (error) {
    console.error('Dashboards list failed:', error);
    return NextResponse.json({ error: 'Failed to list dashboards' }, { status: 500 });
  }
}

// POST /api/dashboards — create
export async function POST(req: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const body = await req.json();
    const title: string = body.title?.trim() || 'Untitled Dashboard';

    const created = await prisma.dashboard.create({
      data: {
        slug: slugify(title),
        title,
        description: body.description ?? null,
        // Tenancy anchors: always the session identity, never client-supplied.
        owner_id: ctx.userId,
        organization_id: ctx.authOrgId,
        scope_plant_ids: Array.isArray(body.scope_plant_ids) ? body.scope_plant_ids : [],
        scope_device_ids: Array.isArray(body.scope_device_ids) ? body.scope_device_ids : [],
        default_range: body.default_range ?? 'last_30d',
        default_from: body.default_from ? new Date(body.default_from) : null,
        default_to: body.default_to ? new Date(body.default_to) : null,
        widgets: Array.isArray(body.widgets) ? body.widgets : [],
      },
    });
    recordActivity({
      orgClerkId: orgResult.ctx.authOrgId,
      userId: orgResult.ctx.userId,
      action: 'dashboard.created',
      targetType: 'dashboard',
      targetId: created.id,
      metadata: { title: created.title },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error('Dashboard create failed:', error);
    return NextResponse.json({ error: 'Failed to create dashboard' }, { status: 500 });
  }
}
