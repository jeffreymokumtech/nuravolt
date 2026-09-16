/**
 * GoodWe SEMS Portal — free live reachability probe.
 *
 * Uses the *unofficial* SEMS CrossLogin endpoint with the public demo login
 * (demo@goodwe.com). This is the one cloud-inverter test that runs with ZERO
 * setup — it proves we can authenticate against a real inverter cloud today.
 *
 * The endpoint is unofficial and can change/break without notice, so this probe
 * is SOFT: any network error or non-success login SKIPS (never reds the run).
 * Runs only via `npm run test:live`.
 *
 * NOTE (verified 2026-07-07): GoodWe has DISABLED the public demo account
 * (CrossLogin returns code 100029 "Accounts or organizations have been
 * disabled"), so with the default login this probe reaches the real cloud but
 * soft-skips for lack of a token. Supply any real SEMS login via
 * GOODWE_TEST_ACCOUNT / GOODWE_TEST_PWD to pull live data.
 * Reference: sems-portal-api (PyPI) + binodmx "Accessing the GoodWe SEMS API".
 */
import { describe, it, expect } from 'vitest';

const LIVE_TIMEOUT = 30_000;
const ACCOUNT = process.env.GOODWE_TEST_ACCOUNT || 'demo@goodwe.com';
const PWD = process.env.GOODWE_TEST_PWD || 'GoodweSems123!@#';
const LOGIN_URL = 'https://www.semsportal.com/api/v1/Common/CrossLogin';
const BOOTSTRAP_TOKEN = JSON.stringify({ version: 'v2.1.0', client: 'ios', language: 'en' });

interface CrossLoginData {
  uid?: string;
  timestamp?: number;
  token?: string;
  api?: string;
}

async function crossLogin(): Promise<{ code: unknown; data: CrossLoginData | null }> {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Token: BOOTSTRAP_TOKEN },
    body: JSON.stringify({ account: ACCOUNT, pwd: PWD }),
  });
  const body = (await res.json()) as { code?: unknown; data?: CrossLoginData };
  return { code: body?.code, data: body?.data ?? null };
}

describe('GoodWe SEMS portal (live, unofficial demo)', () => {
  it(
    'authenticates against the real SEMS cloud with the public demo login',
    async (ctx) => {
      let login: { code: unknown; data: CrossLoginData | null };
      try {
        login = await crossLogin();
      } catch (err) {
        return ctx.skip(`GoodWe SEMS unreachable: ${(err as Error).message}`);
      }

      const token = login.data?.token;
      if (!token) {
        return ctx.skip(`GoodWe CrossLogin returned no token (code=${String(login.code)})`);
      }

      // Reaching here means we authenticated against the real GoodWe cloud.
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);

      // Best-effort: try to list the demo account's stations (endpoint version
      // is unofficial — never hard-fail on it).
      try {
        const api = (login.data?.api || 'https://www.semsportal.com/api/').replace(/\/?$/, '/');
        const authToken = JSON.stringify({
          version: 'v2.1.0',
          client: 'ios',
          language: 'en',
          timestamp: login.data?.timestamp,
          uid: login.data?.uid,
          token,
        });
        const res = await fetch(`${api}v3/PowerStationMonitor/QueryPowerStationMonitor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Token: authToken },
          body: JSON.stringify({ page_size: 5, page_index: 1, key: '', orderby: '', powerstation_status: '', powerstation_id: '', powerstation_type: '' }),
        });
        const body = (await res.json()) as { data?: { record?: unknown[]; list?: unknown[] } };
        const stations = body?.data?.record ?? body?.data?.list ?? [];
        // eslint-disable-next-line no-console
        console.log(`[goodwe-live] authenticated; demo stations listed: ${Array.isArray(stations) ? stations.length : 'n/a'}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[goodwe-live] authenticated; station list unavailable: ${(err as Error).message}`);
      }
    },
    LIVE_TIMEOUT,
  );
});
