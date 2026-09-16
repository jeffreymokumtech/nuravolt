/**
 * In-memory rate limiter keyed by API key id.
 *
 * Two windows enforced together:
 *   - minute: max 60 requests in any rolling 60s
 *   - day:    max 5,000 requests in any rolling 24h
 *
 * In-memory means the limiter resets on serverless cold starts and is
 * per-instance — fine for single-instance dev and a reasonable v1 floor
 * on Vercel. v2 will move to Redis (which mcp-handler also uses for
 * session state when REDIS_URL is set).
 */

interface Bucket {
  minute: number[]; // timestamps (ms) within the last 60s
  day: number[]; // timestamps (ms) within the last 24h
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PER_MINUTE_LIMIT = 60;
const PER_DAY_LIMIT = 5_000;

const buckets = new Map<string, Bucket>();

export type RateCheck =
  | { ok: true }
  | { ok: false; reason: 'minute_limit' | 'day_limit'; retryAfterSec: number };

export function checkRateLimit(apiKeyId: string): RateCheck {
  const now = Date.now();
  let b = buckets.get(apiKeyId);
  if (!b) {
    b = { minute: [], day: [] };
    buckets.set(apiKeyId, b);
  }

  // Trim expired timestamps. Cheaper than a heap; bucket sizes stay small.
  b.minute = b.minute.filter((t) => now - t < MINUTE_MS);
  b.day = b.day.filter((t) => now - t < DAY_MS);

  if (b.minute.length >= PER_MINUTE_LIMIT) {
    const oldest = b.minute[0];
    return {
      ok: false,
      reason: 'minute_limit',
      retryAfterSec: Math.ceil((MINUTE_MS - (now - oldest)) / 1000),
    };
  }
  if (b.day.length >= PER_DAY_LIMIT) {
    const oldest = b.day[0];
    return {
      ok: false,
      reason: 'day_limit',
      retryAfterSec: Math.ceil((DAY_MS - (now - oldest)) / 1000),
    };
  }

  b.minute.push(now);
  b.day.push(now);
  return { ok: true };
}

/** Test helper — reset all buckets. */
export function _resetRateLimits(): void {
  buckets.clear();
}
