/**
 * Huawei FusionSolar ESS (devTypeId 39) connector contract tests.
 *
 * Drives the real HuaweiFusionSolarService through its injectable fetch seam
 * against recorded response fixtures — no network, no credentials, always green
 * in CI. Same shape as tests/connectors/huawei.test.ts; the PV cases stay in
 * scripts/test_huawei_connector.ts and are untouched.
 *
 * The load-bearing assertion here is the honesty one: no battery dataItemMap
 * key has been verified against Huawei's Northbound reference, so the static
 * mapping must contain zero battery entries and the observed keys must instead
 * be recorded for the field mapper.
 */
import { describe, it, expect } from 'vitest';
import { DataFieldType } from '@prisma/client';
import {
  HuaweiFusionSolarService,
  HUAWEI_BATTERY_CANDIDATE_KEYS,
  HUAWEI_BATTERY_DEV_TYPE_ID,
  HUAWEI_DEV_TYPE_MAP,
  HUAWEI_ESS_DEV_TYPE_ID,
  HUAWEI_POLLABLE_DEV_TYPE_IDS,
  HUAWEI_STATIC_FIELD_MAPPINGS,
  HUAWEI_STORAGE_DEV_TYPE_IDS,
  isHuaweiStorageDevTypeId,
} from '../../src/lib/services/huawei-api-service';
import { parseBessDeviceId } from '../../src/lib/services/cloud-connector';

// ---------------------------------------------------------------------------
// Mock fetch (mirrors scripts/test_huawei_connector.ts)
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

function makeService(handlers: Record<string, Array<(call: RecordedCall) => any>>) {
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
    if (!queue || queue.length === 0) throw new Error(`Unexpected call to ${path}`);
    const handler = queue.length > 1 ? queue.shift()! : queue[0];
    return handler(call);
  };
  const service = new HuaweiFusionSolarService({
    // Unique baseUrl per test so the module-level token cache never leaks.
    baseUrl: `https://test-${Math.random().toString(36).slice(2)}.fusionsolar.example`,
    credentials: { userName: 'nb-user', systemCode: 'nb-code' },
    fetchImpl: mockFetch as any,
    interCallDelayMs: 0,
    rateLimitBackoffMs: 5,
  });
  return { service, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_OK = () => jsonResponse({ success: true, failCode: 0, data: null }, { 'xsrf-token': 'tok-1' });

const STATIONS = jsonResponse({
  success: true,
  failCode: 0,
  data: {
    total: 1,
    pageCount: 1,
    pageNo: 1,
    pageSize: 100,
    list: [{ plantCode: 'NE=55555555', plantName: 'Hybrid One', capacity: 5.0 }],
  },
});

const DEV_LIST = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      id: 2000001,
      devDn: 'NE=2000001',
      devName: 'INV-01',
      devTypeId: 1,
      esnCode: 'SN-INV-01',
      stationCode: 'NE=55555555',
      invType: 'SUN2000-100KTL-M1',
    },
    {
      id: 2000002,
      devDn: 'NE=2000002',
      devName: 'ESS.01',
      devTypeId: 39,
      esnCode: 'SN-ESS-01',
      stationCode: 'NE=55555555',
    },
    {
      id: 2000003,
      devDn: 'NE=2000003',
      devName: 'String ESS 02',
      devTypeId: 41,
      esnCode: 'SN-ESS-02',
      stationCode: 'NE=55555555',
    },
  ],
});

const REAL_KPI_INVERTER = jsonResponse({
  success: true,
  failCode: 0,
  data: [{ devId: 2000001, dataItemMap: { active_power: 71.2, temperature: 47.5 } }],
});

/**
 * Battery realtime row. The keys below are PLACEHOLDER names, not claimed
 * FusionSolar keys — the point of this fixture is to prove that unverified
 * battery keys are recorded rather than mapped. Replace with the real payload
 * the first time an ESS account is available.
 */
const REAL_KPI_BATTERY = jsonResponse({
  success: true,
  failCode: 0,
  data: [
    {
      devId: 2000002,
      dataItemMap: {
        unverified_soc_key: 62.5,
        unverified_charge_power_key: -18.4,
      },
    },
  ],
});

/** Same story for the ESS device type: placeholder keys, never claimed names. */
const REAL_KPI_ESS = jsonResponse({
  success: true,
  failCode: 0,
  data: [{ devId: 2000003, dataItemMap: { unverified_ess_soc_key: 44.0 } }],
});

function batteryHandlers() {
  return {
    '/thirdData/login': [LOGIN_OK],
    '/thirdData/stations': [() => STATIONS],
    '/thirdData/getDevList': [() => DEV_LIST],
    '/thirdData/getDevRealKpi': [
      (call: RecordedCall) => {
        const devTypeId = Number(call.body.devTypeId);
        if (devTypeId === HUAWEI_BATTERY_DEV_TYPE_ID) return REAL_KPI_BATTERY;
        if (devTypeId === HUAWEI_ESS_DEV_TYPE_ID) return REAL_KPI_ESS;
        return REAL_KPI_INVERTER;
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Huawei FusionSolar storage (devTypeId 39 battery, 41 ESS)', () => {
  it('treats both storage device types as pollable batteries', () => {
    expect(HUAWEI_BATTERY_DEV_TYPE_ID).toBe(39);
    expect(HUAWEI_ESS_DEV_TYPE_ID).toBe(41);
    expect(HUAWEI_STORAGE_DEV_TYPE_IDS).toEqual([39, 41]);

    for (const devTypeId of HUAWEI_STORAGE_DEV_TYPE_IDS) {
      expect(HUAWEI_DEV_TYPE_MAP[devTypeId]).toBe('battery');
      expect(HUAWEI_POLLABLE_DEV_TYPE_IDS).toContain(devTypeId);
      expect(isHuaweiStorageDevTypeId(devTypeId)).toBe(true);
    }
    // PV device types must still be pollable, and must not read as storage.
    for (const devTypeId of [1, 38, 10]) {
      expect(HUAWEI_POLLABLE_DEV_TYPE_IDS).toContain(devTypeId);
      expect(isHuaweiStorageDevTypeId(devTypeId)).toBe(false);
    }
  });

  it('ships no unverified battery key in the active static mapping', () => {
    const batteryScoped = HUAWEI_STATIC_FIELD_MAPPINGS.filter(m =>
      m.original_field.startsWith('battery.')
    );
    expect(batteryScoped).toEqual([]);
  });

  it('targets real DataFieldType slots in the unverified candidate list', () => {
    const validMembers = new Set(Object.values(DataFieldType) as string[]);
    expect(HUAWEI_BATTERY_CANDIDATE_KEYS.length).toBeGreaterThan(0);
    for (const candidate of HUAWEI_BATTERY_CANDIDATE_KEYS) {
      expect(validMembers.has(candidate.mapped_field)).toBe(true);
      expect(candidate.mapped_field.startsWith('bess_')).toBe(true);
    }
  });

  it('gives battery devices a canonical BESS device_ext_id', async () => {
    const { service } = makeService(batteryHandlers());
    await service.discoverPlants();
    const devices = await service.discoverDevices(['NE=55555555']);

    const battery = devices.find(d => d.vendor_type_id === 39)!;
    expect(battery.device_type).toBe('battery');
    // Data calls still address the vendor numeric id.
    expect(battery.external_device_id).toBe('2000002');
    expect(battery.metadata?.vendor_device_id).toBe('2000002');

    const canonical = String(battery.metadata?.canonical_device_id);
    // '.' is the grain separator, so 'ESS.01' has to be sanitized.
    expect(canonical).toBe('BESS ESS-01');
    const parsed = parseBessDeviceId(canonical);
    expect(parsed?.grain).toBe('asset');
    expect(parsed?.asset).toBe('ESS-01');
    expect(battery.metadata?.bess_grain).toBe('asset');

    // devTypeId 41 gets the identical treatment.
    const ess = devices.find(d => d.vendor_type_id === 41)!;
    expect(ess.device_type).toBe('battery');
    expect(ess.external_device_id).toBe('2000003');
    expect(ess.metadata?.canonical_device_id).toBe('BESS String ESS 02');
    expect(ess.metadata?.bess_grain).toBe('asset');

    // PV devices are untouched.
    const inverter = devices.find(d => d.vendor_type_id === 1)!;
    expect(inverter.external_device_id).toBe('2000001');
    expect(inverter.metadata?.canonical_device_id).toBeUndefined();
  });

  it('polls both storage types and records their keys instead of guessing them', async () => {
    const { service, calls } = makeService(batteryHandlers());
    await service.discoverPlants();
    await service.discoverDevices(['NE=55555555']);

    const readings = await service.pollRealtime();

    const kpiCalls = calls.filter(c => c.path === '/thirdData/getDevRealKpi');
    const typeIds = kpiCalls.map(c => Number(c.body.devTypeId)).sort((a, b) => a - b);
    expect(typeIds).toEqual([1, 39, 41]);
    expect(String(kpiCalls.find(c => Number(c.body.devTypeId) === 39)!.body.devIds)).toBe('2000002');
    expect(String(kpiCalls.find(c => Number(c.body.devTypeId) === 41)!.body.devIds)).toBe('2000003');

    // No battery reading is emitted, because no battery key is verified. That
    // is the honest outcome: a fabricated mapping would emit a wrong number.
    expect(readings.some(r => r.device_type === 'battery')).toBe(false);

    // The PV path still produces readings.
    const power = readings.find(r => r.metric === 'power_ac');
    expect(power?.value).toBe(71.2);
    expect(power?.device_ext_id).toBe('2000001');

    const unmapped = service.getUnmappedKeys();
    const batteryKeys = unmapped.filter(k => k.scope === 'battery').map(k => k.key).sort();
    expect(batteryKeys).toEqual([
      'unverified_charge_power_key',
      'unverified_ess_soc_key',
      'unverified_soc_key',
    ]);
    const soc = unmapped.find(k => k.key === 'unverified_soc_key')!;
    expect(soc.scoped_field).toBe('battery.unverified_soc_key');
    expect(soc.sample_value).toBe(62.5);
    expect(soc.seen).toBe(1);
  });

  it('emits only valid DataFieldType metrics', async () => {
    const { service } = makeService(batteryHandlers());
    await service.discoverPlants();
    await service.discoverDevices(['NE=55555555']);
    const readings = await service.pollRealtime();

    const validMembers = new Set(Object.values(DataFieldType) as string[]);
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect(validMembers.has(reading.metric)).toBe(true);
    }
  });
});
