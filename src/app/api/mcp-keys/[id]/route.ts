import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { requireKeyManageRole } from '@/lib/mcp/key-authz';

export const runtime = 'nodejs';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const roleGate = await requireKeyManageRole(userId, orgId);
  if (roleGate) return roleGate;

  const row = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!row || row.org_clerk_id !== orgId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (row.revoked_at) {
    return NextResponse.json({ ok: true, already_revoked: true });
  }

  await prisma.apiKey.update({
    where: { id: row.id },
    data: { revoked_at: new Date() },
  });
  return NextResponse.json({ ok: true });
}
