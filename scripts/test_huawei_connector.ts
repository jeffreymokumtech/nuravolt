/**
 * Standalone test script for the Huawei FusionSolar cloud connector.
 * No test framework — run with:  npx tsx scripts/test_huawei_connector.ts
 * Exits non-zero on any failure.
 *
 * Covers:
 *   - login (XSRF token from response header, sent on subsequent calls)
 *   - /thirdData/stations pagination → NormalizedPlant
 *   - /thirdData/getDevList (inverter + EMI) → NormalizedDevice
 *   - /thirdData/getDevFiveMinutes backfill normalization
 *   - /thirdData/getDevRealKpi realtime normalization
 *   - failCode 407 rate-limit → backoff + single retry
 *   - failCode 305 token expiry → relogin + retry with new token
 *   - staticFieldMappings reference only valid DataFieldType members
 *   - ParquetLakeWriter buffer encoding (PAR1 magic)
 */
import { DataFieldType } from '@prisma/client';
import {
  HuaweiFusionSolarService,
  HUAWEI_STATIC_FIELD_MAPPINGS,
} from '../src/lib/services/huawei-api-service';
import { ParquetLakeWriter } from '../src/lib/services/s3-storage';

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

// check() throws on failure so every case doubles as a vitest test
// (tests/connectors/huawei.test.ts) and a standalone tsx debug run.
function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

function checkEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(_name: string): void {}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  body: Record<string, any>;
  headers: Record<string, string>;
}

function jsonResponse(body: any, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/**
 * Builds a mock fetch that dispatches on the /thirdData path. Handlers can be
 * arrays (consumed in order) to script multi-call sequences (407 retry, 305
 * relogin).
 */
function buildMockFetch(handlers: Record<string, Array<(call: RecordedCall) => any>>) {
  const calls: RecordedCall[] = [];
  const mockFetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const call: RecordedCall = {
      path,
      body: init.body ? JSON.parse(init.body) : {},
      headers: init.headers ?? {},
    };
    calls.push(call);
    const queue = handlers[path];
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected call to ${path}`);
    }
    const handler = queue.length > 1 ? queue.shift()! : queue[0];
    return handler(call);
  };
  return { mockFetch, calls };
}

function makeService(handlers: Record<string, Array<(call: RecordedCall) => any>>, extra: any = {}) {
  const { mockFetch, calls } = buildMockFetch(handlers);
  const service = new HuaweiFusionSolarService({
    // Unique baseUrl per test so the module-level token cache never leaks
    // between scenarios.
    baseUrl: `https://test-${Math.random().toString(36).slice(2)}.fusionsolar.example`,
    credentials: { userName: 'nb-user', systemCode: 'nb-code' },
    fetchImpl: mockFetch as any,
    interCallDelayMs: 0,
    rateLimitBackoffMs: 5,
    ...extra,
  });
  return { service, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_OK = (token = 'tok-1') => (call: RecordedCall) => {
  if (call.body.userName !== 'nb-user' || call.body.systemCode !== 'nb-code') {
    return jsonResponse({ success: false, failCode: 20001, data: null });
  }
  return jsonResponse({ success: true, failCode: 0, data: null }, { 'xsrf-token': token });
};

const STATIONS_PAGE_1 = jsonResponse({
  success: true,
  failCode: 0,
  data: {
    total: 2,
    pageCount: 1,
    pageNo: 1,
    pageSize: 100,
    list: [
      {
        plantCode: 'NE=33333333',
        plantName: 'Desert One',
        plantAddress: 'Riyadh, KSA',
        longitude: '46.675', // FusionSolar returns strings
        latitude: '24.713',
        capacity: 12.5, // MW
        contactPerson: 'Ops Desk',
        gridConnectionDate: '2022-03-01T00:00:00+03:00',
      },
      {
        plantCode: 'NE=44444444',
        plantName: 'Coastal Two',
        plantAddress: 'Jeddah, KSA',
        longitude: 39,
        latitude: 21.5,
        capacity: 4.2,
      },
    ],
  },
});

const DEV_LIST = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      id: 1000001,
      devDn: 'NE=1000001',
      devName: 'INV-01',
      devTypeId: 1,
      esnCode: 'SN-INV-01',
      stationCode: 'NE=33333333',
      invType: 'SUN2000-100KTL-M1',
      latitude: 24.5,
      longitude: 46.5,
      softwareVersion: 'V100R001C00SPC116',
    },
    {
      id: 1000002,
      devDn: 'NE=1000002',
      devName: 'EMI-01',
      devTypeId: 10,
      esnCode: 'SN-EMI-01',
      stationCode: 'NE=33333333',
    },
    {
      id: 1000003,
      devDn: 'NE=1000003',
      devName: 'Logger-01',
      devTypeId: 63,
      stationCode: 'NE=44444444',
    },
  ],
});

const FIVE_MIN_TS = Date.UTC(2026, 5, 30, 8, 0, 0); // 2026-06-30T08:00Z

const FIVE_MINUTES_INVERTER = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      devId: 1000001,
      collectTime: FIVE_MIN_TS,
      dataItemMap: {
        active_power: 82.4, // kW
        reactive_power: 1.2,
        temperature: 51.3, // internal C
        efficiency: 98.6, // intentionally unmapped
        mppt_power: 84.0,
        day_cap: 305.2,
        total_cap: 190_442.7,
      },
    },
    {
      devId: 1000001,
      collectTime: FIVE_MIN_TS + 5 * 60 * 1000,
      dataItemMap: {
        active_power: 83.1,
        temperature: 51.8,
      },
    },
  ],
});

const FIVE_MINUTES_EMI = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      devId: 1000002,
      collectTime: FIVE_MIN_TS,
      dataItemMap: {
        radiation_intensity: 843.0, // W/m2
        temperature: 34.2, // ambient C
        wind_speed: 3.4,
        wind_direction: 210,
      },
    },
  ],
});

const REAL_KPI_INVERTER = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      devId: 1000001,
      dataItemMap: {
        active_power: 79.9,
        day_cap: 401.5,
        temperature: 49.0,
        run_state: 1,
      },
    },
  ],
});

const REAL_KPI_EMI = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      devId: 1000002,
      dataItemMap: {
        radiation_intensity: 911.2,
        temperature: 35.0,
        wind_speed: 2.1,
      },
    },
  ],
});

const RATE_LIMITED = jsonResponse({ success: false, failCode: 407, data: null });
const TOKEN_EXPIRED = jsonResponse({ success: false, failCode: 305, data: null });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFieldMappingsValidity() {
  section('staticFieldMappings reference only valid DataFieldType members');
  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(validMembers.size > 50, `DataFieldType enum loaded (${validMembers.size} members)`);

  const seen = new Set<string>();
  for (const mapping of HUAWEI_STATIC_FIELD_MAPPINGS) {
    check(
      validMembers.has(mapping.mapped_field),
      `'${mapping.original_field}' → '${mapping.mapped_field}' is a valid DataFieldType`
    );
    check(!seen.has(mapping.original_field), `'${mapping.original_field}' is unique`);
    seen.add(mapping.original_field);
  }

  // Spot-check the EMI irradiance/temperature mappings (per-inverter soiling
  // depends on these landing in the right taxonomy slots).
  const index = new Map(HUAWEI_STATIC_FIELD_MAPPINGS.map(m => [m.original_field, m.mapped_field]));
  checkEqual(index.get('emi.radiation_intensity'), 'irradiance_poa', 'EMI radiation_intensity → irradiance_poa');
  checkEqual(index.get('emi.temperature'), 'temp_ambient', 'EMI temperature → temp_ambient');
  checkEqual(index.get('inverter.temperature'), 'temp_inverter', 'Inverter temperature → temp_inverter');
  checkEqual(index.get('inverter.active_power'), 'power_ac', 'Inverter active_power → power_ac');
}

async function testLoginAndDiscovery() {
  section('login + stations + getDevList');
  const { service, calls } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1')],
    '/thirdData/stations': [() => STATIONS_PAGE_1],
    '/thirdData/getDevList': [() => DEV_LIST],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 2, 'two plants discovered');
  checkEqual(plants[0].external_plant_id, 'NE=33333333', 'plantCode mapped to external_plant_id');
  checkEqual(plants[0].name, 'Desert One', 'plantName mapped');
  checkEqual(plants[0].capacity_mw, 12.5, 'capacity stays in MW');
  checkEqual(plants[0].location?.lat, 24.713, 'string latitude coerced to number');
  checkEqual(plants[0].location?.address, 'Riyadh, KSA', 'plantAddress mapped');

  const loginCall = calls.find(c => c.path === '/thirdData/login')!;
  checkEqual(loginCall.body, { userName: 'nb-user', systemCode: 'nb-code' }, 'login body has userName+systemCode');

  const stationsCall = calls.find(c => c.path === '/thirdData/stations')!;
  checkEqual(stationsCall.headers['XSRF-TOKEN'], 'tok-1', 'XSRF-TOKEN header sent on stations call');
  checkEqual(stationsCall.body.pageNo, 1, 'stations call is paginated (pageNo)');

  const devices = await service.discoverDevices(plants.map(p => p.external_plant_id));
  checkEqual(devices.length, 3, 'three devices discovered');
  const inv = devices.find(d => d.external_device_id === '1000001')!;
  checkEqual(inv.device_type, 'string_inverter', 'devTypeId 1 → string_inverter');
  checkEqual(inv.model, 'SUN2000-100KTL-M1', 'invType → model');
  checkEqual(inv.serial, 'SN-INV-01', 'esnCode → serial');
  checkEqual(inv.external_plant_id, 'NE=33333333', 'stationCode → external_plant_id');
  const emi = devices.find(d => d.external_device_id === '1000002')!;
  checkEqual(emi.device_type, 'emi', 'devTypeId 10 → emi');
  const logger = devices.find(d => d.external_device_id === '1000003')!;
  checkEqual(logger.device_type, 'logger', 'devTypeId 63 → logger');

  const devListCall = calls.find(c => c.path === '/thirdData/getDevList')!;
  checkEqual(devListCall.body.stationCodes, 'NE=33333333,NE=44444444', 'stationCodes comma-joined');

  const loginCount = calls.filter(c => c.path === '/thirdData/login').length;
  checkEqual(loginCount, 1, 'token cached — only one login across discovery calls');
}

async function testBackfill() {
  section('getDevFiveMinutes backfill');
  const { service, calls } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1')],
    '/thirdData/stations': [() => STATIONS_PAGE_1],
    '/thirdData/getDevList': [() => DEV_LIST],
    '/thirdData/getDevFiveMinutes': [
      (call) => (call.body.devTypeId === 1 ? FIVE_MINUTES_INVERTER : FIVE_MINUTES_EMI),
      (call) => (call.body.devTypeId === 1 ? FIVE_MINUTES_INVERTER : FIVE_MINUTES_EMI),
    ],
  });

  await service.discoverPlants();
  await service.discoverDevices(['NE=33333333', 'NE=44444444']);

  const day = new Date(Date.UTC(2026, 5, 30));
  const readings = await service.backfill(['1000001', '1000002'], day);

  const fiveMinCalls = calls.filter(c => c.path === '/thirdData/getDevFiveMinutes');
  checkEqual(fiveMinCalls.length, 2, 'one getDevFiveMinutes call per devTypeId');
  const typeIds = fiveMinCalls.map(c => c.body.devTypeId).sort((a, b) => a - b);
  checkEqual(typeIds, [1, 10], 'calls grouped by devTypeId (1 inverter, 10 EMI)');
  for (const c of fiveMinCalls) {
    const ct = Number(c.body.collectTime);
    check(
      ct >= Date.UTC(2026, 5, 30) && ct < Date.UTC(2026, 5, 31),
      `collectTime ${ct} lies within the target day`
    );
  }

  // efficiency has no DataFieldType — must be dropped
  check(!readings.some(r => (r.metric as string) === 'efficiency'), 'unmapped keys (efficiency) dropped');

  const power = readings.filter(r => r.device_ext_id === '1000001' && r.metric === 'power_ac');
  checkEqual(power.length, 2, 'two power_ac points from two 5-min rows');
  checkEqual(power[0].value, 82.4, 'power value unscaled (kW→kW)');
  checkEqual(power[0].ts, FIVE_MIN_TS, 'row collectTime used as reading ts');
  checkEqual(power[0].plant_ext_id, 'NE=33333333', 'plant resolved from device registry');
  checkEqual(power[0].unit, 'kW', 'unit carried through');

  const invTemp = readings.find(r => r.device_ext_id === '1000001' && r.metric === 'temp_inverter');
  checkEqual(invTemp?.value, 51.3, "inverter 'temperature' → temp_inverter");
  const ambTemp = readings.find(r => r.device_ext_id === '1000002' && r.metric === 'temp_ambient');
  checkEqual(ambTemp?.value, 34.2, "EMI 'temperature' → temp_ambient");
  const irr = readings.find(r => r.metric === 'irradiance_poa');
  checkEqual(irr?.value, 843.0, 'EMI radiation_intensity → irradiance_poa');

  // Every metric must be a valid DataFieldType member
  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(
    readings.every(r => validMembers.has(r.metric)),
    'all backfill reading metrics are valid DataFieldType members'
  );
}

async function testRealtime() {
  section('getDevRealKpi realtime');
  const { service, calls } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1')],
    '/thirdData/stations': [() => STATIONS_PAGE_1],
    '/thirdData/getDevList': [() => DEV_LIST],
    '/thirdData/getDevRealKpi': [
      (call) => (call.body.devTypeId === 1 ? REAL_KPI_INVERTER : REAL_KPI_EMI),
      (call) => (call.body.devTypeId === 1 ? REAL_KPI_INVERTER : REAL_KPI_EMI),
    ],
  });

  await service.discoverPlants();
  await service.discoverDevices(['NE=33333333', 'NE=44444444']);

  const before = Date.now();
  const readings = await service.pollRealtime();
  const after = Date.now();

  const kpiCalls = calls.filter(c => c.path === '/thirdData/getDevRealKpi');
  checkEqual(kpiCalls.length, 2, 'one getDevRealKpi call per devTypeId (inverter + EMI)');
  // Logger (devTypeId 63) must not be polled
  check(
    kpiCalls.every(c => !String(c.body.devIds).includes('1000003')),
    'non-pollable devices (logger) excluded from realtime'
  );

  const power = readings.find(r => r.metric === 'power_ac');
  checkEqual(power?.value, 79.9, 'realtime active_power normalized');
  const energy = readings.find(r => r.metric === 'energy_daily');
  checkEqual(energy?.value, 401.5, 'realtime day_cap → energy_daily');
  const state = readings.find(r => r.metric === 'status_code');
  checkEqual(state?.value, 1, 'run_state → status_code');
  check(
    readings.every(r => r.ts >= before && r.ts <= after),
    'realtime readings stamped with poll time'
  );

  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(
    readings.every(r => validMembers.has(r.metric)),
    'all realtime reading metrics are valid DataFieldType members'
  );
}

async function testRateLimitRetry() {
  section('failCode 407 rate limit → backoff + retry once');
  const { service, calls } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1')],
    '/thirdData/stations': [
      () => RATE_LIMITED, // first attempt rate-limited
      () => STATIONS_PAGE_1, // retry succeeds
    ],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 2, 'stations succeeds after 407 retry');
  const stationCalls = calls.filter(c => c.path === '/thirdData/stations');
  checkEqual(stationCalls.length, 2, 'exactly one retry after 407');

  // A second consecutive 407 must throw (single retry only)
  const { service: service2 } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1')],
    '/thirdData/stations': [() => RATE_LIMITED, () => RATE_LIMITED],
  });
  let threw = false;
  try {
    await service2.discoverPlants();
  } catch (error) {
    threw = true;
    check(String(error).includes('407'), 'double-407 error mentions failCode 407');
  }
  check(threw, 'double 407 throws instead of retrying forever');
}

async function testReloginOn305() {
  section('failCode 305 → relogin + retry with new token');
  const { service, calls } = makeService({
    '/thirdData/login': [LOGIN_OK('tok-1'), LOGIN_OK('tok-2')],
    '/thirdData/stations': [
      () => TOKEN_EXPIRED, // token rejected
      () => STATIONS_PAGE_1, // succeeds after relogin
    ],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 2, 'stations succeeds after 305 relogin');

  const loginCalls = calls.filter(c => c.path === '/thirdData/login');
  checkEqual(loginCalls.length, 2, 'relogin performed exactly once');

  const stationCalls = calls.filter(c => c.path === '/thirdData/stations');
  checkEqual(stationCalls.length, 2, 'stations retried exactly once after 305');
  checkEqual(stationCalls[0].headers['XSRF-TOKEN'], 'tok-1', 'first attempt used old token');
  checkEqual(stationCalls[1].headers['XSRF-TOKEN'], 'tok-2', 'retry used the refreshed token');
}

async function testLegacyStationList() {
  section('legacy getStationList fallback flag');
  const { service, calls } = makeService(
    {
      '/thirdData/login': [LOGIN_OK('tok-1')],
      '/thirdData/getStationList': [
        () =>
          jsonResponse({
            success: true,
            failCode: 0,
            data: [
              {
                stationCode: 'ST-9',
                stationName: 'Legacy Plant',
                stationAddr: 'Casablanca, MA',
                capacity: 2.4,
                longitude: -7.6,
                latitude: 33.6,
              },
            ],
          }),
      ],
    },
    { useLegacyStationList: true }
  );

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 1, 'legacy list returns one plant');
  checkEqual(plants[0].external_plant_id, 'ST-9', 'stationCode mapped');
  checkEqual(plants[0].name, 'Legacy Plant', 'stationName mapped');
  check(!calls.some(c => c.path === '/thirdData/stations'), 'paginated endpoint not called in legacy mode');
}

async function testParquetBuffer() {
  section('ParquetLakeWriter buffer encoding');
  const buffer = await ParquetLakeWriter.toParquetBuffer([
    {
      ts: FIVE_MIN_TS,
      plant_ext_id: 'NE=33333333',
      device_ext_id: '1000001',
      device_type: 'string_inverter',
      metric: 'power_ac',
      value: 82.4,
      unit: 'kW',
    },
    {
      ts: FIVE_MIN_TS,
      plant_ext_id: 'NE=33333333',
      device_ext_id: '1000002',
      device_type: 'emi',
      metric: 'irradiance_poa',
      value: 843.0,
      // unit intentionally omitted — optional column
    },
  ]);
  check(buffer.length > 0, 'parquet buffer is non-empty');
  checkEqual(buffer.subarray(0, 4).toString('ascii'), 'PAR1', 'buffer starts with PAR1 magic');
  checkEqual(buffer.subarray(buffer.length - 4).toString('ascii'), 'PAR1', 'buffer ends with PAR1 magic');

  const writer = new ParquetLakeWriter({ bucket: 'test-bucket' });
  const key = writer.buildKey('conn-123', FIVE_MIN_TS);
  checkEqual(key, `bronze/live/conn-123/2026-06-30/${FIVE_MIN_TS}.parquet`, 'lake key layout');
}

// ---------------------------------------------------------------------------
// Cases (consumed by tests/connectors/huawei.test.ts)
// ---------------------------------------------------------------------------

export const HUAWEI_CASES: Array<[string, () => Promise<void>]> = [
  ['staticFieldMappings reference only valid DataFieldType members', testFieldMappingsValidity],
  ['login + stations + getDevList', testLoginAndDiscovery],
  ['getDevFiveMinutes backfill', testBackfill],
  ['getDevRealKpi realtime', testRealtime],
  ['failCode 407 rate limit → backoff + retry once', testRateLimitRetry],
  ['failCode 305 → relogin + retry with new token', testReloginOn305],
  ['legacy getStationList fallback flag', testLegacyStationList],
  ['ParquetLakeWriter buffer encoding', testParquetBuffer],
];

// Standalone debug runner: npx tsx scripts/test_huawei_connector.ts
if (process.argv[1] && /test_huawei_connector/.test(process.argv[1])) {
  (async () => {
    let failed = 0;
    console.log('Huawei FusionSolar connector tests');
    for (const [name, fn] of HUAWEI_CASES) {
      try {
        await fn();
        console.log(`  ok    ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`  FAIL  ${name}: ${(error as Error).message}`);
      }
    }
    if (failed > 0) process.exit(1);
  })();
}
