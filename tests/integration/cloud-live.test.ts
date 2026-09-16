/**
 * Live cloud-connector smoke tests — REAL API round-trips, credential-gated.
 *
 * These hit the actual vendor endpoints, so they:
 *   - run ONLY via `npm run test:live` (never the default CI test run), and
 *   - SKIP cleanly when the vendor's env credentials are absent.
 *
 * Provide credentials in the environment to enable a vendor (see .env.example):
 *   SolarEdge: SOLAREDGE_TEST_API_KEY  [+ optional SOLAREDGE_TEST_SITE_ID]
 *   Huawei:    HUAWEI_TEST_USERNAME + HUAWEI_TEST_SYSTEM_CODE
 *              [+ HUAWEI_TEST_BASE_URL — the region host, e.g.
 *               https://eu5.fusionsolar.huawei.com — required if your account
 *               is not on the eu5 region]
 *
 * Rate limits are real (SolarEdge 300 req/day per site; Huawei err-407 +
 * single active session), so each vendor does exactly one discover→poll pass.
 */
import { describe, it, expect } from 'vitest';
import { DataFieldType } from '@prisma/client';
import { SolarEdgeMonitoringService } from '../../src/lib/services/solaredge-api-service';
import { HuaweiFusionSolarService } from '../../src/lib/services/huawei-api-service';

const LIVE_TIMEOUT = 45_000;
const VALID_METRICS = new Set(Object.values(DataFieldType) as string[]);

// --- SolarEdge -------------------------------------------------------------

const seApiKey = process.env.SOLAREDGE_TEST_API_KEY;

describe('SolarEdge monitoring API (live)', () => {
  it.skipIf(!seApiKey)(
    'authenticates, discovers a site + devices, and polls real telemetry',
    async () => {
      const service = new SolarEdgeMonitoringService({
        credentials: { apiKey: seApiKey!, siteId: process.env.SOLAREDGE_TEST_SITE_ID },
        fetchImpl: fetch as any,
        interCallDelayMs: 250,
      });

      await service.authenticate();
      const plants = await service.discoverPlants();
      expect(plants.length).toBeGreaterThan(0);

      const firstPlant = plants[0].external_plant_id;
      const devices = await service.discoverDevices([firstPlant]);
      expect(Array.isArray(devices)).toBe(true);

      const readings = await service.pollRealtime();
      expect(readings.every((r) => VALID_METRICS.has(r.metric))).toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `[solaredge-live] ${plants.length} site(s), ${devices.length} device(s), ${readings.length} reading(s)`,
      );
    },
    LIVE_TIMEOUT,
  );
});

// --- Huawei FusionSolar ----------------------------------------------------

const hwUser = process.env.HUAWEI_TEST_USERNAME;
const hwCode = process.env.HUAWEI_TEST_SYSTEM_CODE;
const hwReady = Boolean(hwUser && hwCode);

describe('Huawei FusionSolar NorthBound API (live)', () => {
  it.skipIf(!hwReady)(
    'logs in, discovers plants + devices, and polls real telemetry',
    async () => {
      const service = new HuaweiFusionSolarService({
        baseUrl: process.env.HUAWEI_TEST_BASE_URL, // region host; undefined → eu5 default
        credentials: { userName: hwUser!, systemCode: hwCode! },
        fetchImpl: fetch as any,
        interCallDelayMs: 1000,
      });

      const plants = await service.discoverPlants();
      expect(plants.length).toBeGreaterThan(0);

      const devices = await service.discoverDevices(plants.map((p) => p.external_plant_id));
      expect(Array.isArray(devices)).toBe(true);

      const readings = await service.pollRealtime();
      expect(readings.every((r) => VALID_METRICS.has(r.metric))).toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `[huawei-live] ${plants.length} plant(s), ${devices.length} device(s), ${readings.length} reading(s)`,
      );
    },
    LIVE_TIMEOUT,
  );
});
