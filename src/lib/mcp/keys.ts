import crypto from 'crypto';

/**
 * Token format: `nv_<env>_<32 base32 chars>`.
 * The prefix is stored separately so the dashboard can display it without
 * decrypting/storing the raw token.
 */

const ENV_PREFIX = process.env.NODE_ENV === 'production' ? 'live' : 'test';
const TOKEN_BYTES = 24; // 24 bytes → 39 base64url chars

export interface MintedKey {
  raw: string; // returned to user once; never persisted
  hashed: string; // stored in ApiKey.hashed_key
  prefix: string; // stored in ApiKey.key_prefix (display only)
}

export function mintKey(): MintedKey {
  const random = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const raw = `nv_${ENV_PREFIX}_${random}`;
  return {
    raw,
    hashed: hashKey(raw),
    prefix: raw.slice(0, 14), // e.g. "nv_test_aBc123"
  };
}

export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Extract a bearer token from an Authorization header. Returns null if the
 * header is absent or malformed. Trims whitespace defensively.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
