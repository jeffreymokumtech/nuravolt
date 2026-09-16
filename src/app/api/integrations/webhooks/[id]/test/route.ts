import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { emitTicketEvent } from '@/lib/integrations/webhooks';

export const runtime = 'nodejs';

// POST /api/integrations/webhooks/[id]/test — send a signed ping to this
// webhook only and return the delivery outcome.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { authOrgId } = orgResult.ctx;
  const gate = await requireFeature(authOrgId, 'integrations:webhooks');
  if (gate) return gate;

  const hook = await prisma.integrationWebhook.findUnique({ where: { id: params.id } });
  if (!hook || hook.org_clerk_id !== authOrgId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await emitTicketEvent(
    authOrgId,
    'ping',
    {
      message: 'Test delivery from NuraVolt. Your endpoint is wired up correctly.',
      webhook_name: hook.name,
    },
    hook.id
  );

  const delivery = await prisma.webhookDelivery.findFirst({
    where: { webhook_id: hook.id, event: 'ping' },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      status: true,
      response_code: true,
      error: true,
      duration_ms: true,
      created_at: true,
    },
  });

  return NextResponse.json({ delivery });
}
