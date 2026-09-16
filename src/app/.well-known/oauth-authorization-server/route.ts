import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { auth } from '@/lib/auth';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414). MCP clients fetch this
 * first to discover the authorize/token/register endpoints served by the
 * Better Auth MCP plugin under /api/auth.
 */
export const dynamic = 'force-dynamic';

export const GET = oAuthDiscoveryMetadata(auth);
