import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';

export const runtime = 'nodejs';

/**
 * Recent MCP tool-call audit rows for the current org. Used by the
 * /dashboard/settings/api-keys audit panel.
 */
export async function GET(req: NextRequest) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') ?? 50)));
  const apiKeyId = url.searchParams.get('api_key_id');

  const rows = await prisma.mcpToolCall.findMany({
    where: {
      org_clerk_id: orgId,
      ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      id: true,
      api_key_id: true,
      tool_name: true,
      status: true,
      error_reason: true,
      duration_ms: true,
      idempotency_key: true,
      ticket_id: true,
      cleaning_schedule_id: true,
      created_at: true,
    },
  });

  // Resolve a friendly key name → so the UI can show "Claude Desktop test"
  // instead of a UUID.
  const keyIds = [...new Set(rows.map((r) => r.api_key_id))];
  const keyNames = await prisma.apiKey.findMany({
    where: { id: { in: keyIds }, org_clerk_id: orgId },
    select: { id: true, name: true, key_prefix: true },
  });
  const nameById = new Map(keyNames.map((k) => [k.id, { name: k.name, prefix: k.key_prefix }]));

  return NextResponse.json({
    calls: rows.map((r) => ({
      id: r.id,
      api_key_id: r.api_key_id,
      api_key_name: nameById.get(r.api_key_id)?.name ?? null,
      api_key_prefix: nameById.get(r.api_key_id)?.prefix ?? null,
      tool_name: r.tool_name,
      status: r.status,
      error_reason: r.error_reason,
      duration_ms: r.duration_ms,
      idempotency_key: r.idempotency_key,
      ticket_id: r.ticket_id,
      cleaning_schedule_id: r.cleaning_schedule_id,
      created_at: r.created_at.toISOString(),
    })),
  });
}
