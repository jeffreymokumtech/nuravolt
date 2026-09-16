/**
 * Sungrow iSolarCloud connector contract tests.
 *
 * Drives the real SungrowISolarCloudService through its injectable fetch seam
 * against recorded response fixtures — no network, no credentials, always green
 * in CI. Same shape as tests/connectors/huawei-battery.test.ts.
 *
 * IMPORTANT: the connector has never run against a live iSolarCloud endpoint
 * (access needs a signed confidentiality agreement with Sungrow), so these
 * fixtures encode the *documented* envelope shape, not observed traffic. They
 * pin the connector's own contract — envelope handling, backoff, request budget,
 * canonical BESS ids, taxonomy safety — which is what we can honestly assert.
 * They are not evidence that the vendor's payloads look like this.
 */
import { describe, it, expect, vi } from 'vitest';
import { DataFieldType } from '@prisma/client';
import {
  SungrowISolarCloudService,
  SungrowAuthError,
  SungrowRateLimitError,
  SungrowRequestBudgetError,
  SUNGROW_GATEWAYS,
  filterValidPointMappings,
  formatSungrowTimestamp,
  parseSungrowPointMap,
  parseSungrowTimestamp,
  resolveSungrowCredentials,
} from '../../src/lib/services/sungrow-api-service';
import type { SungrowServiceOptions } from '../../src/lib/services/sungrow-api-service';
import { parseBessDeviceId } from '../../src/lib/services/cloud-connector';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  body: Record<string, any>;
  headers: Record<string, string>;
}

function envelope(resultData: any, resultCode = '1', resultMsg = 'success') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      req_serial_num: 'test-serial',
      result_code: resultCode,
      result_msg: resultMsg,
      result_data: resultData,
    }),
  };
}

function httpStatus(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
  };
}

/**
 * Handlers are keyed by path. A queue with more than one entry is consumed one
 * per call (so retry behaviour can be scripted); a single entry is reused.
 */
function makeService(
  handlers: Record<string, Array<(call: RecordedCall) => any>>,
  options: SungrowServiceOptions = {}
) {
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

  const service = new SungrowISolarCloudService({
    credentials: {
      appkey: 'test-appkey',
      accessKey: 'test-access-key',
      userAccount: 'ops@example.com',
      userPassword: 'secret',
    },
    fetchImpl: mockFetch as any,
    interCallDelayMs: 0,
    backoffBaseMs: 1,
    ...options,
  });
  return { service, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_OK = () => envelope({ token: 'tok-abc' });

const STATION_LIST = () =>
  envelope({
    pageList: [
      {
        ps_id: 1101,
        ps_name: 'Athi Hybrid',
        ps_key: '1101_1_1_1',
        design_capacity: 4500, // kW
        ps_latitude: -1.5,
        ps_longitude: 37,
        ps_location: 'Machakos',
        ps_timezone_id: 'Africa/Nairobi',
      },
    ],
  });

const DEVICE_LIST = () =>
  envelope({
    pageList: [
      {
        ps_id: 1101,
        ps_key: '1101_1_1_1',
        device_type: 1,
        device_name: 'INV-01',
        device_model: 'SG110CX',
        device_sn: 'SN-INV-01',
      },
      {
        ps_id: 1101,
        ps_key: '1101_43_2_1',
        device_type: 43,
        device_name: 'ESS.A',
        device_model: 'ST2752UX',
        device_sn: 'SN-ESS-A',
      },
      {
        ps_id: 1101,
        ps_key: '1101_99_3_1',
        device_type: 99,
        device_name: 'Mystery box',
      },
    ],
  });

/**
 * Point ids below are PLACEHOLDERS chosen for the test, not claimed iSolarCloud
 * point ids — the catalogue is behind Sungrow's confidentiality agreement. The
 * connector never assumes a point id, which is exactly what these cases pin.
 */
const POINT_MAP: SungrowServiceOptions['pointMap'] = [
  { point_id: '10001', mapped_field: 'power_ac', unit: 'kW', scope: 'inverter' },
  { point_id: '10002', mapped_field: 'bess_soc', unit: '%', scope: 'battery' },
  { point_id: '10003', mapped_field: 'bess_power_charge', unit: 'kW', scope: 'battery' },
];

const REALTIME = () =>
  envelope({
    point_dict: [
      { point_id: '10001', point_name: 'Active power', point_unit: 'kW' },
      { point_id: '10002', point_name: 'SOC', point_unit: '%' },
      { point_id: '77777', point_name: 'Undocumented thing', point_unit: 'kvar' },
    ],
    device_point_list: [
      { ps_id: 1101, ps_key: '1101_1_1_1', p10001: '412.5' },
      { ps_id: 1101, ps_key: '1101_43_2_1', p10002: '61.5', p10003: '-95.25', p77777: '3.3' },
      // No device handle: a plant-grain rollup.
      { ps_id: 1101, p10001: '410.0' },
    ],
  });

const MINUTE_DATA = () =>
  envelope({
    point_dict: [{ point_id: '10002', point_name: 'SOC', point_unit: '%' }],
    '1101': [
      { time_stamp: '20260715000500', ps_key: '1101_43_2_1', p10002: '55.0' },
      { time_stamp: '20260715001000', ps_key: '1101_43_2_1', p10002: '56.5' },
    ],
  });

function fullHandlers() {
  return {
    '/openapi/login': [LOGIN_OK],
    '/openapi/platform/queryPowerStationList': [STATION_LIST],
    '/openapi/platform/getDeviceListByPsId': [DEVICE_LIST],
    '/openapi/platform/getPowerStationRealTimeData': [REALTIME],
    '/openapi/platform/getPowerStationPointMinuteDataList': [MINUTE_DATA],
  };
}

const DEVICE_TYPE_MAP = { '1': 'string_inverter', '43': 'battery' };

async function discovered(options: SungrowServiceOptions = {}) {
  const made = makeService(fullHandlers(), {
    pointMap: POINT_MAP,
    deviceTypeMap: DEVICE_TYPE_MAP,
    ...options,
  });
  await made.service.discoverPlants();
  await made.service.discoverDevices(['1101']);
  return made;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sungrow iSolarCloud connector (contract)', () => {
  it('logs in and carries the access key and appkey on every call', async () => {
    const { service, calls } = makeService(fullHandlers(), { pointMap: POINT_MAP });
    await service.authenticate();
    await service.discoverPlants();

    const login = calls.find(c => c.path === '/openapi/login')!;
    expect(login.headers['x-access-key']).toBe('test-access-key');
    expect(login.body.appkey).toBe('test-appkey');
    expect(login.body.user_account).toBe('ops@example.com');
    // The token is only known after login, so it must not be on the login body.
    expect(login.body.token).toBeUndefined();

    const list = calls.find(c => c.path === '/openapi/platform/queryPowerStationList')!;
    expect(list.headers['x-access-key']).toBe('test-access-key');
    expect(list.body.appkey).toBe('test-appkey');
    expect(list.body.token).toBe('tok-abc');
    // sys_code and lang are omitted unless configured, never defaulted.
    expect(list.body.sys_code).toBeUndefined();
    expect(list.body.lang).toBeUndefined();
  });

  it('skips login when a pre-issued token is supplied', async () => {
    const { service, calls } = makeService(fullHandlers(), {
      credentials: {
        appkey: 'test-appkey',
        accessKey: 'test-access-key',
        token: 'preissued',
      },
    });
    await service.discoverPlants();
    expect(calls.some(c => c.path === '/openapi/login')).toBe(false);
    expect(calls[0].body.token).toBe('preissued');
  });

  it('normalizes plants and converts capacity from kW to MW', async () => {
    const { service } = makeService(fullHandlers(), { pointMap: POINT_MAP });
    const plants = await service.discoverPlants();

    expect(plants).toHaveLength(1);
    expect(plants[0].external_plant_id).toBe('1101');
    expect(plants[0].name).toBe('Athi Hybrid');
    expect(plants[0].capacity_mw).toBe(4.5);
    expect(plants[0].metadata?.raw_capacity_kw).toBe(4500);
    expect(plants[0].location?.lat).toBe(-1.45);
    expect(plants[0].timezone).toBe('Africa/Nairobi');
  });

  it('classifies devices only through the operator device type map', async () => {
    const { service } = await discovered();
    const devices = service.getDeviceInventory();

    const inverter = devices.find(d => d.metadata?.vendor_device_id === '1101_1_1_1')!;
    expect(inverter.device_type).toBe('string_inverter');
    expect(inverter.external_device_id).toBe('1101_1_1_1');

    // An unmapped vendor code is never guessed at: it stays 'other' with the
    // raw code preserved for the wizard.
    const unknown = devices.find(d => d.metadata?.vendor_device_id === '1101_99_3_1')!;
    expect(unknown.device_type).toBe('other');
    expect(unknown.metadata?.vendor_device_type).toBe('99');
  });

  it('gives battery devices a canonical BESS device_ext_id', async () => {
    const { service } = await discovered();
    const battery = service
      .getDeviceInventory()
      .find(d => d.metadata?.vendor_device_id === '1101_43_2_1')!;

    expect(battery.device_type).toBe('battery');
    // '.' is the grain separator, so 'ESS.A' has to be sanitized.
    expect(battery.external_device_id).toBe('BESS ESS-A');
    expect(battery.metadata?.canonical_device_id).toBe('BESS ESS-A');
    expect(battery.metadata?.bess_grain).toBe('asset');

    const parsed = parseBessDeviceId(battery.external_device_id);
    expect(parsed?.grain).toBe('asset');
    expect(parsed?.asset).toBe('ESS-A');
  });

  it('honours an operator rack-grain BESS id override', async () => {
    const { service } = await discovered({
      bessDeviceIds: { '1101_43_2_1': 'BESS athi-1.U-1.R-4' },
    });
    const battery = service
      .getDeviceInventory()
      .find(d => d.metadata?.vendor_device_id === '1101_43_2_1')!;

    expect(battery.external_device_id).toBe('BESS athi-1.U-1.R-4');
    expect(battery.metadata?.bess_grain).toBe('rack');
  });

  it('ignores a malformed BESS id override rather than emitting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { service } = await discovered({
        bessDeviceIds: { '1101_43_2_1': 'not-a-canonical-id' },
      });
      const battery = service
        .getDeviceInventory()
        .find(d => d.metadata?.vendor_device_id === '1101_43_2_1')!;
      expect(battery.external_device_id).toBe('BESS ESS-A');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('emits realtime readings only for mapped points, keyed by canonical id', async () => {
    const { service, calls } = await discovered();
    const readings = await service.pollRealtime();

    const realtime = calls.find(
      c => c.path === '/openapi/platform/getPowerStationRealTimeData'
    )!;
    expect(realtime.body.ps_id_list).toEqual(['1101']);
    expect([...realtime.body.point_id_list].sort()).toEqual(['10001', '10002', '10003']);

    const power = readings.find(r => r.metric === 'power_ac' && r.device_ext_id === '1101_1_1_1')!;
    expect(power.value).toBe(412.5);
    expect(power.plant_ext_id).toBe('1101');
    expect(power.device_type).toBe('string_inverter');

    const soc = readings.find(r => r.metric === 'bess_soc')!;
    expect(soc.value).toBe(61.5);
    expect(soc.device_ext_id).toBe('BESS ESS-A');
    expect(soc.device_type).toBe('battery');

    const charge = readings.find(r => r.metric === 'bess_power_charge')!;
    expect(charge.value).toBe(-95.25);
    expect(charge.device_ext_id).toBe('BESS ESS-A');

    // A row with no device handle is a plant rollup, not an invented device.
    const rollup = readings.find(r => r.device_ext_id === 'PLANT')!;
    expect(rollup.metric).toBe('power_ac');
    expect(rollup.value).toBe(410);

    // p77777 has no operator mapping, so it produces no reading at all.
    expect(readings.some(r => r.value === 3.3)).toBe(false);
  });

  it('emits only valid DataFieldType metrics', async () => {
    const { service } = await discovered();
    const readings = [
      ...(await service.pollRealtime()),
      ...(await service.backfill(['BESS ESS-A'], new Date(Date.UTC(2026, 6, 15)))),
    ];

    const validMembers = new Set(Object.values(DataFieldType) as string[]);
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect(validMembers.has(reading.metric)).toBe(true);
    }
  });

  it('records unmapped points instead of guessing what they mean', async () => {
    const { service } = await discovered();
    await service.pollRealtime();

    const unmapped = service.getUnmappedPoints();
    const ids = unmapped.map(p => p.point_id).sort();
    expect(ids).toEqual(['77777']);
    expect(unmapped[0].point_name).toBe('Undocumented thing');
    expect(unmapped[0].point_unit).toBe('kvar');
  });

  it('backfills one calendar day of minute data', async () => {
    const { service, calls } = await discovered();
    const readings = await service.backfill(
      ['BESS ESS-A'],
      new Date(Date.UTC(2026, 6, 15, 9, 30))
    );

    const call = calls.find(
      c => c.path === '/openapi/platform/getPowerStationPointMinuteDataList'
    )!;
    expect(call.body.start_time_stamp).toBe('20260715000000');
    expect(call.body.end_time_stamp).toBe('20260715235959');
    expect(call.body.minute_interval).toBe(5);
    expect(call.body.ps_id_list).toEqual(['1101']);

    expect(readings).toHaveLength(2);
    expect(readings[0].metric).toBe('bess_soc');
    expect(readings[0].value).toBe(55);
    expect(readings[0].device_ext_id).toBe('BESS ESS-A');
    expect(readings[0].ts).toBe(Date.UTC(2026, 6, 15, 0, 5, 0));
  });

  it('makes no call at all when no point is mapped', async () => {
    const { service, calls } = makeService(fullHandlers(), {
      deviceTypeMap: DEVICE_TYPE_MAP,
    });
    await service.discoverPlants();
    await service.discoverDevices(['1101']);
    const before = calls.length;

    expect(await service.pollRealtime()).toEqual([]);
    expect(await service.backfill([], new Date())).toEqual([]);
    expect(calls.length).toBe(before);
  });

  it('retries a throttled call with backoff and then succeeds', async () => {
    const { service, calls } = makeService(
      {
        '/openapi/login': [LOGIN_OK],
        '/openapi/platform/queryPowerStationList': [
          () => httpStatus(429),
          () => envelope(null, '2', 'request too frequent'),
          STATION_LIST,
        ],
      },
      { pointMap: POINT_MAP }
    );

    const plants = await service.discoverPlants();
    expect(plants).toHaveLength(1);
    expect(calls.filter(c => c.path === '/openapi/platform/queryPowerStationList')).toHaveLength(3);
  });

  it('gives up with a rate limit error once the retries are spent', async () => {
    const { service } = makeService(
      {
        '/openapi/login': [LOGIN_OK],
        '/openapi/platform/queryPowerStationList': [() => httpStatus(503)],
      },
      { pointMap: POINT_MAP, maxRetries: 2 }
    );

    await expect(service.discoverPlants()).rejects.toBeInstanceOf(SungrowRateLimitError);
  });

  it('does not retry an auth failure', async () => {
    const { service, calls } = makeService({
      '/openapi/login': [() => envelope(null, '401', 'invalid token')],
    });

    await expect(service.authenticate()).rejects.toBeInstanceOf(SungrowAuthError);
    expect(calls).toHaveLength(1);
  });

  it('treats an unrecognised result code as a hard failure, not a retry', async () => {
    const { service, calls } = makeService(
      {
        '/openapi/login': [LOGIN_OK],
        '/openapi/platform/queryPowerStationList': [() => envelope(null, '9', 'station not found')],
      },
      { pointMap: POINT_MAP }
    );

    await expect(service.discoverPlants()).rejects.toThrow(/station not found/);
    expect(calls.filter(c => c.path === '/openapi/platform/queryPowerStationList')).toHaveLength(1);
  });

  it('stops at the per-run request budget instead of hammering the vendor', async () => {
    const { service, calls } = makeService(
      {
        '/openapi/login': [LOGIN_OK],
        '/openapi/platform/queryPowerStationList': [() => httpStatus(429)],
      },
      { pointMap: POINT_MAP, requestBudget: 3, maxRetries: 10 }
    );

    await expect(service.discoverPlants()).rejects.toBeInstanceOf(SungrowRequestBudgetError);
    expect(calls.length).toBe(3);
    expect(service.getRequestBudgetUsage()).toEqual({ used: 4, budget: 3 });
  });

  it('reports a failed connection test rather than throwing', async () => {
    const { service } = makeService({
      '/openapi/login': [() => envelope(null, '401', 'appkey rejected')],
    });
    const result = await service.testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/appkey/i);
  });
});

describe('Sungrow point map', () => {
  it('accepts the terse and the full config forms', () => {
    const mappings = parseSungrowPointMap({
      '10001': 'power_ac',
      p10002: { mapped_field: 'bess_soc', unit: '%', scaling_factor: 1, scope: 'battery' },
    });
    expect(mappings).toEqual([
      { point_id: '10001', mapped_field: 'power_ac' },
      {
        point_id: '10002',
        mapped_field: 'bess_soc',
        unit: '%',
        scaling_factor: 1,
        scope: 'battery',
      },
    ]);
  });

  it('drops entries with no target rather than defaulting one', () => {
    expect(parseSungrowPointMap({ '10001': '', '10002': {}, '10003': null })).toEqual([]);
    expect(parseSungrowPointMap(null)).toEqual([]);
  });

  it('drops a target that is not a data field type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const filtered = filterValidPointMappings([
        { point_id: '10001', mapped_field: 'power_ac' },
        { point_id: '10002', mapped_field: 'bess_state_of_charge' }, // typo, not a member
      ]);
      expect(filtered.map(p => p.point_id)).toEqual(['10001']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never emits a reading for a point map entry with a bad target', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { service } = await discovered({
        pointMap: [
          { point_id: '10001', mapped_field: 'power_ac' },
          { point_id: '10002', mapped_field: 'not_a_field_type' },
        ],
      });
      const readings = await service.pollRealtime();
      expect(readings.some(r => r.metric === 'not_a_field_type')).toBe(false);
      expect(readings.some(r => r.metric === 'power_ac')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('scopes static field mappings by device class', async () => {
    const { service } = await discovered();
    const mappings = service.staticFieldMappings();
    expect(mappings).toContainEqual({
      original_field: 'battery.p10002',
      mapped_field: 'bess_soc',
      unit: '%',
      scaling_factor: 1,
    });
  });
});

describe('Sungrow timestamps', () => {
  it('round-trips the 14-digit format', () => {
    const epoch = Date.UTC(2026, 6, 15, 13, 45, 30);
    expect(formatSungrowTimestamp(epoch)).toBe('20260715134530');
    expect(parseSungrowTimestamp('20260715134530')).toBe(epoch);
  });

  it('accepts epoch seconds, epoch millis and ISO strings', () => {
    expect(parseSungrowTimestamp('1768484730')).toBe(1768484730 * 1000);
    expect(parseSungrowTimestamp('1768484730000')).toBe(1768484730000);
    expect(parseSungrowTimestamp('2026-07-15T13:45:30Z')).toBe(Date.UTC(2026, 6, 15, 13, 45, 30));
  });

  it('returns null for unusable input', () => {
    for (const raw of [null, undefined, '', 'not a time', '20261315000000']) {
      expect(parseSungrowTimestamp(raw)).toBeNull();
    }
  });
});

describe('Sungrow credentials', () => {
  it('reads appkey and access key from connection config', async () => {
    const creds = await resolveSungrowCredentials({
      secret_arn: null,
      config: {
        appkey: 'ak',
        access_key: 'xk',
        user_account: 'ops@example.com',
        user_password: 'secret',
      },
    } as any);
    expect(creds).toEqual({
      appkey: 'ak',
      accessKey: 'xk',
      userAccount: 'ops@example.com',
      userPassword: 'secret',
      token: undefined,
    });
  });

  it('fails loudly when the appkey or access key is missing', async () => {
    await expect(
      resolveSungrowCredentials({ secret_arn: null, config: { appkey: 'ak' } } as any)
    ).rejects.toThrow(/credentials not found/);
  });
});

describe('Sungrow gateways', () => {
  it('defaults to the EU gateway and resolves a region shorthand', async () => {
    const { service, calls } = makeService(
      { '/openapi/login': [LOGIN_OK] },
      { region: 'au' }
    );
    await service.authenticate();
    expect(calls).toHaveLength(1);
    expect(SUNGROW_GATEWAYS.au).toBe('https://augateway.isolarcloud.com');
  });
});
