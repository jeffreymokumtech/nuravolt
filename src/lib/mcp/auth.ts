import prisma from '@/libs/prisma';
import { auth } from '@/lib/auth';
import { getOrgPlan } from '@/lib/billing/plan';
import { extractBearerToken, hashKey } from './keys';
import { isValidScope, READ_ONLY_SCOPES, type Scope } from './scopes';

export interface McpAuthContext {
  /** 'api_key' = org-wide service credential; 'oauth' = per-user token. */
  kind: 'api_key' | 'oauth';
  /** The org the credential belongs to (Better Auth org id). */
  orgClerkId: string;
  /**
   * For API keys: synthetic id used in audit logs. For OAuth: the real
   * Better Auth user id.
   */
  userClerkId: string;
  /** Audit/rate-limit key: ApiKey row id, or `oauth:<userId>` for OAuth. */
  apiKeyId: string;
  /** Scopes granted to the credential. */
  scopes: Scope[];
}

export type McpAuthResult =
  | { ok: true; ctx: McpAuthContext }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Validate an inbound MCP request's bearer token against the ApiKey table.
 * Bumps `last_used_at` on success (best-effort — failure to update does
 * not deny the request).
 */
export async function authenticateMcpRequest(
  authorizationHeader: string | null | undefined,
): Promise<McpAuthResult> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return { ok: false, status: 401, reason: 'missing_bearer_token' };
  }

  const row = await prisma.apiKey.findUnique({
    where: { hashed_key: hashKey(token) },
  });
  if (!row) {
    return { ok: false, status: 401, reason: 'invalid_api_key' };
  }
  if (row.revoked_at) {
    return { ok: false, status: 401, reason: 'key_revoked' };
  }
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    return { ok: false, status: 401, reason: 'key_expired' };
  }

  // Best-effort last_used_at bump — don't block the request on a write.
  prisma.apiKey
    .update({
      where: { id: row.id },
      data: { last_used_at: new Date() },
    })
    .catch(() => {
      /* swallow */
    });

  return {
    ok: true,
    ctx: {
      kind: 'api_key',
      orgClerkId: row.org_clerk_id,
      userClerkId: `mcp_key_${row.id}`,
      apiKeyId: row.id,
      scopes: row.scopes as Scope[],
    },
  };
}

/**
 * Validate an OAuth bearer token minted by the Better Auth MCP plugin
 * (Claude Desktop connector flow). Enterprise-only: other plans get a 403
 * pointing at /pricing. Access is per-user — the caller's PlantAccess ACL
 * applies, not the org-wide grant API keys get.
 */
export async function authenticateMcpOAuth(
  headers: Headers,
): Promise<McpAuthResult> {
  let session: Awaited<ReturnType<typeof auth.api.getMcpSession>>;
  try {
    session = await auth.api.getMcpSession({ headers });
  } catch {
    return { ok: false, status: 401, reason: 'invalid_oauth_token' };
  }
  if (!session || !session.userId) {
    return { ok: false, status: 401, reason: 'invalid_oauth_token' };
  }

  // Resolve the user's organization (first membership; MCP tokens don't
  // carry an active-org claim).
  const member = await prisma.member.findFirst({
    where: { userId: session.userId },
    orderBy: { createdAt: 'asc' },
  });
  if (!member) {
    return { ok: false, status: 403, reason: 'no_organization' };
  }

  const plan = await getOrgPlan(member.organizationId);
  if (plan !== 'enterprise') {
    return { ok: false, status: 403, reason: 'enterprise_plan_required' };
  }

  // Tool scopes the client explicitly requested at consent. Clients that
  // only asked for identity scopes (openid/profile/email) still get
  // read-only tool access; writes always require an explicit scope grant.
  let scopes = (session.scopes ?? '').split(' ').filter(isValidScope);
  if (scopes.length === 0) {
    scopes = [...READ_ONLY_SCOPES];
  }

  return {
    ok: true,
    ctx: {
      kind: 'oauth',
      orgClerkId: member.organizationId,
      userClerkId: session.userId,
      apiKeyId: `oauth:${session.userId}`,
      scopes,
    },
  };
}
