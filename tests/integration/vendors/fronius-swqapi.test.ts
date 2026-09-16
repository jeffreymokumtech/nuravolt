/**
 * Fronius Solar.web Query API (SWQAPI) — free-demo live reachability probe.
 *
 * Fronius offers a FREE demo tier of the Solar.web Query API against its own
 * example systems (no contract, no Solar.web account) — you register as a
 * business partner and Fronius issues a demo access key. Drop it in the env to
 * enable this probe; it SKIPS cleanly when absent. Runs only via
 * `npm run test:live`.
 *
 * Env: FRONIUS_SWQAPI_ACCESSKEY_ID + FRONIUS_SWQAPI_ACCESSKEY_VALUE
 *      [+ FRONIUS_SWQAPI_BASE_URL to override the default host]
 *
 * Docs / Swagger: https://api.solarweb.com/swqapi/index.html
 */
import { describe, it, expect } from 'vitest';

const LIVE_TIMEOUT = 30_000;
const KEY_ID = process.env.FRONIUS_SWQAPI_ACCESSKEY_ID;
const KEY_VALUE = process.env.FRONIUS_SWQAPI_ACCESSKEY_VALUE;
const BASE = (process.env.FRONIUS_SWQAPI_BASE_URL || 'https://api.solarweb.com/swqapi').replace(/\/$/, '');
const ready = Boolean(KEY_ID && KEY_VALUE);

describe('Fronius Solar.web Query API (live, free demo)', () => {
  it.skipIf(!ready)(
    'lists a demo PV system with the Fronius-issued demo key',
    async (ctx) => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/pvsystems?limit=1`, {
          headers: {
            AccessKeyId: KEY_ID!,
            AccessKeyValue: KEY_VALUE!,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        return ctx.skip(`Fronius SWQAPI unreachable: ${(err as Error).message}`);
      }

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { pvSystems?: Array<{ pvSystemId?: string; name?: string }> };
      const systems = body?.pvSystems ?? [];
      expect(Array.isArray(systems)).toBe(true);
      expect(systems.length).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log(`[fronius-live] demo systems: ${systems.length}; first: ${systems[0]?.name ?? systems[0]?.pvSystemId}`);
    },
    LIVE_TIMEOUT,
  );
});
