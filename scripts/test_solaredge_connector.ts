/**
 * Standalone test script for the SolarEdge monitoring cloud connector.
 * No test framework — run with:  npx tsx scripts/test_solaredge_connector.ts
 * Exits non-zero on any failure.
 *
 * Covers:
 *   - api_key auth (query param on every call, HTTP 403 → SolarEdgeAuthError)
 *   - /sites/list pagination (startIndex) → NormalizedPlant
 *   - /site/{id}/details for site-scoped keys
 *   - /site/{id}/inventory (inverters + meters + gateways) → NormalizedDevice
 *   - /equipment/{siteId}/{sn}/data telemetry normalization (site-local time,
 *     W→kW scaling) incl. one-week window chunking
 *   - backfill day windows in the site's local timezone
 *   - HTTP 429 rate limit → backoff + single retry → SolarEdgeRateLimitError
 *   - pollRealtime: site power/energy + trailing inverter telemetry
 *   - staticFieldMappings reference only valid DataFieldType members
 *   - discovery persistence shape (FieldMapping rows, device-inventory
 *     round-trip through DiscoveredPlant.metadata JSON)
 *   - ParquetLakeWriter buffer encoding (PAR1 magic)
 */
import { DataFieldType } from '@prisma/client';
import {
  SolarEdgeMonitoringService,
  SolarEdgeAuthError,
  SolarEdgeRateLimitError,
  SOLAREDGE_STATIC_FIELD_MAPPINGS,
} from '../src/lib/services/solaredge-api-service';
import type { NormalizedDevice } from '../src/lib/services/cloud-connector';
import { ParquetLakeWriter } from '../src/lib/services/s3-storage';

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

// check() throws on failure so every case doubles as a vitest test
// (tests/connectors/solaredge.test.ts) and a standalone tsx debug run.
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
  params: Record<string, string>;
}

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_name: string): string | null => null },
    json: async () => body,
  };
}

/**
 * Builds a mock fetch that dispatches on the URL path. Handlers can be arrays
 * (consumed in order) to script multi-call sequences (429 retry, pagination).
 */
function buildMockFetch(handlers: Record<string, Array<(call: RecordedCall) => any>>) {
  const calls: RecordedCall[] = [];
  const mockFetch = async (url: string) => {
    const parsed = new URL(url);
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    const call: RecordedCall = { path: parsed.pathname, params };
    calls.push(call);
    const queue = handlers[parsed.pathname];
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected call to ${parsed.pathname}`);
    }
    const handler = queue.length > 1 ? queue.shift()! : queue[0];
    return handler(call);
  };
  return { mockFetch, calls };
}

function makeService(handlers: Record<string, Array<(call: RecordedCall) => any>>, extra: any = {}) {
  const { mockFetch, calls } = buildMockFetch(handlers);
  const service = new SolarEdgeMonitoringService({
    baseUrl: 'https://test.monitoringapi.example',
    credentials: { apiKey: 'se-key-1' },
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
// Both sites sit in Europe/Madrid (CEST in June, UTC+2): SolarEdge start/end
// params and response timestamps are expressed in the site's local timezone.

const SITE_1 = {
  id: 1234567,
  name: 'Finca Uno',
  accountId: 7,
  status: 'Active',
  peakPower: 9987.5, // kWp
  installationDate: '2021-05-11',
  location: {
    country: 'Spain',
    city: 'Region A',
    address: 'Ctra. A-4 km 12',
    zip: '41000',
    timeZone: 'Europe/Madrid',
    latitude: 37.5,
    longitude: -6,
  },
};

const SITE_2 = {
  id: 2345678,
  name: 'Rooftop Dos',
  peakPower: 450, // kWp
  location: {
    country: 'Spain',
    city: 'Valencia',
    timeZone: 'Europe/Madrid',
    latitude: '39.47', // SolarEdge sometimes returns strings
    longitude: '-0.38',
  },
};

const SITES_MAIN = jsonResponse({
  sites: { count: 2, site: [SITE_1, SITE_2] },
});

const INVENTORY_SITE_1 = jsonResponse({
  Inventory: {
    inverters: [
      { SN: 'SE-INV-0001', name: 'Inverter 1', manufacturer: 'SolarEdge', model: 'SE100K', connectedOptimizers: 244 },
      { SN: 'SE-INV-0002', name: 'Inverter 2', manufacturer: 'SolarEdge', model: 'SE100K', connectedOptimizers: 240 },
    ],
    meters: [
      { name: 'Production Meter', manufacturer: 'SolarEdge', model: 'SE-MTR-3Y', SN: 'SE-MTR-01', type: 'Production' },
    ],
    batteries: [],
    gateways: [{ name: 'GW 1', SN: 'SE-GW-01' }],
    sensors: [],
  },
});

// 2026-06-30 10:00 Europe/Madrid == 08:00 UTC
const TELEM_TS_UTC = Date.UTC(2026, 5, 30, 8, 0, 0);

const EQUIPMENT_DATA_INV1 = jsonResponse({
  data: {
    count: 2,
    telemetries: [
      {
        date: '2026-06-30 10:00:00',
        totalActivePower: 82_400, // W
        dcVoltage: 745.2,
        temperature: 51.3, // internal C
        totalEnergy: 190_442_700, // Wh lifetime
        groundFaultResistance: 12_000, // intentionally unmapped
        L1Data: { acVoltage: 231.2, acCurrent: 118.4, acFrequency: 49.98, activePower: 27_500 },
        L2Data: { acVoltage: 232.0, acCurrent: 117.9 },
        L3Data: { acVoltage: 230.8, acCurrent: 118.1 },
      },
      {
        date: '2026-06-30 10:05:00',
        totalActivePower: 83_100,
        temperature: 51.8,
      },
    ],
  },
});

const EQUIPMENT_DATA_EMPTY = jsonResponse({ data: { count: 0, telemetries: [] } });

const SITE_POWER = jsonResponse({
  power: {
    timeUnit: 'QUARTER_OF_AN_HOUR',
    unit: 'W',
    measuredBy: 'INVERTER',
    values: [
      { date: '2026-06-30 10:00:00', value: 152_000 },
      { date: '2026-06-30 10:15:00', value: null }, // null-padded future slot
    ],
  },
});

const SITE_ENERGY_DAY = jsonResponse({
  energy: {
    timeUnit: 'DAY',
    unit: 'Wh',
    values: [{ date: '2026-06-30 00:00:00', value: 505_300 }],
  },
});

const RATE_LIMITED = jsonResponse({ String: 'rate limit exceeded' }, 429);
const FORBIDDEN = jsonResponse({ String: 'Invalid token' }, 403);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFieldMappingsValidity() {
  section('staticFieldMappings reference only valid DataFieldType members');
  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(validMembers.size > 50, `DataFieldType enum loaded (${validMembers.size} members)`);

  const seen = new Set<string>();
  for (const mapping of SOLAREDGE_STATIC_FIELD_MAPPINGS) {
    check(
      validMembers.has(mapping.mapped_field),
      `'${mapping.original_field}' → '${mapping.mapped_field}' is a valid DataFieldType`
    );
    check(!seen.has(mapping.original_field), `'${mapping.original_field}' is unique`);
    seen.add(mapping.original_field);
  }

  // Spot-check the W→kW / Wh→kWh convention (Huawei mappings store kW/kWh;
  // SolarEdge reports W/Wh, so these must carry scaling 0.001).
  const index = new Map(SOLAREDGE_STATIC_FIELD_MAPPINGS.map(m => [m.original_field, m]));
  checkEqual(index.get('inverter.totalActivePower')?.mapped_field, 'power_ac', 'totalActivePower → power_ac');
  checkEqual(index.get('inverter.totalActivePower')?.scaling_factor, 0.001, 'totalActivePower W→kW scaling 0.001');
  checkEqual(index.get('inverter.dcVoltage')?.mapped_field, 'voltage_dc', 'dcVoltage → voltage_dc');
  checkEqual(index.get('inverter.temperature')?.mapped_field, 'temp_inverter', 'inverter temperature → temp_inverter');
  checkEqual(index.get('site.energy')?.mapped_field, 'energy_daily', 'site.energy → energy_daily');
  checkEqual(index.get('site.energy')?.scaling_factor, 0.001, 'site.energy Wh→kWh scaling 0.001');
  checkEqual(index.get('site.power')?.scaling_factor, 0.001, 'site.power W→kW scaling 0.001');
}

async function testAuth() {
  section('api_key auth + 403 → SolarEdgeAuthError');
  const { service, calls } = makeService({
    '/sites/list': [() => SITES_MAIN],
  });
  await service.authenticate();
  checkEqual(calls.length, 1, 'authenticate() makes one verification call');
  checkEqual(calls[0].params.api_key, 'se-key-1', 'api_key rides as a query param');
  await service.authenticate();
  checkEqual(calls.length, 1, 'authenticate() is idempotent (no second call)');

  const { service: badKeyService } = makeService({
    '/sites/list': [() => FORBIDDEN],
  });
  let thrown: unknown = null;
  try {
    await badKeyService.authenticate();
  } catch (error) {
    thrown = error;
  }
  check(thrown !== null, 'invalid key throws');
  check(thrown instanceof SolarEdgeAuthError, 'error is a SolarEdgeAuthError');
  checkEqual((thrown as SolarEdgeAuthError).status, 403, 'auth error carries HTTP status 403');
  check(String(thrown).includes('api_key'), 'auth error message mentions api_key');
}

async function testSitesPagination() {
  section('/sites/list pagination (startIndex)');
  const makeSites = (from: number, n: number) =>
    Array.from({ length: n }, (_: unknown, i: number) => ({
      id: from + i,
      name: `S${from + i}`,
      peakPower: 100,
      location: { country: 'Spain', timeZone: 'Europe/Madrid' },
    }));

  const { service, calls } = makeService({
    '/sites/list': [
      () => jsonResponse({ sites: { count: 150, site: makeSites(0, 100) } }),
      () => jsonResponse({ sites: { count: 150, site: makeSites(100, 50) } }),
    ],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 150, 'all 150 sites collected across pages');
  checkEqual(calls.length, 2, 'two pages fetched');
  checkEqual(calls[0].params.startIndex, '0', 'first page startIndex=0');
  checkEqual(calls[0].params.size, '100', 'page size 100');
  checkEqual(calls[1].params.startIndex, '100', 'second page startIndex=100');
}

async function testDiscoveryNormalization() {
  section('site + inventory normalization');
  const { service, calls } = makeService({
    '/sites/list': [() => SITES_MAIN],
    '/site/1234567/inventory': [() => INVENTORY_SITE_1],
    '/site/2345678/inventory': [
      () =>
        jsonResponse({
          Inventory: {
            inverters: [{ SN: 'SE-INV-0003', name: 'Inverter 3', manufacturer: 'SolarEdge', model: 'SE33.3K' }],
            meters: [],
            batteries: [],
            gateways: [],
            sensors: [],
          },
        }),
    ],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 2, 'two sites discovered');
  checkEqual(plants[0].external_plant_id, '1234567', 'site id mapped to external_plant_id');
  checkEqual(plants[0].name, 'Finca Uno', 'site name mapped');
  checkEqual(plants[0].capacity_mw, 9.9875, 'peakPower kWp → capacity MW (/1000)');
  checkEqual(plants[0].location?.lat, 37.39, 'latitude mapped');
  checkEqual(plants[0].location?.country, 'Spain', 'country mapped from location');
  checkEqual(plants[0].timezone, 'Europe/Madrid', 'site timezone captured');
  checkEqual(plants[0].commissioning_date, '2021-05-11', 'installationDate → commissioning_date');
  checkEqual(plants[1].location?.lat, 39.47, 'string latitude coerced to number');

  const devices = await service.discoverDevices(plants.map(p => p.external_plant_id));
  checkEqual(devices.length, 5, 'five devices discovered across both sites');
  const inv = devices.find(d => d.external_device_id === 'SE-INV-0001')!;
  checkEqual(inv.device_type, 'string_inverter', 'inventory inverters → string_inverter');
  checkEqual(inv.model, 'SE100K', 'model mapped');
  checkEqual(inv.serial, 'SE-INV-0001', 'SN → serial');
  checkEqual(inv.external_plant_id, '1234567', 'inverter attached to its site');
  checkEqual(inv.metadata?.site_time_zone, 'Europe/Madrid', 'site timezone carried on device metadata');
  const meter = devices.find(d => d.external_device_id === 'SE-MTR-01')!;
  checkEqual(meter.device_type, 'power_sensor', 'meters → power_sensor');
  const gateway = devices.find(d => d.external_device_id === 'SE-GW-01')!;
  checkEqual(gateway.device_type, 'logger', 'gateways → logger');

  const inventoryCalls = calls.filter(c => c.path.endsWith('/inventory'));
  checkEqual(inventoryCalls.length, 2, 'one inventory call per site');
}

async function testSiteScopedKey() {
  section('site-level key (config site_id) uses /site/{id}/details');
  const { service, calls } = makeService(
    {
      '/site/1234567/details': [() => jsonResponse({ details: SITE_1 })],
    },
    { siteId: '1234567' }
  );

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 1, 'pinned site returned');
  checkEqual(plants[0].external_plant_id, '1234567', 'details payload normalized');
  check(!calls.some(c => c.path === '/sites/list'), '/sites/list never called with a site-scoped key');
}

async function testEquipmentDataParse() {
  section('/equipment data parse (site-local time, W→kW)');
  const { service } = makeService({
    '/sites/list': [() => SITES_MAIN],
    '/site/1234567/inventory': [() => INVENTORY_SITE_1],
    '/equipment/1234567/SE-INV-0001/data': [() => EQUIPMENT_DATA_INV1],
  });

  await service.discoverPlants();
  await service.discoverDevices(['1234567']);

  const readings = await service.fetchEquipmentData(
    '1234567',
    'SE-INV-0001',
    TELEM_TS_UTC,
    TELEM_TS_UTC + 60 * 60 * 1000
  );

  const power = readings.filter(r => r.metric === 'power_ac');
  checkEqual(power.length, 2, 'two power_ac points from two telemetry rows');
  checkEqual(power[0].value, 82.4, 'totalActivePower 82400 W → 82.4 kW');
  checkEqual(power[0].unit, 'kW', 'power unit is kW after scaling');
  checkEqual(power[0].ts, TELEM_TS_UTC, 'site-local "10:00" (Europe/Madrid) → 08:00 UTC epoch');
  checkEqual(power[0].plant_ext_id, '1234567', 'plant resolved from device registry');
  checkEqual(power[0].device_type, 'string_inverter', 'device_type carried through');

  const dcVoltage = readings.find(r => r.metric === 'voltage_dc');
  checkEqual(dcVoltage?.value, 745.2, 'dcVoltage unscaled (V)');
  const temp = readings.find(r => r.metric === 'temp_inverter');
  checkEqual(temp?.value, 51.3, "inverter 'temperature' → temp_inverter");
  const totalEnergy = readings.find(r => r.metric === 'energy_total');
  checkEqual(totalEnergy?.value, 190_442.7, 'totalEnergy Wh → kWh');
  const l1Voltage = readings.find(r => r.metric === 'voltage_ac_l1');
  checkEqual(l1Voltage?.value, 231.2, 'nested L1Data.acVoltage → voltage_ac_l1');
  const l3Current = readings.find(r => r.metric === 'current_ac_l3');
  checkEqual(l3Current?.value, 118.1, 'nested L3Data.acCurrent → current_ac_l3');
  const frequency = readings.find(r => r.metric === 'frequency');
  checkEqual(frequency?.value, 49.98, 'L1Data.acFrequency → frequency');

  // groundFaultResistance / per-phase activePower have no DataFieldType — dropped
  check(
    !readings.some(r => r.value === 12_000 || r.value === 27_500 || r.value === 27.5),
    'unmapped keys (groundFaultResistance, LxData.activePower) dropped'
  );

  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(
    readings.every(r => validMembers.has(r.metric)),
    'all equipment reading metrics are valid DataFieldType members'
  );
}

async function testWeekWindowChunking() {
  section('equipment data range chunked into ≤ one-week windows');
  const { service, calls } = makeService({
    '/equipment/1234567/SE-INV-0001/data': [
      () => EQUIPMENT_DATA_EMPTY,
      () => EQUIPMENT_DATA_EMPTY,
    ],
  });
  service.setDeviceInventory([
    {
      external_device_id: 'SE-INV-0001',
      external_plant_id: '1234567',
      device_type: 'string_inverter',
      serial: 'SE-INV-0001',
      metadata: { site_time_zone: 'UTC' },
    },
  ]);

  // 10 days — must split into a 7-day window plus a 3-day remainder.
  await service.fetchEquipmentData(
    '1234567',
    'SE-INV-0001',
    Date.UTC(2026, 5, 1),
    Date.UTC(2026, 5, 11)
  );

  const dataCalls = calls.filter(c => c.path === '/equipment/1234567/SE-INV-0001/data');
  checkEqual(dataCalls.length, 2, 'ten-day range split into two calls');
  checkEqual(dataCalls[0].params.startTime, '2026-06-01 00:00:00', 'window 1 start (site-local format)');
  checkEqual(dataCalls[0].params.endTime, '2026-06-08 00:00:00', 'window 1 end = start + 7 days');
  checkEqual(dataCalls[1].params.startTime, '2026-06-08 00:00:00', 'window 2 starts where window 1 ended');
  checkEqual(dataCalls[1].params.endTime, '2026-06-11 00:00:00', 'window 2 end = range end');
}

async function testBackfill() {
  section('backfill fetches one site-local day per inverter');
  const { service, calls } = makeService({
    '/sites/list': [() => SITES_MAIN],
    '/site/1234567/inventory': [() => INVENTORY_SITE_1],
    '/equipment/1234567/SE-INV-0001/data': [() => EQUIPMENT_DATA_INV1],
    '/equipment/1234567/SE-INV-0002/data': [() => EQUIPMENT_DATA_EMPTY],
  });

  await service.discoverPlants();
  await service.discoverDevices(['1234567']);

  const readings = await service.backfill(
    ['SE-INV-0001', 'SE-INV-0002'],
    new Date(Date.UTC(2026, 5, 30))
  );

  const dataCalls = calls.filter(c => c.path.startsWith('/equipment/'));
  checkEqual(dataCalls.length, 2, 'one equipment call per inverter');
  checkEqual(dataCalls[0].params.startTime, '2026-06-30 00:00:00', 'day window starts at site-local midnight');
  checkEqual(dataCalls[0].params.endTime, '2026-06-30 23:59:59', 'day window ends at site-local 23:59:59');
  check(
    !dataCalls.some(c => c.path.includes('SE-MTR-01') || c.path.includes('SE-GW-01')),
    'non-pollable devices (meter, gateway) excluded from backfill'
  );
  check(readings.some(r => r.metric === 'power_ac' && r.value === 82.4), 'backfill readings normalized');
}

async function testRateLimitRetry() {
  section('HTTP 429 → backoff + retry once');
  const { service, calls } = makeService({
    '/sites/list': [
      () => RATE_LIMITED, // first attempt rate-limited
      () => SITES_MAIN, // retry succeeds
    ],
  });

  const plants = await service.discoverPlants();
  checkEqual(plants.length, 2, 'sites list succeeds after 429 retry');
  const listCalls = calls.filter(c => c.path === '/sites/list');
  checkEqual(listCalls.length, 2, 'exactly one retry after 429');

  // A second consecutive 429 must throw a typed error (single retry only)
  const { service: service2 } = makeService({
    '/sites/list': [() => RATE_LIMITED, () => RATE_LIMITED],
  });
  let thrown: unknown = null;
  try {
    await service2.discoverPlants();
  } catch (error) {
    thrown = error;
  }
  check(thrown !== null, 'double 429 throws instead of retrying forever');
  check(thrown instanceof SolarEdgeRateLimitError, 'error is a SolarEdgeRateLimitError');
  check(String(thrown).includes('429'), 'rate-limit error mentions HTTP 429');
}

async function testRealtime() {
  section('pollRealtime: site power/energy + trailing inverter telemetry');
  const { service, calls } = makeService({
    '/sites/list': [() => SITES_MAIN],
    '/site/1234567/inventory': [() => INVENTORY_SITE_1],
    '/site/1234567/power': [() => SITE_POWER],
    '/site/1234567/energy': [() => SITE_ENERGY_DAY],
    '/equipment/1234567/SE-INV-0001/data': [() => EQUIPMENT_DATA_INV1],
    '/equipment/1234567/SE-INV-0002/data': [() => EQUIPMENT_DATA_EMPTY],
  });

  await service.discoverPlants();
  await service.discoverDevices(['1234567']);

  const before = Date.now();
  const readings = await service.pollRealtime();
  const after = Date.now();

  const powerCalls = calls.filter(c => c.path === '/site/1234567/power');
  checkEqual(powerCalls.length, 1, 'one site power call per site');
  check(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(powerCalls[0].params.startTime ?? ''),
    'site power startTime formatted as site-local "YYYY-MM-DD HH:MM:SS"'
  );

  const energyCalls = calls.filter(c => c.path === '/site/1234567/energy');
  checkEqual(energyCalls.length, 1, 'one site energy call per site');
  checkEqual(energyCalls[0].params.timeUnit, 'DAY', 'site energy fetched with timeUnit=DAY');
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(energyCalls[0].params.startDate ?? '') &&
      energyCalls[0].params.startDate === energyCalls[0].params.endDate,
    'site energy startDate=endDate=today (site-local date)'
  );

  const equipmentCalls = calls.filter(c => c.path.startsWith('/equipment/'));
  checkEqual(equipmentCalls.length, 2, 'one trailing telemetry call per inverter');
  check(
    !equipmentCalls.some(c => c.path.includes('SE-MTR-01') || c.path.includes('SE-GW-01')),
    'non-pollable devices (meter, gateway) excluded from realtime'
  );

  const sitePower = readings.filter(r => r.device_ext_id === '1234567' && r.metric === 'power_ac');
  checkEqual(sitePower.length, 1, 'null-padded power slots dropped');
  checkEqual(sitePower[0].value, 152, 'site power 152000 W → 152 kW');
  checkEqual(sitePower[0].device_type, 'site', 'site-level readings tagged device_type=site');
  checkEqual(sitePower[0].ts, TELEM_TS_UTC, 'site power timestamp parsed in site-local time');

  const siteEnergy = readings.find(r => r.device_ext_id === '1234567' && r.metric === 'energy_daily');
  checkEqual(siteEnergy?.value, 505.3, 'site energy 505300 Wh → 505.3 kWh (energy_daily)');
  check(
    (siteEnergy?.ts ?? 0) >= before && (siteEnergy?.ts ?? 0) <= after,
    'daily-energy reading stamped with poll time'
  );

  const invPower = readings.find(r => r.device_ext_id === 'SE-INV-0001' && r.metric === 'power_ac');
  checkEqual(invPower?.value, 82.4, 'per-inverter realtime telemetry normalized');

  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  check(
    readings.every(r => validMembers.has(r.metric)),
    'all realtime reading metrics are valid DataFieldType members'
  );
}

async function testDiscoveryPersistenceShape() {
  section('discovery persistence shape (FieldMapping rows + inventory round-trip)');
  const { service } = makeService({
    '/sites/list': [() => SITES_MAIN],
    '/site/1234567/inventory': [() => INVENTORY_SITE_1],
  });
  await service.discoverPlants();
  const devices = await service.discoverDevices(['1234567']);

  // FieldMapping.createMany payload as built by discoverSolarEdge() in
  // src/app/api/connections/[connectionId]/discover/route.ts
  const validMembers = new Set(Object.values(DataFieldType) as string[]);
  const rows = service.staticFieldMappings().map(m => ({
    connection_id: 'conn-se-1',
    original_field: m.original_field,
    mapped_field: m.mapped_field,
    unit: m.unit,
    scaling_factor: m.scaling_factor ?? 1.0,
    confidence_score: 1.0,
    is_confirmed: true,
  }));
  check(rows.length === SOLAREDGE_STATIC_FIELD_MAPPINGS.length, 'one FieldMapping row per static mapping');
  check(rows.every(r => r.confidence_score === 1.0), 'all rows persisted with confidence_score 1.0');
  check(rows.every(r => r.is_confirmed === true), 'all rows persisted as is_confirmed');
  check(rows.every(r => validMembers.has(r.mapped_field)), 'all persisted mapped_field values are valid DataFieldType members');
  checkEqual(new Set(rows.map(r => r.original_field)).size, rows.length, 'original_field unique per connection (unique constraint safe)');

  // Inverter roll-up persisted on DiscoveredPlant
  const inverters = devices.filter(d => d.device_type === 'string_inverter');
  checkEqual(inverters.length, 2, 'inverter_count derived from device_type=string_inverter');

  // DiscoveredPlant.metadata.devices round-trip: the poll path restores the
  // inventory from JSON and must be able to poll without re-discovery.
  const restoredDevices = JSON.parse(JSON.stringify(devices)) as NormalizedDevice[];
  const { service: restored, calls: restoredCalls } = makeService({
    '/site/1234567/power': [() => SITE_POWER],
    '/site/1234567/energy': [() => SITE_ENERGY_DAY],
    '/equipment/1234567/SE-INV-0001/data': [() => EQUIPMENT_DATA_INV1],
    '/equipment/1234567/SE-INV-0002/data': [() => EQUIPMENT_DATA_EMPTY],
  });
  restored.setDeviceInventory(restoredDevices);
  const readings = await restored.pollRealtime();

  check(
    !restoredCalls.some(c => c.path === '/sites/list' || c.path.endsWith('/inventory')),
    'restored inventory polls without re-discovery calls'
  );
  const invPower = readings.find(r => r.device_ext_id === 'SE-INV-0001' && r.metric === 'power_ac');
  checkEqual(
    invPower?.ts,
    TELEM_TS_UTC,
    'restored metadata.site_time_zone still drives site-local time parsing'
  );
}

async function testParquetBuffer() {
  section('ParquetLakeWriter buffer encoding');
  const buffer = await ParquetLakeWriter.toParquetBuffer([
    {
      ts: TELEM_TS_UTC,
      plant_ext_id: '1234567',
      device_ext_id: 'SE-INV-0001',
      device_type: 'string_inverter',
      metric: 'power_ac',
      value: 82.4,
      unit: 'kW',
    },
    {
      ts: TELEM_TS_UTC,
      plant_ext_id: '1234567',
      device_ext_id: '1234567',
      device_type: 'site',
      metric: 'energy_daily',
      value: 505.3,
      // unit intentionally omitted — optional column
    },
  ]);
  check(buffer.length > 0, 'parquet buffer is non-empty');
  checkEqual(buffer.subarray(0, 4).toString('ascii'), 'PAR1', 'buffer starts with PAR1 magic');
  checkEqual(buffer.subarray(buffer.length - 4).toString('ascii'), 'PAR1', 'buffer ends with PAR1 magic');
}

// ---------------------------------------------------------------------------
// Cases (consumed by tests/connectors/solaredge.test.ts)
// ---------------------------------------------------------------------------

export const SOLAREDGE_CASES: Array<[string, () => Promise<void>]> = [
  ['staticFieldMappings reference only valid DataFieldType members', testFieldMappingsValidity],
  ['api_key auth + 403 → SolarEdgeAuthError', testAuth],
  ['/sites/list pagination (startIndex)', testSitesPagination],
  ['site + inventory normalization', testDiscoveryNormalization],
  ['site-scoped key uses /site/{id}/details', testSiteScopedKey],
  ['/equipment data parse (site-local time, W→kW)', testEquipmentDataParse],
  ['equipment range chunked into ≤ one-week windows', testWeekWindowChunking],
  ['backfill fetches one site-local day per inverter', testBackfill],
  ['HTTP 429 → backoff + retry once', testRateLimitRetry],
  ['pollRealtime: site power/energy + trailing inverter telemetry', testRealtime],
  ['discovery persistence shape (FieldMapping rows + inventory round-trip)', testDiscoveryPersistenceShape],
  ['ParquetLakeWriter buffer encoding', testParquetBuffer],
];

// Standalone debug runner: npx tsx scripts/test_solaredge_connector.ts
if (process.argv[1] && /test_solaredge_connector/.test(process.argv[1])) {
  (async () => {
    let failed = 0;
    console.log('SolarEdge monitoring connector tests');
    for (const [name, fn] of SOLAREDGE_CASES) {
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
