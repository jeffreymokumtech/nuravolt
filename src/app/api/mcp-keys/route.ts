import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { getChatIds } from '@/lib/ai/chat-auth';
import { getOrgPlan, hasFeature } from '@/lib/billing/plan';
import { mintKey } from '@/lib/mcp/keys';
import { ALL_SCOPES, isValidScope, type Scope } from '@/lib/mcp/scopes';
import { requireKeyManageRole } from '@/lib/mcp/key-authz';

export const runtime = 'nodejs';

export async function GET() {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const rows = await prisma.apiKey.findMany({
    where: { org_clerk_id: orgId },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      key_prefix: true,
      name: true,
      scopes: true,
      created_by: true,
      last_used_at: true,
      expires_at: true,
      revoked_at: true,
      created_at: true,
    },
  });
  return NextResponse.json({
    keys: rows.map((r) => ({
      id: r.id,
      prefix: r.key_prefix,
      name: r.name,
      scopes: r.scopes,
      created_by: r.created_by,
      last_used_at: r.last_used_at?.toISOString() ?? null,
      expires_at: r.expires_at?.toISOString() ?? null,
      revoked_at: r.revoked_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const { userId, orgId } = await getChatIds();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const roleGate = await requireKeyManageRole(userId, orgId);
  if (roleGate) return roleGate;
  const plan = await getOrgPlan(orgId);
  if (!hasFeature(plan, 'mcp:api_keys')) {
    return NextResponse.json(
      {
        error: 'plan_upgrade_required',
        detail: 'MCP API keys are available on Business and Enterprise plans.',
        upgrade_url: '/pricing',
      },
      { status: 402 },
    );
  }
  let body: { name?: unknown; scopes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) {
    return NextResponse.json(
      { error: 'invalid_name', detail: 'Name must be 1-80 characters.' },
      { status: 400 },
    );
  }
  const scopes = Array.isArray(body.scopes)
    ? (body.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (scopes.length === 0) {
    return NextResponse.json(
      { error: 'invalid_scopes', detail: 'Pick at least one scope.' },
      { status: 400 },
    );
  }
  const invalid = scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: 'invalid_scopes', detail: `Unknown scopes: ${invalid.join(', ')}` },
      { status: 400 },
    );
  }

  const minted = mintKey();
  const row = await prisma.apiKey.create({
    data: {
      org_clerk_id: orgId,
      hashed_key: minted.hashed,
      key_prefix: minted.prefix,
      name,
      scopes: scopes as Scope[],
      created_by: userId,
    },
  });

  return NextResponse.json({
    key: {
      id: row.id,
      prefix: row.key_prefix,
      name: row.name,
      scopes: row.scopes,
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
    },
    // The raw token is returned exactly once. Customer must copy it now.
    token: minted.raw,
  });
}

// Expose the canonical scope list so the UI doesn't drift from the server.
export async function OPTIONS() {
  return NextResponse.json({ scopes: ALL_SCOPES });
}
