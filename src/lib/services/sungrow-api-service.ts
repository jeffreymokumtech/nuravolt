/**
 * Sungrow iSolarCloud OpenAPI connector.
 *
 * UNVERIFIED AGAINST A LIVE ENDPOINT. iSolarCloud OpenAPI access is granted
 * only after a signed confidentiality agreement with Sungrow, so this module
 * has never executed a real request. Everything below is built from the
 * publicly observable shape of the API (independent client implementations and
 * vendor support notes), every response parse is defensive, and each place
 * where a field name had to be assumed carries an ASSUMPTION comment. Treat a
 * first live run as a schema-discovery exercise, not as a smoke test.
 *
 * Shape this is built to:
 *   - POST {host}/openapi/login
 *       {appkey, sys_code, user_account, user_password} -> result_data.token
 *   - POST {host}/openapi/platform/queryPowerStationList        {page, size}
 *   - POST {host}/openapi/platform/getPowerStationDetail        {ps_ids}
 *   - POST {host}/openapi/platform/getDeviceListByPsId          {ps_id, page, size, device_type_list}
 *   - POST {host}/openapi/platform/getPowerStationRealTimeData  {ps_id_list, point_id_list, is_get_point_dict}
 *   - POST {host}/openapi/platform/getPowerStationPointMinuteDataList
 *       {ps_id_list, points, is_get_point_dict, start_time_stamp, end_time_stamp, minute_interval}
 *
 * Every request carries the `x-access-key` header plus `appkey` (and `sys_code`
 * when the account requires one) in the JSON body. The envelope is
 * {req_serial_num, result_code, result_msg, result_data} with result_code '1'
 * meaning success.
 *
 * Measurement points: iSolarCloud returns measurements as `p<point_id>` keys
 * (e.g. `p83022`) and the point catalogue itself sits behind the same
 * confidentiality agreement. Point ids are also account and device-model
 * specific. So there is no built-in point_id -> DataFieldType table here: that
 * would be fabricated. Operators supply a point map (connection config
 * `point_map`, or the LLM/heuristic field mapper fed from the `point_dict` the
 * API returns), and only mapped points are emitted as readings. A mapping whose
 * target is not a DataFieldType member is dropped, so an operator typo cannot
 * put an unstorable metric name on the wire.
 *
 * Rate limits are not published. The connector therefore assumes they are
 * tight: sequential calls with a polite minimum interval, exponential backoff
 * with jitter on transient failures, and a hard per-run request budget that
 * fails loudly rather than hammering the vendor.
 */
import { DataFieldType } from '@prisma/client';
import type { DataConnection } from '@prisma/client';
import { CredentialService } from './credentials';
import {
  buildBessDeviceId,
  parseBessDeviceId,
  sanitizeBessAssetToken,
  PLANT_ROLLUP_DEVICE_ID,
} from './cloud-connector';
import type {
  CloudVendorConnector,
  NormalizedDevice,
  NormalizedPlant,
  NormalizedReading,
  StaticFieldMapping,
} from './cloud-connector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regional gateways. NuraVolt is EU-resident, so the EU gateway is the default.
 */
export const SUNGROW_GATEWAYS: Record<string, string> = {
  eu: 'https://gateway.isolarcloud.eu',
  intl: 'https://gateway.isolarcloud.com.hk',
  cn: 'https://gateway.isolarcloud.com',
  au: 'https://augateway.isolarcloud.com',
};

export const SUNGROW_DEFAULT_BASE_URL = SUNGROW_GATEWAYS.eu;

/** Envelope result_code that means success. */
const RESULT_CODE_OK = '1';

/** Page size for the paginated list endpoints. */
const LIST_PAGE_SIZE = 100;
/** Hard stop on pagination so a misbehaving page counter cannot loop forever. */
const MAX_LIST_PAGES = 50;

/** Default hard ceiling on outbound calls per connector instance. */
const DEFAULT_REQUEST_BUDGET = 300;
/** Default number of retries after a transient failure (on top of the first try). */
const DEFAULT_MAX_RETRIES = 3;
/** Base of the exponential backoff; attempt n waits base * 2^n plus jitter. */
const DEFAULT_BACKOFF_BASE_MS = 2_000;

/** Minute granularity requested from the historical endpoint. */
const DEFAULT_MINUTE_INTERVAL = 5;

/** The closed metric taxonomy every reading has to land in. */
const VALID_DATA_FIELD_TYPES = new Set<string>(Object.values(DataFieldType) as string[]);

/**
 * Vendor device_type codes are not published, and they differ per account
 * generation. Nothing is guessed here: operators map their own codes through
 * connection config `device_type_map`, e.g. {"43": "battery"}. Unmapped codes
 * land as 'other' and stay visible in device metadata for the wizard to match.
 */
export const SUNGROW_DEVICE_CLASSES = [
  'string_inverter',
  'residential_inverter',
  'emi',
  'battery',
  'power_sensor',
  'logger',
  'other',
] as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SungrowApiError extends Error {
  readonly status?: number;
  readonly resultCode?: string;

  constructor(message: string, status?: number, resultCode?: string) {
    super(message);
    this.name = 'SungrowApiError';
    this.status = status;
    this.resultCode = resultCode;
    // ES5 class-extends-Error pitfall: keep instanceof working.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 401/403, or an envelope that rejected the appkey / access key / token. */
export class SungrowAuthError extends SungrowApiError {
  constructor(message: string, status?: number, resultCode?: string) {
    super(message, status, resultCode);
    this.name = 'SungrowAuthError';
  }
}

/** Throttled by the vendor and still throttled after the backoff retries. */
export class SungrowRateLimitError extends SungrowApiError {
  constructor(message: string, status?: number, resultCode?: string) {
    super(message, status, resultCode);
    this.name = 'SungrowRateLimitError';
  }
}

/** Local guard: this connector instance hit its own per-run request budget. */
export class SungrowRequestBudgetError extends SungrowApiError {
  constructor(budget: number) {
    super(`Sungrow request budget of ${budget} calls exhausted for this run`);
    this.name = 'SungrowRequestBudgetError';
  }
}

// ---------------------------------------------------------------------------
// Point map
// ---------------------------------------------------------------------------

/**
 * One operator-supplied measurement point. `point_id` is the numeric id the API
 * returns as `p<point_id>`; `mapped_field` must be a DataFieldType member name.
 */
export interface SungrowPointMapping {
  point_id: string;
  /** DataFieldType member name. */
  mapped_field: string;
  unit?: string;
  scaling_factor?: number;
  /** Device class this point belongs to; scopes original_field. */
  scope?: string;
}

/**
 * Accepts either the terse config form {"83022": "power_ac"} or the full form
 * {"83022": {mapped_field, unit, scaling_factor, scope}}. Entries missing a
 * mapped_field are dropped rather than defaulted: a point with an unknown
 * meaning must not be filed under a guessed DataFieldType.
 */
export function parseSungrowPointMap(raw: any): SungrowPointMapping[] {
  if (!raw || typeof raw !== 'object') return [];
  const mappings: SungrowPointMapping[] = [];

  for (const [key, value] of Array.from(Object.entries(raw as Record<string, any>))) {
    const pointId = String(key).replace(/^p/i, '').trim();
    if (!pointId) continue;

    if (typeof value === 'string') {
      if (!value.trim()) continue;
      mappings.push({ point_id: pointId, mapped_field: value.trim() });
      continue;
    }
    if (value && typeof value === 'object') {
      const mappedField = String(value.mapped_field ?? value.mappedField ?? '').trim();
      if (!mappedField) continue;
      mappings.push({
        point_id: pointId,
        mapped_field: mappedField,
        unit: value.unit != null ? String(value.unit) : undefined,
        scaling_factor: toNumber(value.scaling_factor ?? value.scalingFactor) ?? undefined,
        scope: value.scope != null ? String(value.scope) : undefined,
      });
    }
  }
  return mappings;
}

/**
 * Drop point mappings whose target is not a DataFieldType member. The point map
 * is operator-supplied config, so a typo would otherwise put an unstorable
 * metric name on the wire. Dropping is the safe direction: a missing series is
 * visible to whoever configured it, a mis-filed one is not.
 */
export function filterValidPointMappings(points: SungrowPointMapping[]): SungrowPointMapping[] {
  const valid: SungrowPointMapping[] = [];
  for (const point of points) {
    if (VALID_DATA_FIELD_TYPES.has(point.mapped_field)) {
      valid.push(point);
      continue;
    }
    console.warn(
      `Sungrow point map: p${point.point_id} targets '${point.mapped_field}', which is not a known data field. Ignoring it.`
    );
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface SungrowCredentials {
  /** Application key issued by Sungrow. */
  appkey: string;
  /** Value of the mandatory `x-access-key` header. */
  accessKey: string;
  /** iSolarCloud portal account (login flow). */
  userAccount?: string;
  userPassword?: string;
  /** Pre-issued token, when the account was provisioned through OAuth instead. */
  token?: string;
}

/**
 * Resolve iSolarCloud credentials for a connection.
 * Preferred path: AWS Secrets Manager via DataConnection.secret_arn (secret
 * payload is {appkey, access_key, user_account, user_password} or a token).
 * Fallback: plaintext config, matching the Huawei/SolarEdge connectors so the
 * discover route can migrate legacy rows best-effort. Secrets are never logged.
 */
export async function resolveSungrowCredentials(
  connection: Pick<DataConnection, 'secret_arn' | 'config'>
): Promise<SungrowCredentials> {
  const fromRecord = (source: Record<string, any>): SungrowCredentials | null => {
    const appkey = source.appkey || source.app_key || source.appKey;
    const accessKey = source.access_key || source.accessKey || source.x_access_key;
    if (!appkey || !accessKey) return null;
    return {
      appkey: String(appkey),
      accessKey: String(accessKey),
      userAccount: source.user_account || source.userAccount || source.username || undefined,
      userPassword: source.user_password || source.userPassword || source.password || undefined,
      token: source.token || undefined,
    };
  };

  if (connection.secret_arn) {
    try {
      const creds = await new CredentialService().getCredentials(connection.secret_arn);
      const resolved = fromRecord(creds as Record<string, any>);
      if (resolved) return resolved;
      console.warn('Sungrow secret is missing appkey/access_key, falling back to config');
    } catch (error) {
      console.warn('Failed to read Sungrow secret, falling back to config:', error);
    }
  }

  const resolved = fromRecord((connection.config || {}) as Record<string, any>);
  if (!resolved) {
    throw new Error(
      'Sungrow iSolarCloud credentials not found (need appkey + access_key in Secrets Manager or connection config)'
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

export interface SungrowServiceOptions {
  baseUrl?: string;
  /** Shorthand for baseUrl: 'eu' | 'intl' | 'cn' | 'au'. */
  region?: string;
  credentials?: SungrowCredentials;
  /** Account-specific `sys_code`. Omitted from the body when not set. */
  sysCode?: string;
  /** Body `lang`. Left off when not set rather than defaulted to a guess. */
  lang?: string;
  /** Operator-supplied point catalogue; without it no readings are emitted. */
  pointMap?: SungrowPointMapping[];
  /** Vendor device_type code -> normalized device class. */
  deviceTypeMap?: Record<string, string>;
  /** Vendor device id -> canonical BESS device_ext_id override. */
  bessDeviceIds?: Record<string, string>;
  /** Restrict getDeviceListByPsId to these vendor device_type codes. */
  deviceTypeList?: Array<string | number>;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Polite minimum interval between sequential calls (ms). Default 1000; tests use 0. */
  interCallDelayMs?: number;
  /** Retries after a transient failure. Default 3. */
  maxRetries?: number;
  /** Exponential backoff base (ms). Default 2000; tests use a few ms. */
  backoffBaseMs?: number;
  /** Hard ceiling on outbound calls for this instance. Default 300. */
  requestBudget?: number;
  /** Minute granularity for backfill. Default 5. */
  minuteInterval?: number;
}

export class SungrowISolarCloudService implements CloudVendorConnector {
  private baseUrl: string;
  private credentials: SungrowCredentials | null;
  private sysCode: string | null;
  private lang: string | null;
  private pointMap: SungrowPointMapping[];
  private pointIndex: Map<string, SungrowPointMapping>;
  private deviceTypeMap: Record<string, string>;
  private bessDeviceIds: Record<string, string>;
  private deviceTypeList: Array<string | number> | null;
  private fetchImpl: FetchLike;
  private interCallDelayMs: number;
  private maxRetries: number;
  private backoffBaseMs: number;
  private requestBudget: number;
  private minuteInterval: number;

  /** Devices registered via discoverDevices()/setDeviceInventory(). */
  private deviceRegistry = new Map<string, NormalizedDevice>();
  /** Raw vendor handle (ps_key/uuid) -> device, so row lookups stay O(1). */
  private vendorIndex = new Map<string, NormalizedDevice>();
  /** Session token from /openapi/login (or supplied pre-issued). */
  private token: string | null = null;
  /** Outbound calls made by this instance — checked against requestBudget. */
  private requestsMade = 0;
  /** Epoch ms of the last outbound call — enforces the polite interval. */
  private lastCallAt = 0;
  /**
   * point_dict entries seen on the wire with no operator mapping. This is the
   * honest substitute for a fabricated point table: it hands real point ids,
   * names and units to the field mapper.
   */
  private unmappedPoints = new Map<string, SungrowUnmappedPoint>();

  constructor(options: SungrowServiceOptions = {}) {
    const regional = options.region ? SUNGROW_GATEWAYS[options.region.toLowerCase()] : undefined;
    this.baseUrl = (options.baseUrl || regional || SUNGROW_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.credentials = options.credentials || null;
    this.sysCode = options.sysCode ?? null;
    this.lang = options.lang ?? null;
    this.pointMap = filterValidPointMappings(options.pointMap ?? []);
    this.pointIndex = indexPoints(this.pointMap);
    this.deviceTypeMap = options.deviceTypeMap ?? {};
    this.bessDeviceIds = options.bessDeviceIds ?? {};
    this.deviceTypeList = options.deviceTypeList ?? null;
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike);
    this.interCallDelayMs = options.interCallDelayMs ?? 1000;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.requestBudget = options.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.minuteInterval = options.minuteInterval ?? DEFAULT_MINUTE_INTERVAL;
    this.token = options.credentials?.token ?? null;
  }

  // -- Legacy-compatible entry points (test-connection.ts, polling-service) --

  /** Configure from a DataConnection row (resolves credentials). */
  async connect(connection: DataConnection): Promise<void> {
    const config = (connection.config || {}) as Record<string, any>;
    if (config.baseUrl || config.base_url) {
      this.baseUrl = String(config.baseUrl || config.base_url).replace(/\/+$/, '');
    } else if (config.region && SUNGROW_GATEWAYS[String(config.region).toLowerCase()]) {
      this.baseUrl = SUNGROW_GATEWAYS[String(config.region).toLowerCase()];
    }
    if (config.sys_code || config.sysCode) {
      this.sysCode = String(config.sys_code || config.sysCode);
    }
    if (config.lang) this.lang = String(config.lang);
    if (config.point_map || config.pointMap) {
      this.pointMap = filterValidPointMappings(
        parseSungrowPointMap(config.point_map || config.pointMap)
      );
      this.pointIndex = indexPoints(this.pointMap);
    }
    if (config.device_type_map || config.deviceTypeMap) {
      this.deviceTypeMap = normalizeStringMap(config.device_type_map || config.deviceTypeMap);
    }
    if (config.bess_device_ids || config.bessDeviceIds) {
      this.bessDeviceIds = normalizeStringMap(config.bess_device_ids || config.bessDeviceIds);
    }
    if (Array.isArray(config.device_type_list || config.deviceTypeList)) {
      this.deviceTypeList = (config.device_type_list || config.deviceTypeList) as Array<string | number>;
    }
    if (toNumber(config.minute_interval ?? config.minuteInterval) !== null) {
      this.minuteInterval = toNumber(config.minute_interval ?? config.minuteInterval) as number;
    }
    this.credentials = await resolveSungrowCredentials(connection);
    this.token = this.credentials.token ?? null;
    this.requestsMade = 0;
  }

  async testConnection(): Promise<{
    success: boolean;
    message: string;
    responseTime: number;
    error?: string;
  }> {
    const startTime = Date.now();
    try {
      await this.authenticate();
      return {
        success: true,
        message: 'Sungrow iSolarCloud API connection successful',
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Sungrow iSolarCloud API connection failed',
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /** Legacy alias mirroring HuaweiFusionSolarService.getPlantList(). */
  async getPlantList(): Promise<NormalizedPlant[]> {
    return this.discoverPlants();
  }

  async close(): Promise<void> {
    // Nothing to release. The token is instance-scoped on purpose: unlike
    // FusionSolar there is no evidence that iSolarCloud punishes re-login, so
    // a module-level cache would trade a real correctness risk (a stale token
    // shared across tenants) for an unproven saving.
  }

  /** Register device inventory (e.g. restored from DiscoveredPlant metadata). */
  setDeviceInventory(devices: NormalizedDevice[], merge = false): void {
    if (!merge) {
      this.deviceRegistry.clear();
      this.vendorIndex.clear();
    }
    for (const device of devices) {
      this.deviceRegistry.set(String(device.external_device_id), device);
      const vendorId = device.metadata?.vendor_device_id;
      if (vendorId) this.vendorIndex.set(String(vendorId), device);
    }
  }

  getDeviceInventory(): NormalizedDevice[] {
    return Array.from(this.deviceRegistry.values());
  }

  /**
   * Points returned by the API that no operator mapping covers, with the
   * vendor's own name and unit. Feed these to the field mapper or to the
   * onboarding UI so a real account fills the point map in.
   */
  getUnmappedPoints(): SungrowUnmappedPoint[] {
    return Array.from(this.unmappedPoints.values()).map(p => ({ ...p }));
  }

  /** Outbound calls made so far, against the configured budget. */
  getRequestBudgetUsage(): { used: number; budget: number } {
    return { used: this.requestsMade, budget: this.requestBudget };
  }

  // -- CloudVendorConnector ---------------------------------------------------

  async authenticate(): Promise<void> {
    if (!this.credentials?.appkey || !this.credentials?.accessKey) {
      throw new SungrowAuthError('Sungrow service has no credentials — call connect() first');
    }
    if (this.token) return;

    const { userAccount, userPassword } = this.credentials;
    if (!userAccount || !userPassword) {
      throw new SungrowAuthError(
        'Sungrow iSolarCloud needs either a pre-issued token or user_account + user_password'
      );
    }

    const data = await this.call('/openapi/login', {
      user_account: userAccount,
      user_password: userPassword,
    });
    // ASSUMPTION: the token sits at result_data.token. Accept the two other
    // spellings seen in the wild rather than hard-failing on a live account.
    const token = data?.token ?? data?.user_token ?? data?.access_token;
    if (!token) {
      throw new SungrowAuthError('Sungrow login returned no token');
    }
    this.token = String(token);
  }

  async discoverPlants(): Promise<NormalizedPlant[]> {
    await this.authenticate();

    const plants: NormalizedPlant[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const data = await this.call('/openapi/platform/queryPowerStationList', {
        page,
        size: LIST_PAGE_SIZE,
      });
      const list = extractList(data);
      plants.push(...list.map(item => this.normalizePlant(item)));
      if (list.length < LIST_PAGE_SIZE) break;
    }
    return plants.filter(p => !!p.external_plant_id);
  }

  async discoverDevices(plantIds: string[]): Promise<NormalizedDevice[]> {
    await this.authenticate();

    const devices: NormalizedDevice[] = [];
    // One call per plant per page, sequential — rate limits are unpublished.
    for (const plantId of plantIds) {
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const body: Record<string, any> = { ps_id: plantId, page, size: LIST_PAGE_SIZE };
        if (this.deviceTypeList && this.deviceTypeList.length > 0) {
          body.device_type_list = this.deviceTypeList;
        }
        const data = await this.call('/openapi/platform/getDeviceListByPsId', body);
        const list = extractList(data);
        for (const item of list) {
          const device = this.normalizeDevice(item, String(plantId));
          if (device) devices.push(device);
        }
        if (list.length < LIST_PAGE_SIZE) break;
      }
    }
    this.setDeviceInventory(devices, /* merge */ true);
    return devices;
  }

  /**
   * Historical minute data for one calendar day.
   *
   * `deviceIds` selects which registered devices' plants to query: iSolarCloud
   * serves this series per plant, so the device filter narrows the plant set
   * rather than the series itself.
   */
  async backfill(deviceIds: string[], day: Date): Promise<NormalizedReading[]> {
    const pointIds = this.requestedPointIds();
    if (pointIds.length === 0) return [];
    await this.authenticate();

    const plantIds = this.plantIdsFor(deviceIds);
    if (plantIds.length === 0) return [];

    const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0);
    const end = start + 24 * 60 * 60 * 1000 - 1000;

    const readings: NormalizedReading[] = [];
    for (const plantId of plantIds) {
      const data = await this.call('/openapi/platform/getPowerStationPointMinuteDataList', {
        ps_id_list: [plantId],
        points: pointIds.map(id => `p${id}`).join(','),
        is_get_point_dict: '1',
        start_time_stamp: formatSungrowTimestamp(start),
        end_time_stamp: formatSungrowTimestamp(end),
        minute_interval: this.minuteInterval,
      });
      readings.push(...this.normalizeMinuteData(data, plantId));
    }
    return readings;
  }

  async pollRealtime(deviceIds?: string[]): Promise<NormalizedReading[]> {
    const pointIds = this.requestedPointIds();
    if (pointIds.length === 0) return [];
    await this.authenticate();

    const plantIds = this.plantIdsFor(deviceIds);
    if (plantIds.length === 0) return [];

    const pollTs = Date.now();
    const readings: NormalizedReading[] = [];
    for (const batch of chunk(plantIds, LIST_PAGE_SIZE)) {
      const data = await this.call('/openapi/platform/getPowerStationRealTimeData', {
        ps_id_list: batch,
        point_id_list: pointIds,
        is_get_point_dict: '1',
      });
      readings.push(...this.normalizeRealtimeData(data, pollTs));
    }
    return readings;
  }

  /**
   * Only the operator-supplied point map is returned. An empty array is the
   * correct answer for an unconfigured connection: iSolarCloud point ids are
   * account specific and their catalogue is not public, so there is nothing
   * honest to hard-code.
   */
  staticFieldMappings(): StaticFieldMapping[] {
    return this.pointMap.map(point => ({
      original_field: `${point.scope || 'sungrow'}.p${point.point_id}`,
      mapped_field: point.mapped_field,
      unit: point.unit,
      scaling_factor: point.scaling_factor ?? 1,
    }));
  }

  // -- HTTP layer -------------------------------------------------------------

  /**
   * POST an OpenAPI endpoint and unwrap the
   * {req_serial_num, result_code, result_msg, result_data} envelope.
   *
   * Transient failures (HTTP 429/5xx, network throw, throttling result codes)
   * are retried with exponential backoff plus jitter. Auth failures are not
   * retried. Every attempt counts against the per-run request budget.
   */
  private async call(path: string, body: Record<string, any>): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.backoffDelay(attempt));
      }
      await this.respectInterCallDelay();

      this.requestsMade += 1;
      if (this.requestsMade > this.requestBudget) {
        throw new SungrowRequestBudgetError(this.requestBudget);
      }

      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-key': this.credentials?.accessKey ?? '',
          },
          body: JSON.stringify(this.withCommonFields(body)),
        });
      } catch (error) {
        // Network-level failure: retryable.
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new SungrowAuthError(
          `Sungrow ${path} rejected the credentials (HTTP ${response.status})`,
          response.status
        );
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new SungrowRateLimitError(
          `Sungrow ${path} HTTP ${response.status}`,
          response.status
        );
        continue;
      }
      if (!response.ok) {
        throw new SungrowApiError(`Sungrow ${path} HTTP ${response.status}`, response.status);
      }

      const envelope = await response.json().catch(() => null);
      if (!envelope || typeof envelope !== 'object') {
        lastError = new SungrowApiError(`Sungrow ${path} returned an unreadable body`);
        continue;
      }

      const resultCode = envelope.result_code != null ? String(envelope.result_code) : undefined;
      if (resultCode === RESULT_CODE_OK) {
        return envelope.result_data;
      }

      const message = envelope.result_msg ? String(envelope.result_msg) : '';
      if (isAuthResultCode(resultCode, message)) {
        // Token rejected: drop it so the next authenticate() re-logs in, but do
        // not silently retry here — a bad appkey would loop forever.
        this.token = this.credentials?.token ?? null;
        throw new SungrowAuthError(
          `Sungrow ${path} auth failed (result_code ${resultCode ?? 'unknown'}${message ? `: ${message}` : ''})`,
          undefined,
          resultCode
        );
      }
      if (isThrottleResultCode(resultCode, message)) {
        lastError = new SungrowRateLimitError(
          `Sungrow ${path} throttled (result_code ${resultCode ?? 'unknown'}${message ? `: ${message}` : ''})`,
          undefined,
          resultCode
        );
        continue;
      }

      throw new SungrowApiError(
        `Sungrow ${path} failed (result_code ${resultCode ?? 'unknown'}${message ? `: ${message}` : ''})`,
        undefined,
        resultCode
      );
    }

    throw lastError ?? new SungrowApiError(`Sungrow ${path} failed after ${this.maxRetries} retries`);
  }

  /** appkey/sys_code/lang/token ride in the JSON body on every call. */
  private withCommonFields(body: Record<string, any>): Record<string, any> {
    const common: Record<string, any> = {
      appkey: this.credentials?.appkey ?? '',
      ...body,
    };
    if (this.sysCode) common.sys_code = this.sysCode;
    if (this.lang) common.lang = this.lang;
    if (this.token) common.token = this.token;
    return common;
  }

  /** Exponential backoff with full jitter, so parallel runs do not resonate. */
  private backoffDelay(attempt: number): number {
    const ceiling = this.backoffBaseMs * Math.pow(2, attempt - 1);
    return Math.round(ceiling * (0.5 + Math.random() * 0.5));
  }

  private async respectInterCallDelay(): Promise<void> {
    if (this.interCallDelayMs <= 0) return;
    const since = Date.now() - this.lastCallAt;
    if (this.lastCallAt > 0 && since < this.interCallDelayMs) {
      await this.sleep(this.interCallDelayMs - since);
    }
    this.lastCallAt = Date.now();
  }

  // -- Normalization ----------------------------------------------------------

  private normalizePlant(item: Record<string, any>): NormalizedPlant {
    // ASSUMPTION: field spellings follow the ps_* convention the API uses for
    // its request parameters. Alternates are accepted so a live account with
    // slightly different keys still yields a usable plant.
    const lat = toNumber(item.ps_latitude ?? item.latitude);
    const lng = toNumber(item.ps_longitude ?? item.longitude);
    // ASSUMPTION: installed capacity comes back in kW (design_capacity is the
    // usual iSolarCloud spelling). Left undefined when absent rather than
    // defaulted, so an unknown capacity never becomes a fake number.
    const capacityKw = toNumber(item.design_capacity ?? item.ps_capacity ?? item.total_capcity);

    return {
      external_plant_id: String(item.ps_id ?? item.psId ?? ''),
      name: String(item.ps_name ?? item.psName ?? item.ps_id ?? ''),
      location: {
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        address: item.ps_location ?? item.ps_address ?? undefined,
        country: item.country_name ?? undefined,
      },
      capacity_mw: capacityKw !== null ? capacityKw / 1000 : undefined,
      commissioning_date: item.install_date ?? item.build_date ?? undefined,
      timezone: item.ps_timezone_id ?? item.timezone ?? undefined,
      metadata: {
        ps_key: item.ps_key ?? undefined,
        ps_type: item.ps_type ?? undefined,
        raw_capacity_kw: capacityKw ?? undefined,
      },
    };
  }

  /**
   * One device row. Vendor device_type codes are only translated through the
   * operator-supplied map; anything else stays 'other' with the raw code kept
   * in metadata so the onboarding wizard can classify it by hand.
   */
  private normalizeDevice(item: Record<string, any>, plantId: string): NormalizedDevice | null {
    // ps_key is iSolarCloud's stable per-device handle; uuid and device_id are
    // the fallbacks seen in device payloads.
    const vendorDeviceId = String(
      item.ps_key ?? item.uuid ?? item.device_id ?? item.deviceId ?? ''
    );
    if (!vendorDeviceId) return null;

    const rawTypeCode =
      item.device_type != null
        ? String(item.device_type)
        : item.deviceType != null
          ? String(item.deviceType)
          : '';
    const deviceClass = this.deviceTypeMap[rawTypeCode] || 'other';
    const name = item.device_name ?? item.deviceName ?? item.device_model ?? undefined;

    const metadata: Record<string, any> = {
      vendor_device_id: vendorDeviceId,
      vendor_device_type: rawTypeCode || undefined,
      ps_key: item.ps_key ?? undefined,
      device_model: item.device_model ?? item.deviceModel ?? undefined,
    };

    let externalDeviceId = vendorDeviceId;
    if (deviceClass === 'battery') {
      const canonical = this.canonicalBessId(vendorDeviceId, name);
      metadata.canonical_device_id = canonical;
      const parsed = parseBessDeviceId(canonical);
      metadata.bess_grain = parsed?.grain ?? 'asset';
      // Sungrow addresses data by ps_id, not by device id, so nothing downstream
      // needs the raw handle as the key — the canonical id can be the id.
      externalDeviceId = canonical;
    }

    return {
      external_device_id: externalDeviceId,
      external_plant_id: plantId,
      name: name != null ? String(name) : undefined,
      device_type: deviceClass,
      vendor_type_id: toNumber(rawTypeCode) ?? undefined,
      model: item.device_model ?? item.deviceModel ?? undefined,
      serial: item.device_sn ?? item.sn ?? undefined,
      metadata,
    };
  }

  /**
   * Canonical BESS device_ext_id. An explicit operator override wins (it is the
   * only way to express real unit/rack/module grain, which the device list does
   * not carry); otherwise the device lands at asset grain.
   */
  private canonicalBessId(vendorDeviceId: string, name?: any): string {
    const override = this.bessDeviceIds[vendorDeviceId];
    if (override) {
      const parsed = parseBessDeviceId(override);
      if (parsed) return parsed.device_ext_id;
      console.warn(
        `Sungrow bess_device_ids['${vendorDeviceId}'] is not a canonical BESS id, ignoring it`
      );
    }
    const token = sanitizeBessAssetToken(name != null ? String(name) : '') || vendorDeviceId;
    return buildBessDeviceId({ asset: token });
  }

  /** result_data.point_dict -> {point_id: {name, unit}}, recording unmapped points. */
  private readPointDict(data: any): Map<string, { name?: string; unit?: string }> {
    const dict = new Map<string, { name?: string; unit?: string }>();
    const entries: any[] = Array.isArray(data?.point_dict) ? data.point_dict : [];
    for (const entry of entries) {
      const pointId = entry?.point_id != null ? String(entry.point_id) : '';
      if (!pointId) continue;
      const meta = {
        name: entry.point_name != null ? String(entry.point_name) : undefined,
        unit: entry.point_unit != null ? String(entry.point_unit) : undefined,
      };
      dict.set(pointId, meta);
      if (!this.pointIndex.has(pointId) && !this.unmappedPoints.has(pointId)) {
        this.unmappedPoints.set(pointId, {
          point_id: pointId,
          point_name: meta.name,
          point_unit: meta.unit,
        });
      }
    }
    return dict;
  }

  /**
   * getPowerStationRealTimeData: result_data.device_point_list holds one entry
   * per reporting device with measurements as `p<point_id>` keys, alongside a
   * result_data.point_dict describing those points.
   */
  private normalizeRealtimeData(data: any, pollTs: number): NormalizedReading[] {
    this.readPointDict(data);
    const rows: any[] = Array.isArray(data?.device_point_list) ? data.device_point_list : [];
    const readings: NormalizedReading[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const plantId = row.ps_id != null ? String(row.ps_id) : '';
      const { deviceId, deviceType } = this.resolveRowDevice(row);
      readings.push(...this.pointsToReadings(row, pollTs, plantId, deviceId, deviceType));
    }
    return readings;
  }

  /**
   * getPowerStationPointMinuteDataList: result_data holds point_dict plus one
   * key per requested ps_id whose value is an array of frames
   * [{time_stamp, p<point_id>: value, ...}].
   */
  private normalizeMinuteData(data: any, plantId: string): NormalizedReading[] {
    this.readPointDict(data);
    if (!data || typeof data !== 'object') return [];

    const readings: NormalizedReading[] = [];
    for (const [key, value] of Array.from(Object.entries(data as Record<string, any>))) {
      if (key === 'point_dict' || !Array.isArray(value)) continue;
      const seriesPlantId = key === 'device_point_list' ? plantId : key;
      for (const frame of value as any[]) {
        if (!frame || typeof frame !== 'object') continue;
        const ts = parseSungrowTimestamp(frame.time_stamp ?? frame.timeStamp);
        if (ts === null) continue;
        const framePlantId = frame.ps_id != null ? String(frame.ps_id) : seriesPlantId;
        const { deviceId, deviceType } = this.resolveRowDevice(frame);
        readings.push(...this.pointsToReadings(frame, ts, framePlantId, deviceId, deviceType));
      }
    }
    return readings;
  }

  /**
   * Which device a data row belongs to. Rows that carry no device handle are
   * plant-grain rollups and get the reserved PLANT id.
   */
  private resolveRowDevice(row: Record<string, any>): { deviceId: string; deviceType?: string } {
    const handle = row.ps_key ?? row.uuid ?? row.device_id ?? row.deviceId;
    if (handle == null || String(handle) === '') {
      return { deviceId: PLANT_ROLLUP_DEVICE_ID, deviceType: undefined };
    }
    const vendorId = String(handle);
    const registered = this.vendorIndex.get(vendorId) ?? this.deviceRegistry.get(vendorId);
    if (registered) {
      return {
        deviceId: String(
          registered.metadata?.canonical_device_id ?? registered.external_device_id
        ),
        deviceType: registered.device_type,
      };
    }
    // Unknown handle: keep the raw id so the point stays attributable and a
    // later discovery can reconcile it.
    return { deviceId: vendorId, deviceType: undefined };
  }

  /** Turn `p<point_id>` keys on one row into readings for the mapped points. */
  private pointsToReadings(
    row: Record<string, any>,
    ts: number,
    plantId: string,
    deviceId: string,
    deviceType?: string
  ): NormalizedReading[] {
    const readings: NormalizedReading[] = [];
    for (const [key, rawValue] of Array.from(Object.entries(row))) {
      if (key.length < 2 || (key[0] !== 'p' && key[0] !== 'P')) continue;
      const pointId = key.slice(1);
      if (!/^\d+$/.test(pointId)) continue;

      const mapping = this.pointIndex.get(pointId);
      if (!mapping) {
        if (!this.unmappedPoints.has(pointId)) {
          this.unmappedPoints.set(pointId, { point_id: pointId });
        }
        continue;
      }
      const value = toNumber(rawValue);
      if (value === null) continue;

      readings.push({
        ts,
        plant_ext_id: plantId,
        device_ext_id: deviceId,
        device_type: deviceType,
        metric: mapping.mapped_field,
        value: value * (mapping.scaling_factor ?? 1),
        unit: mapping.unit,
      });
    }
    return readings;
  }

  private requestedPointIds(): string[] {
    return Array.from(this.pointIndex.keys());
  }

  /** Plants to query, narrowed by a device filter when one is supplied. */
  private plantIdsFor(deviceIds?: string[]): string[] {
    const wanted = deviceIds && deviceIds.length > 0 ? new Set(deviceIds.map(String)) : null;
    const plantIds = new Set<string>();
    for (const device of Array.from(this.deviceRegistry.values())) {
      if (
        wanted &&
        !wanted.has(String(device.external_device_id)) &&
        !wanted.has(String(device.metadata?.vendor_device_id ?? ''))
      ) {
        continue;
      }
      if (device.external_plant_id) plantIds.add(String(device.external_plant_id));
    }
    return Array.from(plantIds);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** Back-compat alias in the shape the other connectors use. */
export class SungrowAPIService extends SungrowISolarCloudService {}

/** A point the API described that no operator mapping covers. */
export interface SungrowUnmappedPoint {
  point_id: string;
  point_name?: string;
  point_unit?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function indexPoints(points: SungrowPointMapping[]): Map<string, SungrowPointMapping> {
  return new Map(points.map(p => [String(p.point_id), p]));
}

function normalizeStringMap(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Array.from(Object.entries(raw as Record<string, any>))) {
    if (value == null) continue;
    out[String(key)] = String(value);
  }
  return out;
}

/**
 * List endpoints wrap their rows differently depending on the endpoint, and the
 * exact wrapper key is not public. Accept the shapes seen in the wild instead of
 * betting on one.
 */
function extractList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['pageList', 'page_list', 'list', 'data', 'device_list', 'ps_list']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

/**
 * ASSUMPTION: iSolarCloud takes and returns 'YYYYMMDDHHmmss' timestamps in the
 * plant's local time. We format and parse in UTC, which is exact for UTC plants
 * and offset by the plant's UTC offset otherwise. Do not treat backfilled
 * Sungrow timestamps as timezone-correct until this is confirmed against a live
 * account and the plant timezone is threaded through.
 */
export function formatSungrowTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** Accepts 'YYYYMMDDHHmmss', epoch seconds/ms, and ISO strings. */
export function parseSungrowTimestamp(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim();

  if (/^\d{14}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = Number(text.slice(6, 8));
    const hour = Number(text.slice(8, 10));
    const minute = Number(text.slice(10, 12));
    const second = Number(text.slice(12, 14));
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
  if (/^\d{13}$/.test(text)) return Number(text);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sungrow's result_code catalogue is not public, so codes are not hard-coded:
 * classification leans on the message text the API returns, and anything
 * unrecognised is treated as a hard failure (never silently retried).
 */
function isAuthResultCode(resultCode: string | undefined, message: string): boolean {
  const text = `${resultCode ?? ''} ${message}`.toLowerCase();
  return (
    text.includes('token') ||
    text.includes('appkey') ||
    text.includes('app_key') ||
    text.includes('access key') ||
    text.includes('access_key') ||
    text.includes('unauthor') ||
    text.includes('permission') ||
    text.includes('login')
  );
}

function isThrottleResultCode(resultCode: string | undefined, message: string): boolean {
  const text = `${resultCode ?? ''} ${message}`.toLowerCase();
  return (
    text.includes('frequent') ||
    text.includes('frequency') ||
    text.includes('rate limit') ||
    text.includes('too many') ||
    text.includes('busy') ||
    text.includes('flow control') ||
    text.includes('throttl')
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
