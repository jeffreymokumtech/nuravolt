/**
 * API contract tests — strict status + shape assertions for the critical
 * customer paths. Run against a live server:
 *
 *   npm run test:api                       # local dev server (default)
 *   QA_BASE_URL=https://staging npm run test:api
 *
 * Prerequisites: the server is up; for data-dependent assertions the seeded
 * plant exists (scripts/seed_e2e_demo_data.py --plant-id region_a-rooftop).
 * Data-dependent tests skip themselves when the seed marker is absent.
 * Tenancy tests create throwaway users/orgs through the real sign-up APIs.
 */

import { beforeAll, describe, expect, it } from 'vitest';

const BASE = (process.env.QA_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ORIGIN = { Origin: BASE };
// Default to the smoke user's own seeded plant so the data-dependent
// assertions actually run (a plant the QA_EMAIL org can't read would 404 and
// silently skip them). Override with QA_PLANT_SLUG on other environments.
const SEED_PLANT = process.env.QA_PLANT_SLUG ?? 'smoke-park-one';
// Session owner of the seeded plant (org-owned plants 404 anonymously — by design).
const QA_EMAIL = process.env.QA_EMAIL ?? 'smoke@nuravolt.test';
const QA_PASSWORD = process.env.QA_PASSWORD ?? 'smoketest-passw0rd';

let seedPresent = false;
let sessionCookie = '';

/** Headers for requests that act as the seeded plant's org member. */
function authed(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), Cookie: sessionCookie },
  };
}

async function j(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, authed(init));
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

/** Sign up a throwaway user + org through the real APIs; returns a Cookie header. */
async function signUpWithOrg(tag: string): Promise<string> {
  const email = `qa-${tag}-${Date.now()}@nuravolt.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ name: `QA ${tag}`, email, password: 'qa-passw0rd-123' }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const orgRes = await fetch(`${BASE}/api/auth/organization/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...ORIGIN },
    body: JSON.stringify({ name: `QA ${tag} Org`, slug: `qa-${tag}-${Date.now().toString(36)}` }),
  });
  expect(orgRes.status).toBe(200);
  // Fresh session so activeOrganizationId is set.
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ email, password: 'qa-passw0rd-123' }),
  });
  return signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

beforeAll(async () => {
  // Sign in as the seeded plant's owner; QA_SESSION_COOKIE overrides (staging).
  if (process.env.QA_SESSION_COOKIE) {
    sessionCookie = process.env.QA_SESSION_COOKIE;
  } else {
    const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ORIGIN },
      body: JSON.stringify({ email: QA_EMAIL, password: QA_PASSWORD }),
    });
    if (res.status === 200) {
      sessionCookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    } else {
      console.warn(`[contracts] QA sign-in failed (${res.status}) — running anonymously`);
    }
  }

  const probe = await j(`/api/soiling/plants/${SEED_PLANT}/forecast?days=3`);
  seedPresent = probe.status === 200 && (probe.body?.forecasts?.length ?? 0) > 0;
  if (!seedPresent) {
    console.warn(`[contracts] seed plant '${SEED_PLANT}' absent — data assertions will be skipped`);
  }
});

describe('plants API', () => {
  it('GET /api/plants returns the paginated fleet shape', async () => {
    const { status, body } = await j('/api/plants');
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toMatchObject({ page: expect.any(Number), total: expect.any(Number) });
  });

  it('unknown plant detail is a clean 404 envelope', async () => {
    const { status, body } = await j('/api/plants/definitely-not-a-plant');
    expect(status).toBe(404);
    expect(typeof body.error).toBe('string');
  });
});

describe('billing API', () => {
  it('plan endpoint exposes plan + features', async () => {
    const { status, body } = await j('/api/billing/plan');
    expect(status).toBe(200);
    expect(['free', 'residential', 'business', 'enterprise']).toContain(body.plan);
    expect(body.features).toHaveProperty('mcp:api_keys');
    expect(body.features).toHaveProperty('analytics:cleaning_optimizer');
    expect(body.features).toHaveProperty('ai:copilot');
  });

  it('usage endpoint exposes limits + usage', async () => {
    const { status, body } = await j('/api/billing/usage');
    expect(status).toBe(200);
    expect(body.limits).toHaveProperty('mw');
    expect(body.usage).toHaveProperty('mw');
  });
});

describe('soiling analytics (seeded plant)', () => {
  it('forecast is database-sourced, windowed from today, bounds bracket SR', async () => {
    if (!seedPresent) return;
    const { status, body } = await j(`/api/soiling/plants/${SEED_PLANT}/forecast?days=7`);
    expect(status).toBe(200);
    expect(body._source).toBe('database');
    expect(body.forecasts.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.forecasts[0].date >= today).toBe(true);
    for (const f of body.forecasts) {
      expect(f.lowerBound).toBeLessThanOrEqual(f.soilingRatio);
      expect(f.soilingRatio).toBeLessThanOrEqual(f.upperBound);
      // Real per-row confidence (coldstart rows carry 0.5) — never a
      // dressed-up constant 0.95 and never out of (0, 1].
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('summary: fleet health is real counts or an honest null — never silent zeros', async () => {
    if (!seedPresent) return;
    const { status, body } = await j(`/api/soiling/plants/${SEED_PLANT}/summary`);
    expect(status).toBe(200);
    expect(body.currentStatus.avgSoilingRatio).toBeGreaterThan(0.5);
    expect(body.currentStatus.avgSoilingRatio).toBeLessThanOrEqual(1.05);
    // Either per-inverter counts exist (and count something) or the field is
    // null; an all-zero object would fake a "perfect fleet".
    if (body.fleetHealth !== null) {
      const counts = [
        body.fleetHealth.normalInverters,
        body.fleetHealth.minorIssues,
        body.fleetHealth.majorIssues,
        body.fleetHealth.critical,
      ];
      for (const c of counts) expect(c).toBeGreaterThanOrEqual(0);
      expect(counts.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0);
    }
    // Tariff is declared with its source, not silently hardcoded.
    expect(body.economicImpact.tariff_eur_per_mwh).toBeGreaterThan(0);
    expect(['plant_metadata', 'default']).toContain(body.economicImpact.tariff_source);
  });
});

describe('soiling per-inverter (fixture plant ribera)', () => {
  // ribera is a public demo plant whose per-inverter artifacts are generated
  // from MEASURED data (self-normalized PR + DustIQ calibration). These
  // contracts are the serving-layer twin of
  // tests/soiling/test_served_artifacts.py.
  it('sr-estimate serves the whole fleet with genuine spread', async () => {
    const { status, body } = await j('/api/soiling/plants/ribera/inverters/sr-estimate?days=30');
    expect(status).toBe(200);
    expect(body.metadata.totalInverters).toBeGreaterThanOrEqual(100);
    const srs = Object.values(body.inverters).map((v: any) => v.currentSR as number);
    const mean = srs.reduce((a, b) => a + b, 0) / srs.length;
    const std = Math.sqrt(srs.reduce((s, v) => s + (v - mean) ** 2, 0) / srs.length);
    expect(std).toBeGreaterThan(0.003); // a plant-mean broadcast is exactly 0
    expect(body.summary.fleetStdSR).toBeGreaterThan(0);
    // Histories are per-inverter series, newest first.
    const sample: any = Object.values(body.inverters)[0];
    expect(sample.history.length).toBeGreaterThan(10);
    const dates = sample.history.map((h: any) => h.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('summary fixture branch: health partitions the fleet and performers are named', async () => {
    const { status, body } = await j('/api/soiling/plants/ribera/summary');
    expect(status).toBe(200);
    if (body._source === 'database') return; // seeded DB rows win locally — covered above
    const health = body.fleetHealth;
    const total =
      health.normalInverters + health.minorIssues + health.majorIssues + health.critical;
    expect(total).toBe(body.plantInfo.totalInverters);
    expect(body.topPerformers.length).toBeGreaterThan(0);
    expect(body.worstPerformers.length).toBeGreaterThan(0);
  });

  it('forecast fixture branch: bounds ordered, confidence varies with the CI band', async () => {
    const { status, body } = await j('/api/soiling/plants/ribera/forecast?days=60');
    expect(status).toBe(200);
    expect(body.forecasts.length).toBeGreaterThan(30);
    for (const f of body.forecasts) {
      expect(f.lowerBound).toBeLessThanOrEqual(f.soilingRatio + 1e-9);
      expect(f.soilingRatio).toBeLessThanOrEqual(f.upperBound + 1e-9);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    if (body._source !== 'database') {
      // JSON branch derives confidence from each day's own CI width — a flat
      // constant across 60 days means someone hardcoded it again.
      const uniq = new Set(body.forecasts.map((f: any) => f.confidence));
      expect(uniq.size).toBeGreaterThan(1);
    }
  });
});

describe('digital twin (seeded plant)', () => {
  it('twin summary serves physics rows with sane values', async () => {
    if (!seedPresent) return;
    const { status, body } = await j(`/api/digitaltwin/${SEED_PLANT}/summary?resolution=daily&days=30`);
    expect(status).toBe(200);
    expect(body._source).toBe('database');
    expect(body.daily.length).toBeGreaterThan(5);
    const day = body.daily[body.daily.length - 1];
    expect(day.predicted_kw).toBeGreaterThan(0);
    // Physics sanity: actual within 50% of predicted on seeded data.
    if (day.actual_kw > 0) {
      expect(Math.abs(day.actual_kw - day.predicted_kw) / day.predicted_kw).toBeLessThan(0.5);
    }
  });

  // The DB branch and the fixture fallback must emit the identical contract —
  // the overview keeps a single code path over both.
  const SHAPE_KEYS = ['date', 'predicted_kw', 'actual_kw', 'residual_kw', 'loss_pct', 'predicted_mwh', 'actual_mwh'];

  it('shape parity: database vs fixture source', async () => {
    if (!seedPresent) return;
    const db = await j(`/api/digitaltwin/${SEED_PLANT}/summary?resolution=daily`);
    const fx = await j(`/api/digitaltwin/alpha/summary?resolution=daily&from=2025-06-01&to=2025-06-30`);
    expect(db.body._source).toBe('database');
    expect(fx.body._source).toBe('json');
    for (const res of [db, fx]) {
      expect(res.status).toBe(200);
      expect(res.body.metadata?.data_end).toBeTruthy();
      expect(res.body.summary).toHaveProperty('total_predicted_mwh');
      expect(res.body.summary).toHaveProperty('measured_days');
      for (const key of SHAPE_KEYS) expect(res.body.daily[0]).toHaveProperty(key);
    }
  });

  it('monthly rollup buckets a fixture year into ~12 rows', async () => {
    const { status, body } = await j(
      `/api/digitaltwin/alpha/summary?resolution=monthly&from=2024-12-01&to=2025-11-30`
    );
    expect(status).toBe(200);
    expect(body._resolution).toBe('monthly');
    expect(body.daily.length).toBeGreaterThanOrEqual(11);
    expect(body.daily.length).toBeLessThanOrEqual(13);
    // Month buckets integrate energy: a 9 MW plant produces hundreds of MWh/mo.
    expect(body.daily[0].predicted_mwh).toBeGreaterThan(100);
  });

  it('re-anchors wall-clock windows to the fixture data end', async () => {
    const { status, body } = await j(`/api/digitaltwin/alpha/summary?resolution=daily`);
    expect(status).toBe(200);
    expect(body.daily.length).toBeGreaterThan(5);
    // Fixture ends 2025-12-13; a "last 30 days from now" request must not 404.
    expect(body.metadata.data_end).toBe(body.daily[body.daily.length - 1].date.slice(0, 10));
  });

  it('intraday peaks: predicted and actual peak within 1 hour of each other', async () => {
    // Regression for the tz relabeling bug: the physics twin used to stamp
    // its prediction 1-2 h off the measured clock, so the two curves peaked
    // at different moments on every daily view.
    if (!seedPresent) return;
    const { status, body } = await j(
      `/api/digitaltwin/${SEED_PLANT}/summary?resolution=hourly&days=7`
    );
    expect(status).toBe(200);
    const byDay = new Map<string, { hour: number; pred: number; act: number }[]>();
    for (const row of body.daily as Array<{ date: string; predicted_kw: number | null; actual_kw: number | null }>) {
      const day = row.date.slice(0, 10);
      const hour = new Date(row.date).getUTCHours();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ hour, pred: row.predicted_kw ?? 0, act: row.actual_kw ?? 0 });
    }
    let qualifying = 0;
    let aligned = 0;
    for (const rows of byDay.values()) {
      const predPeak = rows.reduce((a, b) => (b.pred > a.pred ? b : a));
      const actPeak = rows.reduce((a, b) => (b.act > a.act ? b : a));
      // Only days where both series carry a real daytime signal qualify.
      if (predPeak.pred < 10 || actPeak.act < 10) continue;
      qualifying += 1;
      if (Math.abs(predPeak.hour - actPeak.hour) <= 1) aligned += 1;
    }
    expect(qualifying).toBeGreaterThan(0);
    // >= 80% of qualifying days must align (tolerates one cloudy-day tie).
    expect(aligned / qualifying).toBeGreaterThanOrEqual(0.8);
  });
});

describe('onboarding status (seeded plant)', () => {
  it('exposes the four-step tracker', async () => {
    if (!seedPresent) return;
    const { status, body } = await j(`/api/plants/${SEED_PLANT}/onboarding-status`);
    expect(status).toBe(200);
    expect(body.steps.map((s: any) => s.key)).toEqual([
      'connection',
      'first_data',
      'coldstart',
      'trained',
    ]);
  });
});

describe('sample inverter feed (seeded plant)', () => {
  it('provisions a synthetic feed, lights up live + lineage', async () => {
    if (!seedPresent) return;

    // Provision (idempotent — safe to re-run against the seeded plant).
    const gen = await j(`/api/plants/${SEED_PLANT}/sample-feed`, { method: 'POST' });
    expect(gen.status).toBe(200);
    expect(gen.body.ok).toBe(true);
    expect(gen.body.connection_id).toBeTruthy();
    expect(gen.body.device_count).toBeGreaterThan(0);
    expect(gen.body.rows_written).toBeGreaterThan(0);

    // Live tile lights up (snapshots landed).
    const live = await j(`/api/plants/${SEED_PLANT}/live`);
    expect(live.status).toBe(200);
    expect(live.body.live).toBe(true);

    // first_data step is satisfied.
    const status = await j(`/api/plants/${SEED_PLANT}/onboarding-status`);
    const firstData = status.body.steps.find((s: any) => s.key === 'first_data');
    expect(firstData?.state).toBe('done');

    // Lineage carries an honest synthesized "Sample inverter feed" stream.
    const lineage = await j(`/api/plants/${SEED_PLANT}/data-lineage`);
    expect(lineage.status).toBe(200);
    const sample = lineage.body.streams.find((s: any) =>
      String(s.source_label).includes('Sample inverter feed'),
    );
    expect(sample).toBeTruthy();
    expect(sample.source_class).toBe('synthesized');
    expect(sample.provisional).toBe(true);
  });
});

describe('tenancy isolation + plan lock (throwaway orgs)', () => {
  it('no-plan orgs cannot onboard; org B cannot see org A/smoke plants', async () => {
    const cookieA = await signUpWithOrg('a');
    const cookieB = await signUpWithOrg('b');

    // New orgs have NO plan (free): onboarding a plant is a 402 plan_required.
    const create = await fetch(`${BASE}/api/plants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA, ...ORIGIN },
      body: JSON.stringify({ name: `QA Iso ${Date.now()}`, latitude: 40, longitude: -3, capacity_mw: 0.05 }),
    });
    expect(create.status).toBe(402);
    const createBody = await create.json();
    expect(createBody.error).toBe('plan_required');
    expect(createBody.upgrade_url).toBe('/pricing');

    // Same lock on data connections.
    const conn = await fetch(`${BASE}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA, ...ORIGIN },
      body: JSON.stringify({ name: 'QA Iso Conn', type: 'sample_api', config: { sample: true } }),
    });
    expect(conn.status).toBe(402);
    expect((await conn.json()).error).toBe('plan_required');

    // Cross-tenant isolation, probed against the smoke org's seeded plant
    // (throwaway orgs can no longer create plants of their own).
    if (seedPresent && sessionCookie) {
      const mine = await j('/api/plants');
      const seedPlant = mine.body.data.find((p: any) => p.slug === SEED_PLANT);
      expect(seedPlant).toBeTruthy();

      // B fetching the smoke org's plant → 404, never 200.
      const cross = await fetch(`${BASE}/api/plants/${seedPlant.id}`, {
        headers: { Cookie: cookieB },
      });
      expect(cross.status).toBe(404);

      // B's fleet list must not contain it.
      const listB = await (await fetch(`${BASE}/api/plants`, { headers: { Cookie: cookieB } })).json();
      expect(listB.data.some((p: any) => p.id === seedPlant.id)).toBe(false);
    }
  }, 60_000);

  it('feature gates: no-plan org gets 402 on Business features', async () => {
    const cookie = await signUpWithOrg('gate');
    const res = await fetch(`${BASE}/api/reports`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('plan_upgrade_required');
    expect(body.feature).toBe('reports:builder');

    // AI copilot (chat) is Business+ only — the same 402 envelope.
    const chat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...ORIGIN },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(402);
    const chatBody = await chat.json();
    expect(chatBody.error).toBe('plan_upgrade_required');
    expect(chatBody.feature).toBe('ai:copilot');
  }, 60_000);
});

describe('MCP transport', () => {
  // 30s: the MCP route is the heaviest compile on a cold dev server.
  it('rejects garbage bearers with an OAuth challenge', { timeout: 30_000 }, async () => {
    const res = await fetch(`${BASE}/api/mcp/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer garbage',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('serves OAuth discovery metadata', async () => {
    const { status, body } = await j('/.well-known/oauth-authorization-server');
    expect(status).toBe(200);
    expect(body.authorization_endpoint).toContain('/api/auth/mcp/authorize');
  });
});
