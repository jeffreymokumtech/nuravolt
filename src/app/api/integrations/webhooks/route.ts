import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { webhookUrlProblem, WEBHOOK_EVENT_VALUES } from '@/lib/integrations/webhooks';

export const runtime = 'nodejs';

const VALID_EVENTS = WEBHOOK_EVENT_VALUES;

function maskSecret(secret: string): string {
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

// GET /api/integrations/webhooks — list the org's webhooks (masked secrets)
// with their most recent delivery.
export async function GET() {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { authOrgId } = orgResult.ctx;
  const gate = await requireFeature(authOrgId, 'integrations:webhooks');
  if (gate) return gate;

  const hooks = await prisma.integrationWebhook.findMany({
    where: { org_clerk_id: authOrgId },
    orderBy: { created_at: 'desc' },
    include: {
      deliveries: {
        orderBy: { created_at: 'desc' },
        take: 5,
        select: {
          id: true,
          event: true,
          status: true,
          response_code: true,
          error: true,
          duration_ms: true,
          created_at: true,
        },
      },
    },
  });

  return NextResponse.json({
    webhooks: hooks.map((h) => ({
      id: h.id,
      name: h.name,
      url: h.url,
      secret_masked: maskSecret(h.secret),
      events: h.events,
      active: h.active,
      created_at: h.created_at.toISOString(),
      recent_deliveries: h.deliveries,
    })),
  });
}

// POST /api/integrations/webhooks — create a webhook. The signing secret is
// returned ONCE in this response and never again.
export async function POST(request: NextRequest) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { authOrgId, userId } = orgResult.ctx;
  const gate = await requireFeature(authOrgId, 'integrations:webhooks');
  if (gate) return gate;

  let body: { name?: string; url?: string; events?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const url = (body.url ?? '').trim();
  const events = Array.isArray(body.events)
    ? body.events.filter((e): e is (typeof VALID_EVENTS)[number] =>
        (VALID_EVENTS as readonly string[]).includes(e)
      )
    : [];

  if (name.length < 2 || name.length > 60) {
    return NextResponse.json({ error: 'name must be 2-60 characters' }, { status: 400 });
  }
  const urlProblem = webhookUrlProblem(url);
  if (urlProblem) {
    return NextResponse.json({ error: urlProblem }, { status: 400 });
  }
  if (events.length === 0) {
    return NextResponse.json(
      { error: `events must include at least one of: ${VALID_EVENTS.join(', ')}` },
      { status: 400 }
    );
  }

  const count = await prisma.integrationWebhook.count({
    where: { org_clerk_id: authOrgId },
  });
  if (count >= 10) {
    return NextResponse.json({ error: 'Webhook limit reached (10 per organization)' }, { status: 400 });
  }

  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const hook = await prisma.integrationWebhook.create({
    data: {
      org_clerk_id: authOrgId,
      name,
      url,
      secret,
      events,
      created_by: userId,
    },
    select: { id: true, name: true, url: true, events: true, active: true, created_at: true },
  });

  return NextResponse.json(
    {
      webhook: { ...hook, created_at: hook.created_at.toISOString() },
      // Shown once — we only store it for signing, the UI never gets it again.
      secret,
    },
    { status: 201 }
  );
}
