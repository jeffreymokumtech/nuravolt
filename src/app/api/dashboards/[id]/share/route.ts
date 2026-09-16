import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg, type OrgContext } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Ownership rule: a dashboard belongs to the caller when its organization_id
 * matches the session org (Better Auth org id) or its owner_id matches the
 * session user. Fully-unowned rows (both null, demo data) are dev-only.
 * Mismatches return 404 (not 403) to avoid existence leaks. The public
 * consumption of the share link lives at /api/dashboards/public/[token] and
 * stays unauthenticated; only enabling/revoking sharing is owner-gated here.
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

// 22-char URL-safe token, plenty of entropy without pulling in nanoid.
function newShareToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 22; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// POST /api/dashboards/[id]/share  — enable sharing, returns token
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

    const body = await req.json().catch(() => ({}));
    const existing = await prisma.dashboard.findFirst({
      where: { OR: [{ id: params.id }, { slug: params.id }] },
      select: { id: true, share_token: true, organization_id: true, owner_id: true },
    });
    if (!existing || !ownsDashboard(existing, ctx)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Keep existing token if already public, so a stable URL doesn't rotate
    // every time "Share" is clicked. Only rotate on explicit `rotate: true`.
    const token =
      existing.share_token && !body.rotate ? existing.share_token : newShareToken();

    const updated = await prisma.dashboard.update({
      where: { id: existing.id },
      data: {
        share_token: token,
        share_expires_at: body.expires_at ? new Date(body.expires_at) : null,
      },
      select: { share_token: true, share_expires_at: true },
    });
    return NextResponse.json({
      data: {
        share_token: updated.share_token,
        share_expires_at: updated.share_expires_at,
      },
    });
  } catch (error) {
    console.error('Share enable failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// DELETE /api/dashboards/[id]/share — revoke public access
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
    await prisma.dashboard.update({
      where: { id: existing.id },
      data: { share_token: null, share_expires_at: null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Share revoke failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
