import { oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '@/lib/auth';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728). The MCP transport's 401
 * challenge points clients here, which in turn points at the authorization
 * server metadata.
 */
export const dynamic = 'force-dynamic';

export const GET = oAuthProtectedResourceMetadata(auth);
