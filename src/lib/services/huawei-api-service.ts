/**
 * Huawei FusionSolar Northbound ("thirdData") API connector.
 *
 * Implements CloudVendorConnector against the FusionSolar cloud:
 *   - POST /thirdData/login            {userName, systemCode} → XSRF token in response header
 *   - POST /thirdData/stations         {pageNo} → paginated plant list
 *   - POST /thirdData/getStationList   {} → legacy (non-paginated) plant list
 *   - POST /thirdData/getDevList       {stationCodes} → device inventory
 *   - POST /thirdData/getDevFiveMinutes{devIds, devTypeId, collectTime} → 5-min history
 *   - POST /thirdData/getDevRealKpi    {devIds, devTypeId} → realtime KPIs
 *
 * Response envelope: {success, failCode, data}. failCode 305 = token expired
 * (relogin once), failCode 407 = rate limit exceeded (backoff, retry once).
 *
 * Rate-limit discipline (FusionSolar limits are harsh):
 *   - token cached in-memory per (baseUrl, userName); never login more than
 *     once per 10 minutes unless the API forces it with failCode 305
 *   - devIds batched at ≤100 per call, all data calls sequential with a delay
 *
 * Huawei storage rides the same API (devTypeId 39 battery, 41 ESS), so it is
 * polled through the same code path. Their dataItemMap key names are NOT
 * verified, so no battery key is in the static mapping — see
 * HUAWEI_BATTERY_CANDIDATE_KEYS and getUnmappedKeys().
 */
import type { DataConnection } from '@prisma/client';
import { CredentialService } from './credentials';
import { buildBessDeviceId, sanitizeBessAssetToken } from './cloud-connector';
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

export const HUAWEI_DEFAULT_BASE_URL = 'https://eu5.fusionsolar.huawei.com';

/** FusionSolar token is valid ~30 min; refresh proactively after 25. */
const TOKEN_TTL_MS = 25 * 60 * 1000;
/** Never login more often than this unless forced by failCode 305. */
const MIN_LOGIN_INTERVAL_MS = 10 * 60 * 1000;
/** Max devIds per data call. */
const MAX_DEV_IDS_PER_CALL = 100;

const FAIL_CODE_RELOGIN = 305;
const FAIL_CODE_RATE_LIMIT = 407;

/**
 * devTypeId → normalized device class.
 *
 * The SmartPVMS Northbound reference's device-type list is reported
 * consistently by independent sources as: 1 string inverter, 10 EMI,
 * 17 grid meter, 38 residential inverter, 39 battery, 41 ESS, 47 power sensor.
 * That agrees with the four PV entries this connector already ran against a
 * live FusionSolar account, which is the corroboration the storage ids lean on.
 * Huawei's own portal copy is behind a login, so treat 39/41 as well-attested
 * rather than read-off-the-page, and see HUAWEI_BATTERY_CANDIDATE_KEYS for why
 * their data items are still unmapped.
 */
export const HUAWEI_DEV_TYPE_MAP: Record<number, string> = {
  1: 'string_inverter',
  38: 'residential_inverter',
  10: 'emi', // environmental monitor — has irradiance
  39: 'battery',
  41: 'battery', // ESS (Smart String ESS) — same normalized class, vendor_type_id keeps them apart
  47: 'power_sensor',
  62: 'dongle',
  63: 'logger',
};

/** FusionSolar devTypeId for the 'battery' device. */
export const HUAWEI_BATTERY_DEV_TYPE_ID = 39;
/** FusionSolar devTypeId for the 'ESS' device (the C&I / utility Smart String ESS). */
export const HUAWEI_ESS_DEV_TYPE_ID = 41;

/**
 * Both storage device types. Which one a site reports depends on the product
 * installed, so both are polled: covering only 39 would silently miss every
 * commercial Smart String ESS, which is the fleet the BESS program targets.
 */
export const HUAWEI_STORAGE_DEV_TYPE_IDS = [HUAWEI_BATTERY_DEV_TYPE_ID, HUAWEI_ESS_DEV_TYPE_ID];

/** Device types we poll for time-series data (inverters + EMI + storage). */
export const HUAWEI_POLLABLE_DEV_TYPE_IDS = [1, 38, 10, 39, 41];

const INVERTER_DEV_TYPE_IDS = new Set([1, 38]);
const STORAGE_DEV_TYPE_IDS = new Set(HUAWEI_STORAGE_DEV_TYPE_IDS);

export function isHuaweiStorageDevTypeId(devTypeId: number): boolean {
  return STORAGE_DEV_TYPE_IDS.has(devTypeId);
}

/** Field-mapping scope per devTypeId (see staticFieldMappings). */
function scopeForDevTypeId(devTypeId: number): 'inverter' | 'emi' | 'battery' | null {
  if (INVERTER_DEV_TYPE_IDS.has(devTypeId)) return 'inverter';
  if (devTypeId === 10) return 'emi';
  if (isHuaweiStorageDevTypeId(devTypeId)) return 'battery';
  return null;
}

// ---------------------------------------------------------------------------
// Static field mappings — FusionSolar dataItemMap key → DataFieldType
// ---------------------------------------------------------------------------
// original_field is scoped ('inverter.' / 'emi.') because the same vendor key
// (e.g. 'temperature') means internal inverter temp on devTypeId 1/38 but
// ambient temp on the EMI, and FieldMapping is unique per original_field.
// All values are DataFieldType member names (prisma/schema.prisma).

export const HUAWEI_STATIC_FIELD_MAPPINGS: StaticFieldMapping[] = [
  // Inverter (devTypeId 1 string inverter, 38 residential inverter)
  { original_field: 'inverter.active_power', mapped_field: 'power_ac', unit: 'kW', scaling_factor: 1 },
  { original_field: 'inverter.reactive_power', mapped_field: 'reactive_power', unit: 'kVar', scaling_factor: 1 },
  { original_field: 'inverter.mppt_power', mapped_field: 'power_dc', unit: 'kW', scaling_factor: 1 },
  { original_field: 'inverter.temperature', mapped_field: 'temp_inverter', unit: 'C', scaling_factor: 1 },
  { original_field: 'inverter.day_cap', mapped_field: 'energy_daily', unit: 'kWh', scaling_factor: 1 },
  { original_field: 'inverter.total_cap', mapped_field: 'energy_total', unit: 'kWh', scaling_factor: 1 },
  { original_field: 'inverter.elec_freq', mapped_field: 'frequency', unit: 'Hz', scaling_factor: 1 },
  { original_field: 'inverter.power_factor', mapped_field: 'power_factor', unit: '', scaling_factor: 1 },
  { original_field: 'inverter.run_state', mapped_field: 'status_code', unit: '', scaling_factor: 1 },
  { original_field: 'inverter.inverter_state', mapped_field: 'status_code', unit: '', scaling_factor: 1 },
  { original_field: 'inverter.a_u', mapped_field: 'voltage_ac_l1', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.b_u', mapped_field: 'voltage_ac_l2', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.c_u', mapped_field: 'voltage_ac_l3', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.a_i', mapped_field: 'current_ac_l1', unit: 'A', scaling_factor: 1 },
  { original_field: 'inverter.b_i', mapped_field: 'current_ac_l2', unit: 'A', scaling_factor: 1 },
  { original_field: 'inverter.c_i', mapped_field: 'current_ac_l3', unit: 'A', scaling_factor: 1 },
  // NOTE: 'inverter.efficiency' has no DataFieldType member — intentionally unmapped.

  // EMI — environmental monitor (devTypeId 10)
  { original_field: 'emi.radiation_intensity', mapped_field: 'irradiance_poa', unit: 'W/m2', scaling_factor: 1 },
  { original_field: 'emi.temperature', mapped_field: 'temp_ambient', unit: 'C', scaling_factor: 1 },
  { original_field: 'emi.pv_module_temperature', mapped_field: 'temp_module', unit: 'C', scaling_factor: 1 },
  { original_field: 'emi.wind_speed', mapped_field: 'wind_speed', unit: 'm/s', scaling_factor: 1 },
  { original_field: 'emi.wind_direction', mapped_field: 'wind_direction', unit: 'deg', scaling_factor: 1 },

  // Battery / ESS (devTypeId 39, 41) — see HUAWEI_BATTERY_CANDIDATE_KEYS below.
  // Deliberately empty: no FusionSolar battery dataItemMap key has been read
  // off the Northbound reference or a live account yet, and a wrong key either
  // drops the signal silently or, worse, files the wrong quantity under a
  // BESS DataFieldType. Battery keys therefore fall through to the existing
  // LLM/heuristic field mapper (field-mapping-llm.ts) instead, and every
  // unmapped key seen on the wire is recorded (getUnmappedKeys()) so the first
  // real ESS account tells us the names instead of us guessing them.
];

/**
 * TODO(verify): FusionSolar Northbound dataItemMap keys for devTypeId 39
 * (battery) and 41 (ESS).
 *
 * NOT wired into HUAWEI_STATIC_FIELD_MAPPINGS and must not be until each key is
 * read from Huawei's "SmartPVMS Northbound Interface Reference" (Real-Time
 * Device Data / 5-Minute Device Data sections, which need a Huawei support
 * login) or observed on a live account with storage. All that is attested today
 * is what those two devTypeIds mean; no public source prints their data-item
 * table, and the two device types may well not share one.
 *
 * Each entry is a plausible target slot, NOT a claimed vendor key name.
 * Fill `original_field` in from the source, then move the row up.
 */
export const HUAWEI_BATTERY_CANDIDATE_KEYS: Array<{
  /** DataFieldType member the verified key should map to. */
  mapped_field: string;
  unit: string;
  /** Why we expect this quantity to exist on an ESS device at all. */
  note: string;
}> = [
  { mapped_field: 'bess_soc', unit: '%', note: 'state of charge' },
  { mapped_field: 'bess_soh', unit: '%', note: 'state of health' },
  { mapped_field: 'bess_power_charge', unit: 'kW', note: 'charge power' },
  { mapped_field: 'bess_power_discharge', unit: 'kW', note: 'discharge power' },
  { mapped_field: 'bess_voltage_pack', unit: 'V', note: 'pack / bus voltage' },
  { mapped_field: 'bess_current', unit: 'A', note: 'pack current' },
  { mapped_field: 'bess_temp_pack', unit: 'C', note: 'pack temperature' },
  { mapped_field: 'bess_alarm_code', unit: '', note: 'alarm / fault code' },
];

const MAPPING_INDEX = new Map<string, StaticFieldMapping>(
  HUAWEI_STATIC_FIELD_MAPPINGS.map(m => [m.original_field, m])
);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface HuaweiCredentials {
  userName: string;
  systemCode: string;
}

/**
 * Resolve FusionSolar API credentials for a connection.
 * Preferred path: AWS Secrets Manager via DataConnection.secret_arn.
 * Fallback: plaintext config (legacy connections created before the
 * Secrets Manager migration — the discover route migrates them best-effort).
 */
export async function resolveHuaweiCredentials(
  connection: Pick<DataConnection, 'secret_arn' | 'config'>
): Promise<HuaweiCredentials> {
  if (connection.secret_arn) {
    try {
      const creds = await new CredentialService().getCredentials(connection.secret_arn);
      const userName = creds.userName || creds.username;
      const systemCode = creds.systemCode || creds.password;
      if (userName && systemCode) {
        return { userName, systemCode };
      }
      console.warn('Huawei secret is missing userName/systemCode, falling back to config');
    } catch (error) {
      console.warn('Failed to read Huawei secret, falling back to config:', error);
    }
  }

  const config = (connection.config || {}) as Record<string, any>;
  const userName = config.userName || config.username;
  const systemCode = config.systemCode || config.password;
  if (!userName || !systemCode) {
    throw new Error(
      'Huawei FusionSolar credentials not found (need userName + systemCode in Secrets Manager or connection config)'
    );
  }
  return { userName, systemCode };
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

export interface HuaweiServiceOptions {
  baseUrl?: string;
  credentials?: HuaweiCredentials;
  /** Older deployments only expose /thirdData/getStationList. */
  useLegacyStationList?: boolean;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Delay between sequential data calls (ms). Default 1000; tests use 0. */
  interCallDelayMs?: number;
  /** Wait before the single retry after failCode 407. Default 15s. */
  rateLimitBackoffMs?: number;
}

interface CachedToken {
  token: string;
  fetchedAt: number;
}

/** Module-level token cache: FusionSolar tolerates very few logins. */
const tokenCache = new Map<string, CachedToken>();

export class HuaweiFusionSolarService implements CloudVendorConnector {
  private baseUrl: string;
  private credentials: HuaweiCredentials | null;
  private useLegacyStationList: boolean;
  private fetchImpl: FetchLike;
  private interCallDelayMs: number;
  private rateLimitBackoffMs: number;

  /** Devices registered via discoverDevices()/setDeviceInventory(). */
  private deviceRegistry = new Map<string, NormalizedDevice>();

  /**
   * dataItemMap keys seen on the wire with no static mapping, keyed
   * '<scope>.<key>'. This is how unverified vendor schema (notably the
   * devTypeId 39/41 storage keys) gets discovered from a real account instead
   * of guessed — see getUnmappedKeys().
   */
  private unmappedKeys = new Map<string, HuaweiUnmappedKey>();

  constructor(options: HuaweiServiceOptions = {}) {
    this.baseUrl = (options.baseUrl || HUAWEI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.credentials = options.credentials || null;
    this.useLegacyStationList = options.useLegacyStationList ?? false;
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike);
    this.interCallDelayMs = options.interCallDelayMs ?? 1000;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 15_000;
  }

  // -- Legacy-compatible entry points (test-connection.ts, polling-service) --

  /** Configure from a DataConnection row (resolves credentials). */
  async connect(connection: DataConnection): Promise<void> {
    const config = (connection.config || {}) as Record<string, any>;
    if (config.baseUrl || config.base_url) {
      this.baseUrl = String(config.baseUrl || config.base_url).replace(/\/+$/, '');
    }
    if (config.useLegacyStationList === true || config.use_legacy_station_list === true) {
      this.useLegacyStationList = true;
    }
    this.credentials = await resolveHuaweiCredentials(connection);
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
        message: 'Huawei FusionSolar API connection successful',
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Huawei FusionSolar API connection failed',
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /** Legacy alias used by test-connection.ts. */
  async getPlantList(): Promise<NormalizedPlant[]> {
    return this.discoverPlants();
  }

  async close(): Promise<void> {
    // Token deliberately stays cached (module-level) — FusionSolar punishes
    // frequent logins. Nothing else to release.
  }

  // -- CloudVendorConnector ---------------------------------------------------

  async authenticate(): Promise<void> {
    await this.ensureToken();
  }

  async discoverPlants(): Promise<NormalizedPlant[]> {
    if (this.useLegacyStationList) {
      const data = await this.call('/thirdData/getStationList', {});
      const list: any[] = Array.isArray(data) ? data : [];
      return list.map(item => this.normalizePlant(item));
    }

    const plants: NormalizedPlant[] = [];
    let pageNo = 1;
    // FusionSolar paginates /thirdData/stations; pageCount comes back on page 1.
    for (;;) {
      const data = await this.call('/thirdData/stations', { pageNo, pageSize: 100 });
      const list: any[] = data?.list ?? [];
      plants.push(...list.map(item => this.normalizePlant(item)));
      const pageCount = Number(data?.pageCount ?? 1);
      if (list.length === 0 || pageNo >= pageCount) break;
      pageNo += 1;
      await this.sleep(this.interCallDelayMs);
    }
    return plants;
  }

  async discoverDevices(plantIds: string[]): Promise<NormalizedDevice[]> {
    const devices: NormalizedDevice[] = [];
    // stationCodes is comma-joined; keep batches conservative.
    for (const batch of chunk(plantIds, MAX_DEV_IDS_PER_CALL)) {
      const data = await this.call('/thirdData/getDevList', {
        stationCodes: batch.join(','),
      });
      const list: any[] = Array.isArray(data) ? data : [];
      for (const item of list) {
        const device = this.normalizeDevice(item);
        devices.push(device);
      }
      await this.sleep(this.interCallDelayMs);
    }
    this.setDeviceInventory(devices, /* merge */ true);
    return devices;
  }

  /** Register device inventory (e.g. restored from DiscoveredPlant metadata). */
  setDeviceInventory(devices: NormalizedDevice[], merge = false): void {
    if (!merge) this.deviceRegistry.clear();
    for (const device of devices) {
      this.deviceRegistry.set(String(device.external_device_id), device);
    }
  }

  getDeviceInventory(): NormalizedDevice[] {
    return Array.from(this.deviceRegistry.values());
  }

  /**
   * Vendor keys observed on the wire that no static mapping covers, with a
   * sample value. Feed these to the LLM/heuristic field mapper, or read them
   * off a real ESS account to fill in the battery mappings for good.
   */
  getUnmappedKeys(): HuaweiUnmappedKey[] {
    return Array.from(this.unmappedKeys.values()).map(k => ({ ...k }));
  }

  async backfill(deviceIds: string[], day: Date): Promise<NormalizedReading[]> {
    // collectTime: any ms epoch within the target day returns that day's 5-min rows.
    const collectTime = Date.UTC(
      day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0, 0
    );
    const readings: NormalizedReading[] = [];
    // Array.from: project tsconfig targets ES5 (no downlevelIteration).
    for (const [devTypeId, ids] of Array.from(this.groupPollableDevices(deviceIds).entries())) {
      for (const batch of chunk(ids, MAX_DEV_IDS_PER_CALL)) {
        const data = await this.call('/thirdData/getDevFiveMinutes', {
          devIds: batch.join(','),
          devTypeId,
          collectTime,
        });
        readings.push(...this.normalizeDataRows(data, devTypeId));
        await this.sleep(this.interCallDelayMs);
      }
    }
    return readings;
  }

  async pollRealtime(deviceIds?: string[]): Promise<NormalizedReading[]> {
    const readings: NormalizedReading[] = [];
    const pollTs = Date.now();
    for (const [devTypeId, ids] of Array.from(this.groupPollableDevices(deviceIds).entries())) {
      for (const batch of chunk(ids, MAX_DEV_IDS_PER_CALL)) {
        const data = await this.call('/thirdData/getDevRealKpi', {
          devIds: batch.join(','),
          devTypeId,
        });
        readings.push(...this.normalizeDataRows(data, devTypeId, pollTs));
        await this.sleep(this.interCallDelayMs);
      }
    }
    return readings;
  }

  staticFieldMappings(): StaticFieldMapping[] {
    return HUAWEI_STATIC_FIELD_MAPPINGS.map(m => ({ ...m }));
  }

  // -- HTTP layer -------------------------------------------------------------

  private cacheKey(): string {
    return `${this.baseUrl}::${this.credentials?.userName ?? ''}`;
  }

  private async ensureToken(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey());
    if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
      return cached.token;
    }
    return this.login(false);
  }

  private async login(force: boolean): Promise<string> {
    if (!this.credentials) {
      throw new Error('Huawei FusionSolar service has no credentials — call connect() first');
    }
    const key = this.cacheKey();
    const cached = tokenCache.get(key);
    // Rate-limit guard: FusionSolar locks accounts that login too often.
    if (!force && cached && Date.now() - cached.fetchedAt < MIN_LOGIN_INTERVAL_MS) {
      return cached.token;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/thirdData/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: this.credentials.userName,
        systemCode: this.credentials.systemCode,
      }),
    });
    if (!response.ok) {
      throw new Error(`FusionSolar login HTTP ${response.status}`);
    }
    const token = response.headers.get('xsrf-token');
    const body = await response.json().catch(() => ({}));
    if (!token || body?.success === false) {
      throw new Error(`FusionSolar login failed (failCode ${body?.failCode ?? 'unknown'})`);
    }
    tokenCache.set(key, { token, fetchedAt: Date.now() });
    return token;
  }

  /**
   * POST a thirdData endpoint, unwrap the {success, failCode, data} envelope.
   * failCode 305 → invalidate token + relogin + retry once.
   * failCode 407 → backoff + retry once.
   */
  private async call(
    path: string,
    body: Record<string, any>,
    attempted: { relogin?: boolean; backoff?: boolean } = {}
  ): Promise<any> {
    const token = await this.ensureToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'XSRF-TOKEN': token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`FusionSolar ${path} HTTP ${response.status}`);
    }
    const envelope = await response.json();
    if (envelope?.success) {
      return envelope.data;
    }

    const failCode = envelope?.failCode;
    if (failCode === FAIL_CODE_RELOGIN && !attempted.relogin) {
      tokenCache.delete(this.cacheKey());
      await this.login(true);
      return this.call(path, body, { ...attempted, relogin: true });
    }
    if (failCode === FAIL_CODE_RATE_LIMIT && !attempted.backoff) {
      await this.sleep(this.rateLimitBackoffMs);
      return this.call(path, body, { ...attempted, backoff: true });
    }
    throw new Error(
      `FusionSolar ${path} failed (failCode ${failCode ?? 'unknown'}${envelope?.message ? `: ${envelope.message}` : ''})`
    );
  }

  // -- Normalization ----------------------------------------------------------

  private normalizePlant(item: Record<string, any>): NormalizedPlant {
    // /stations uses plantCode/plantName/plantAddress; legacy getStationList
    // uses stationCode/stationName/stationAddr. Both report capacity in MW.
    const lat = toNumber(item.latitude);
    const lng = toNumber(item.longitude);
    return {
      external_plant_id: String(item.plantCode ?? item.stationCode ?? ''),
      name: String(item.plantName ?? item.stationName ?? item.plantCode ?? item.stationCode ?? ''),
      location: {
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        address: item.plantAddress ?? item.stationAddr ?? undefined,
      },
      capacity_mw: toNumber(item.capacity) ?? undefined,
      commissioning_date: item.gridConnectionDate ?? undefined,
      timezone: item.timeZone != null ? String(item.timeZone) : undefined,
      metadata: {
        contactPerson: item.contactPerson ?? undefined,
        contactMethod: item.contactMethod ?? undefined,
      },
    };
  }

  private normalizeDevice(item: Record<string, any>): NormalizedDevice {
    const devTypeId = Number(item.devTypeId);
    const vendorDeviceId = String(item.id);
    const metadata: Record<string, any> = {
      devDn: item.devDn ?? undefined,
      softwareVersion: item.softwareVersion ?? undefined,
    };

    if (isHuaweiStorageDevTypeId(devTypeId)) {
      // Canonical BESS grain (see cloud-connector.ts). external_device_id has
      // to stay the numeric vendor id because getDevFiveMinutes/getDevRealKpi
      // address devices by it, so the canonical id rides in metadata and is
      // what the readings carry.
      metadata.vendor_device_id = vendorDeviceId;
      // getDevList returns one row per storage device, so a device discovered
      // here lands at asset grain. Whether FusionSolar ever exposes rack-grain
      // rows is unverified; if it does, this is where the deeper grain gets
      // built. Otherwise deeper grains come from a direct BMS feed.
      metadata.bess_grain = 'asset';
      metadata.canonical_device_id = buildBessDeviceId({
        asset: sanitizeBessAssetToken(item.devName ?? '') || vendorDeviceId,
      });
    }

    return {
      // Data calls (getDevFiveMinutes/getDevRealKpi) key on the numeric id.
      external_device_id: vendorDeviceId,
      external_plant_id: String(item.stationCode ?? ''),
      name: item.devName ?? undefined,
      device_type: HUAWEI_DEV_TYPE_MAP[devTypeId] ?? 'other',
      vendor_type_id: devTypeId,
      model: item.invType ?? undefined,
      serial: item.esnCode ?? undefined,
      latitude: toNumber(item.latitude) ?? undefined,
      longitude: toNumber(item.longitude) ?? undefined,
      metadata,
    };
  }

  /**
   * Group requested devices by devTypeId, restricted to pollable types
   * (inverters + EMI + storage). Data calls must contain a single devTypeId.
   */
  private groupPollableDevices(deviceIds?: string[]): Map<number, string[]> {
    const wanted = deviceIds ? new Set(deviceIds.map(String)) : null;
    const groups = new Map<number, string[]>();
    for (const device of Array.from(this.deviceRegistry.values())) {
      const typeId = device.vendor_type_id;
      if (typeId == null || !HUAWEI_POLLABLE_DEV_TYPE_IDS.includes(typeId)) continue;
      if (wanted && !wanted.has(String(device.external_device_id))) continue;
      const ids = groups.get(typeId) ?? [];
      ids.push(String(device.external_device_id));
      groups.set(typeId, ids);
    }
    return groups;
  }

  /** Turn getDevFiveMinutes/getDevRealKpi rows into NormalizedReadings. */
  private normalizeDataRows(
    data: any,
    devTypeId: number,
    fallbackTs?: number
  ): NormalizedReading[] {
    const scope = scopeForDevTypeId(devTypeId);
    if (!scope) return [];
    const rows: any[] = Array.isArray(data) ? data : [];
    const readings: NormalizedReading[] = [];

    for (const row of rows) {
      const deviceId = String(row.devId ?? '');
      if (!deviceId) continue;
      const device = this.deviceRegistry.get(deviceId);
      const ts = toNumber(row.collectTime) ?? fallbackTs ?? Date.now();
      const dataItemMap: Record<string, any> = row.dataItemMap ?? {};

      // Batteries carry the canonical BESS grain id; PV keeps the vendor id.
      const emittedDeviceId =
        (device?.metadata?.canonical_device_id as string | undefined) || deviceId;

      for (const [key, rawValue] of Object.entries(dataItemMap)) {
        const mapping = MAPPING_INDEX.get(`${scope}.${key}`);
        if (!mapping) {
          this.recordUnmappedKey(scope, key, rawValue);
          continue;
        }
        const value = toNumber(rawValue);
        if (value === null) continue;
        readings.push({
          ts,
          plant_ext_id: device?.external_plant_id ?? '',
          device_ext_id: emittedDeviceId,
          device_type: device?.device_type ?? HUAWEI_DEV_TYPE_MAP[devTypeId] ?? scope,
          metric: mapping.mapped_field,
          value: value * (mapping.scaling_factor ?? 1),
          unit: mapping.unit,
        });
      }
    }
    return readings;
  }

  private recordUnmappedKey(scope: string, key: string, sampleValue: any): void {
    const scoped = `${scope}.${key}`;
    const existing = this.unmappedKeys.get(scoped);
    if (existing) {
      existing.seen += 1;
      return;
    }
    this.unmappedKeys.set(scoped, {
      scope,
      key,
      scoped_field: scoped,
      sample_value: sampleValue,
      seen: 1,
    });
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** One vendor key seen on the wire that no static mapping covers. */
export interface HuaweiUnmappedKey {
  /** 'inverter' | 'emi' | 'battery' */
  scope: string;
  /** Raw FusionSolar dataItemMap key. */
  key: string;
  /** '<scope>.<key>' — the FieldMapping.original_field it would need. */
  scoped_field: string;
  sample_value: any;
  seen: number;
}

/** Back-compat alias — older call sites import HuaweiAPIService. */
export class HuaweiAPIService extends HuaweiFusionSolarService {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
