import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import prisma from '@/libs/prisma';
import { requireOrg, type OrgContext } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { renderDashboardPdf } from '@/lib/reports/renderDashboardPdf';
import { appBaseUrl } from '@/lib/reports/appBaseUrl';

/**
 * Ownership rule: a dashboard belongs to the caller when its organization_id
 * matches the session org (Better Auth org id) or its owner_id matches the
 * session user. Fully-unowned rows (both null, demo data) are dev-only.
 * Mismatches return 404 (not 403) to avoid existence leaks.
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

// POST /api/dashboards/[id]/export-pdf
// Generates a PDF by rendering the public share URL in headless Chrome.
// If the dashboard isn't already publicly shared, we generate a short-lived
// share_token (expires in 5 minutes) just for this render, then revoke it.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const d = await prisma.dashboard.findFirst({
      where: { OR: [{ id: params.id }, { slug: params.id }] },
    });
    if (!d || !ownsDashboard(d, ctx)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const buf = await renderDashboardPdf(d, appBaseUrl(req));

    recordActivity({
      orgClerkId: ctx.authOrgId,
      userId: ctx.userId,
      action: 'dashboard.exported',
      targetType: 'dashboard',
      targetId: d.id,
      metadata: { title: d.title },
    });

    return new NextResponse(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${d.slug}.pdf"`,
      },
    });
  } catch (error) {
    console.error('Dashboard PDF export failed:', error);
    // The detail is an internal renderer message (browser launch / navigation
    // errors) — org-authed callers only, and essential for diagnosing the
    // serverless Chrome path without log access.
    return NextResponse.json(
      {
        error: 'PDF export failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
