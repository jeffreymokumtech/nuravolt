import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { webhookUrlProblem, WEBHOOK_EVENT_VALUES } from '@/lib/integrations/webhooks';

export const runtime = 'nodejs';

const VALID_EVENTS = WEBHOOK_EVENT_VALUES;

async function loadOwned(id: string, orgId: string) {
  const hook = await prisma.integrationWebhook.findUnique({ where: { id } });
  if (!hook || hook.org_clerk_id !== orgId) return null;
  return hook;
}

// PATCH /api/integrations/webhooks/[id] — update name/url/events/active.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { authOrgId } = orgResult.ctx;
  const gate = await requireFeature(authOrgId, 'integrations:webhooks');
  if (gate) return gate;

  const hook = await loadOwned(params.id, authOrgId);
  if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { name?: string; url?: string; events?: string[]; active?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim().length >= 2) data.name = body.name.trim();
  if (typeof body.url === 'string') {
    const problem = webhookUrlProblem(body.url.trim());
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    data.url = body.url.trim();
  }
  if (Array.isArray(body.events)) {
    const events = body.events.filter((e) => (VALID_EVENTS as readonly string[]).includes(e));
    if (events.length === 0) {
      return NextResponse.json({ error: 'events must not be empty' }, { status: 400 });
    }
    data.events = events;
  }
  if (typeof body.active === 'boolean') data.active = body.active;

  const updated = await prisma.integrationWebhook.update({
    where: { id: hook.id },
    data,
    select: { id: true, name: true, url: true, events: true, active: true },
  });

  return NextResponse.json({ webhook: updated });
}

// DELETE /api/integrations/webhooks/[id]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { authOrgId } = orgResult.ctx;
  const gate = await requireFeature(authOrgId, 'integrations:webhooks');
  if (gate) return gate;

  const hook = await loadOwned(params.id, authOrgId);
  if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // WebhookDelivery rows cascade with the webhook.
  await prisma.integrationWebhook.delete({ where: { id: hook.id } });
  return NextResponse.json({ ok: true });
}
