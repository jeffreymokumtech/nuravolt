/**
 * SolarEdge monitoring API connector.
 *
 * Implements CloudVendorConnector against https://monitoringapi.solaredge.com:
 *   - GET /sites/list?size&startIndex        → paginated site list (account key)
 *   - GET /site/{siteId}/details             → single site (site-scoped key)
 *   - GET /site/{siteId}/inventory           → device inventory (inverters, meters, …)
 *   - GET /equipment/{siteId}/{sn}/data      → 5–15 min inverter telemetry (max ONE WEEK per call)
 *   - GET /site/{siteId}/power               → site-level 15-min power (max one month per call)
 *   - GET /site/{siteId}/energy              → site-level energy (timeUnit DAY / QUARTER_OF_AN_HOUR)
 *
 * Auth: the API key rides as the `api_key` query parameter on every call —
 * there is no login/token exchange. An account-level key exposes all sites;
 * a site-level key only works against /site/{siteId}/… (set config.site_id).
 * HTTP 401/403 = invalid key (SolarEdgeAuthError).
 *
 * Rate-limit discipline (SolarEdge allows 300 requests/day per site and 3
 * concurrent): every call is sequential with a polite minimum interval, and
 * HTTP 429 backs off once and retries before giving up (SolarEdgeRateLimitError).
 *
 * Time handling: equipment/power start/end params and response timestamps are
 * in the SITE's local timezone ("YYYY-MM-DD HH:MM:SS"). The IANA timezone
 * (location.timeZone) is captured at discovery and carried on every device
 * (metadata.site_time_zone) so the poll path can restore it from
 * DiscoveredPlant.metadata without re-discovering.
 */
import type { DataConnection } from '@prisma/client';
import { CredentialService } from './credentials';
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

export const SOLAREDGE_DEFAULT_BASE_URL = 'https://monitoringapi.solaredge.com';

/** /sites/list maximum page size. */
const SITES_PAGE_SIZE = 100;
/** /equipment/{siteId}/{sn}/data accepts at most one week per call. */
const MAX_EQUIPMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Trailing telemetry window fetched per inverter on a realtime poll. */
const DEFAULT_REALTIME_LOOKBACK_MS = 30 * 60 * 1000;

/** Inventory section → normalized device class. */
export const SOLAREDGE_INVENTORY_SECTION_MAP: Record<string, string> = {
  inverters: 'string_inverter',
  thirdPartyInverters: 'string_inverter',
  meters: 'power_sensor',
  batteries: 'battery',
  gateways: 'logger',
  sensors: 'other',
};

/** Device classes we poll for per-device telemetry (equipment data endpoint). */
export const SOLAREDGE_POLLABLE_DEVICE_TYPES = ['string_inverter'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SolarEdgeApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SolarEdgeApiError';
    this.status = status;
    // ES5 class-extends-Error pitfall: keep instanceof working.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 401/403 — invalid or unauthorized api_key. */
export class SolarEdgeAuthError extends SolarEdgeApiError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'SolarEdgeAuthError';
  }
}

/** HTTP 429 that persisted through the single backoff retry. */
export class SolarEdgeRateLimitError extends SolarEdgeApiError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'SolarEdgeRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Static field mappings — SolarEdge response key → DataFieldType
// ---------------------------------------------------------------------------
// original_field is scoped ('inverter.' for /equipment telemetry keys,
// 'site.' for site-level series) because FieldMapping is unique per
// original_field. SolarEdge reports power in W and energy in Wh; the platform
// convention (see Huawei mappings) stores kW/kWh, hence scaling 0.001.
// All mapped values are DataFieldType member names (prisma/schema.prisma).

export const SOLAREDGE_STATIC_FIELD_MAPPINGS: StaticFieldMapping[] = [
  // Inverter telemetry (/equipment/{siteId}/{sn}/data → telemetries[])
  { original_field: 'inverter.totalActivePower', mapped_field: 'power_ac', unit: 'kW', scaling_factor: 0.001 },
  { original_field: 'inverter.dcVoltage', mapped_field: 'voltage_dc', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.temperature', mapped_field: 'temp_inverter', unit: 'C', scaling_factor: 1 },
  { original_field: 'inverter.totalEnergy', mapped_field: 'energy_total', unit: 'kWh', scaling_factor: 0.001 },
  { original_field: 'inverter.L1Data.acVoltage', mapped_field: 'voltage_ac_l1', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.L2Data.acVoltage', mapped_field: 'voltage_ac_l2', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.L3Data.acVoltage', mapped_field: 'voltage_ac_l3', unit: 'V', scaling_factor: 1 },
  { original_field: 'inverter.L1Data.acCurrent', mapped_field: 'current_ac_l1', unit: 'A', scaling_factor: 1 },
  { original_field: 'inverter.L2Data.acCurrent', mapped_field: 'current_ac_l2', unit: 'A', scaling_factor: 1 },
  { original_field: 'inverter.L3Data.acCurrent', mapped_field: 'current_ac_l3', unit: 'A', scaling_factor: 1 },
  { original_field: 'inverter.L1Data.acFrequency', mapped_field: 'frequency', unit: 'Hz', scaling_factor: 1 },
  // NOTE: 'inverter.groundFaultResistance', 'inverter.powerLimit' and the
  // per-phase 'LxData.activePower' have no DataFieldType member — intentionally unmapped.

  // Site-level series (/site/{siteId}/power, /site/{siteId}/energy timeUnit=DAY)
  { original_field: 'site.power', mapped_field: 'power_ac', unit: 'kW', scaling_factor: 0.001 },
  { original_field: 'site.energy', mapped_field: 'energy_daily', unit: 'kWh', scaling_factor: 0.001 },
];

const MAPPING_INDEX = new Map<string, StaticFieldMapping>(
  SOLAREDGE_STATIC_FIELD_MAPPINGS.map(m => [m.original_field, m])
);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface SolarEdgeCredentials {
  apiKey: string;
}

/**
 * Resolve SolarEdge monitoring API credentials for a connection.
 * Preferred path: AWS Secrets Manager via DataConnection.secret_arn (secret
 * payload is `{ api_key }`). Fallback: plaintext config (legacy connections —
 * the discover route migrates them best-effort).
 */
export async function resolveSolarEdgeCredentials(
  connection: Pick<DataConnection, 'secret_arn' | 'config'>
): Promise<SolarEdgeCredentials> {
  if (connection.secret_arn) {
    try {
      const creds = await new CredentialService().getCredentials(connection.secret_arn);
      const apiKey = creds.api_key || creds.apiKey;
      if (apiKey) {
        return { apiKey };
      }
      console.warn('SolarEdge secret is missing api_key, falling back to config');
    } catch (error) {
      console.warn('Failed to read SolarEdge secret, falling back to config:', error);
    }
  }

  const config = (connection.config || {}) as Record<string, any>;
  const apiKey = config.api_key || config.apiKey;
  if (!apiKey) {
    throw new Error(
      'SolarEdge monitoring API credentials not found (need api_key in Secrets Manager or connection config)'
    );
  }
  return { apiKey };
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

export interface SolarEdgeServiceOptions {
  baseUrl?: string;
  credentials?: SolarEdgeCredentials;
  /** Site-level API keys can't list sites — pin discovery to this site id. */
  siteId?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Polite minimum interval between sequential calls (ms). Default 1000; tests use 0. */
  interCallDelayMs?: number;
  /** Wait before the single retry after HTTP 429. Default 60s. */
  rateLimitBackoffMs?: number;
  /** Trailing telemetry window per inverter on pollRealtime. Default 30 min. */
  realtimeLookbackMs?: number;
}

export class SolarEdgeMonitoringService implements CloudVendorConnector {
  private baseUrl: string;
  private credentials: SolarEdgeCredentials | null;
  private siteId: string | null;
  private fetchImpl: FetchLike;
  private interCallDelayMs: number;
  private rateLimitBackoffMs: number;
  private realtimeLookbackMs: number;

  /** Devices registered via discoverDevices()/setDeviceInventory(). */
  private deviceRegistry = new Map<string, NormalizedDevice>();
  /** Site id → IANA timezone, captured by discoverPlants(). */
  private siteTimezones = new Map<string, string>();
  /** Key verified against the API (authenticate() is idempotent). */
  private keyVerified = false;
  /** Epoch ms of the last outbound call — enforces the polite interval. */
  private lastCallAt = 0;

  constructor(options: SolarEdgeServiceOptions = {}) {
    this.baseUrl = (options.baseUrl || SOLAREDGE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.credentials = options.credentials || null;
    this.siteId = options.siteId || null;
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike);
    this.interCallDelayMs = options.interCallDelayMs ?? 1000;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 60_000;
    this.realtimeLookbackMs = options.realtimeLookbackMs ?? DEFAULT_REALTIME_LOOKBACK_MS;
  }

  // -- Legacy-compatible entry points (test-connection.ts, polling-service) --

  /** Configure from a DataConnection row (resolves credentials). */
  async connect(connection: DataConnection): Promise<void> {
    const config = (connection.config || {}) as Record<string, any>;
    if (config.baseUrl || config.base_url) {
      this.baseUrl = String(config.baseUrl || config.base_url).replace(/\/+$/, '');
    }
    if (config.site_id || config.siteId) {
      this.siteId = String(config.site_id || config.siteId);
    }
    this.credentials = await resolveSolarEdgeCredentials(connection);
    this.keyVerified = false;
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
        message: 'SolarEdge monitoring API connection successful',
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        message: 'SolarEdge monitoring API connection failed',
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
    // Nothing to release — the API is stateless (key-per-request, no session).
  }

  // -- CloudVendorConnector ---------------------------------------------------

  async authenticate(): Promise<void> {
    if (!this.credentials?.apiKey) {
      throw new Error('SolarEdge service has no credentials — call connect() first');
    }
    if (this.keyVerified) return;
    // No login endpoint exists; verify the key with the cheapest read that the
    // key class supports (site-level keys 403 on /sites/list).
    if (this.siteId) {
      await this.call(`/site/${this.siteId}/details`, {});
    } else {
      await this.call('/sites/list', { size: 1, startIndex: 0 });
    }
    this.keyVerified = true;
  }

  async discoverPlants(): Promise<NormalizedPlant[]> {
    if (this.siteId) {
      const data = await this.call(`/site/${this.siteId}/details`, {});
      const plant = this.normalizeSite(data?.details ?? {});
      this.keyVerified = true;
      return plant.external_plant_id ? [plant] : [];
    }

    const plants: NormalizedPlant[] = [];
    let startIndex = 0;
    // /sites/list paginates via startIndex; sites.count comes back on every page.
    for (;;) {
      const data = await this.call('/sites/list', { size: SITES_PAGE_SIZE, startIndex });
      const list: any[] = data?.sites?.site ?? [];
      plants.push(...list.map(item => this.normalizeSite(item)));
      const total = Number(data?.sites?.count ?? plants.length);
      startIndex += list.length;
      if (list.length === 0 || startIndex >= total) break;
    }
    this.keyVerified = true;
    return plants;
  }

  async discoverDevices(plantIds: string[]): Promise<NormalizedDevice[]> {
    const devices: NormalizedDevice[] = [];
    // One inventory call per site, sequential (rate-limit discipline).
    for (const plantId of plantIds) {
      const data = await this.call(`/site/${plantId}/inventory`, {});
      const inventory: Record<string, any> = data?.Inventory ?? data?.inventory ?? {};
      for (const [section, deviceType] of Array.from(
        Object.entries(SOLAREDGE_INVENTORY_SECTION_MAP)
      )) {
        const list: any[] = Array.isArray(inventory[section]) ? inventory[section] : [];
        for (let i = 0; i < list.length; i += 1) {
          devices.push(this.normalizeDevice(list[i], section, deviceType, String(plantId), i));
        }
      }
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

  async backfill(deviceIds: string[], day: Date): Promise<NormalizedReading[]> {
    // One site-local calendar day of telemetry per inverter. A single day is
    // far below the one-week window limit, so this is one call per device.
    const dayStr = utcDayString(day);
    const readings: NormalizedReading[] = [];
    for (const device of this.pollableDevices(deviceIds)) {
      const timeZone = this.timezoneForSite(device.external_plant_id, device);
      const startMs = siteLocalToEpochMs(`${dayStr} 00:00:00`, timeZone);
      const endMs = siteLocalToEpochMs(`${dayStr} 23:59:59`, timeZone);
      readings.push(
        ...(await this.fetchEquipmentData(
          device.external_plant_id,
          device.external_device_id,
          startMs,
          endMs
        ))
      );
    }
    return readings;
  }

  async pollRealtime(deviceIds?: string[]): Promise<NormalizedReading[]> {
    const pollTs = Date.now();
    const readings: NormalizedReading[] = [];
    const inverters = this.pollableDevices(deviceIds);

    // Site-level KPIs: one power + one energy call per site.
    for (const siteId of this.registeredSiteIds(deviceIds)) {
      const timeZone = this.timezoneForSite(siteId);
      readings.push(...(await this.fetchSitePower(siteId, pollTs - this.realtimeLookbackMs, pollTs, timeZone)));
      readings.push(...(await this.fetchSiteDailyEnergy(siteId, pollTs, timeZone)));
    }

    // Per-inverter telemetry for the trailing lookback window.
    for (const device of inverters) {
      readings.push(
        ...(await this.fetchEquipmentData(
          device.external_plant_id,
          device.external_device_id,
          pollTs - this.realtimeLookbackMs,
          pollTs
        ))
      );
    }
    return readings;
  }

  staticFieldMappings(): StaticFieldMapping[] {
    return SOLAREDGE_STATIC_FIELD_MAPPINGS.map(m => ({ ...m }));
  }

  // -- Telemetry fetchers -----------------------------------------------------

  /**
   * Fetch inverter telemetry for [startMs, endMs], chunked into sequential
   * ≤ one-week windows (hard API limit). Times are sent in the site's local
   * timezone, as the API requires.
   */
  async fetchEquipmentData(
    siteId: string,
    serialNumber: string,
    startMs: number,
    endMs: number
  ): Promise<NormalizedReading[]> {
    const device = this.deviceRegistry.get(String(serialNumber));
    const timeZone = this.timezoneForSite(String(siteId), device);
    const readings: NormalizedReading[] = [];

    let windowStart = startMs;
    while (windowStart < endMs) {
      const windowEnd = Math.min(windowStart + MAX_EQUIPMENT_WINDOW_MS, endMs);
      const data = await this.call(`/equipment/${siteId}/${serialNumber}/data`, {
        startTime: formatSiteLocalTime(windowStart, timeZone),
        endTime: formatSiteLocalTime(windowEnd, timeZone),
      });
      const telemetries: any[] = data?.data?.telemetries ?? [];
      readings.push(
        ...this.normalizeTelemetries(telemetries, String(siteId), String(serialNumber), timeZone, device)
      );
      windowStart = windowEnd;
    }
    return readings;
  }

  /** Site-level 15-min power series → 'site.power' readings. */
  private async fetchSitePower(
    siteId: string,
    startMs: number,
    endMs: number,
    timeZone: string
  ): Promise<NormalizedReading[]> {
    const mapping = MAPPING_INDEX.get('site.power')!;
    const data = await this.call(`/site/${siteId}/power`, {
      startTime: formatSiteLocalTime(startMs, timeZone),
      endTime: formatSiteLocalTime(endMs, timeZone),
    });
    const values: any[] = data?.power?.values ?? [];
    const readings: NormalizedReading[] = [];
    for (const entry of values) {
      const value = toNumber(entry?.value);
      if (value === null) continue; // null-padded future slots
      readings.push({
        ts: entry?.date ? siteLocalToEpochMs(String(entry.date), timeZone) : Date.now(),
        plant_ext_id: String(siteId),
        device_ext_id: String(siteId),
        device_type: 'site',
        metric: mapping.mapped_field,
        value: value * (mapping.scaling_factor ?? 1),
        unit: mapping.unit,
      });
    }
    return readings;
  }

  /** Today's site energy (timeUnit=DAY) → one 'site.energy' reading. */
  private async fetchSiteDailyEnergy(
    siteId: string,
    pollTs: number,
    timeZone: string
  ): Promise<NormalizedReading[]> {
    const mapping = MAPPING_INDEX.get('site.energy')!;
    const dayStr = formatSiteLocalTime(pollTs, timeZone).slice(0, 10);
    const data = await this.call(`/site/${siteId}/energy`, {
      timeUnit: 'DAY',
      startDate: dayStr,
      endDate: dayStr,
    });
    const values: any[] = data?.energy?.values ?? [];
    const value = values.length > 0 ? toNumber(values[0]?.value) : null;
    if (value === null) return [];
    return [
      {
        ts: pollTs, // energy-so-far as of the poll, not site-local midnight
        plant_ext_id: String(siteId),
        device_ext_id: String(siteId),
        device_type: 'site',
        metric: mapping.mapped_field,
        value: value * (mapping.scaling_factor ?? 1),
        unit: mapping.unit,
      },
    ];
  }

  // -- HTTP layer -------------------------------------------------------------

  /**
   * GET an endpoint with api_key + params in the query string.
   * HTTP 401/403 → SolarEdgeAuthError (invalid key — no point retrying).
   * HTTP 429 → backoff + retry once, then SolarEdgeRateLimitError.
   */
  private async call(
    path: string,
    params: Record<string, string | number>,
    attempted: { backoff?: boolean } = {}
  ): Promise<any> {
    if (!this.credentials?.apiKey) {
      throw new Error('SolarEdge service has no credentials — call connect() first');
    }
    await this.politeDelay();

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('api_key', this.credentials.apiKey);
    for (const [key, value] of Array.from(Object.entries(params))) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url.toString(), { method: 'GET' });
    if (response.status === 401 || response.status === 403) {
      throw new SolarEdgeAuthError(
        `SolarEdge ${path} HTTP ${response.status} — invalid or unauthorized api_key`,
        response.status
      );
    }
    if (response.status === 429) {
      if (!attempted.backoff) {
        await this.sleep(this.rateLimitBackoffMs);
        return this.call(path, params, { ...attempted, backoff: true });
      }
      throw new SolarEdgeRateLimitError(
        `SolarEdge ${path} HTTP 429 — rate limit still exceeded after backoff (300 req/day per site)`
      );
    }
    if (!response.ok) {
      throw new SolarEdgeApiError(`SolarEdge ${path} HTTP ${response.status}`, response.status);
    }
    return response.json();
  }

  /** Enforce the polite minimum interval between sequential calls. */
  private async politeDelay(): Promise<void> {
    const wait = this.lastCallAt + this.interCallDelayMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = Date.now();
  }

  // -- Normalization ----------------------------------------------------------

  private normalizeSite(item: Record<string, any>): NormalizedPlant {
    const location = (item.location ?? {}) as Record<string, any>;
    const id = item.id != null ? String(item.id) : '';
    const timezone = location.timeZone != null ? String(location.timeZone) : undefined;
    if (id && timezone) {
      this.siteTimezones.set(id, timezone);
    }
    const address = [location.address, location.city]
      .filter((part): part is string => !!part)
      .join(', ');
    const peakPowerKwp = toNumber(item.peakPower);
    return {
      external_plant_id: id,
      name: String(item.name ?? id),
      location: {
        lat: toNumber(location.latitude) ?? undefined,
        lng: toNumber(location.longitude) ?? undefined,
        address: address || undefined,
        country: location.country ?? undefined,
      },
      // peakPower is kWp → MW
      capacity_mw: peakPowerKwp !== null ? peakPowerKwp / 1000 : undefined,
      commissioning_date: item.installationDate ?? undefined,
      timezone,
      metadata: {
        status: item.status ?? undefined,
        notes: item.notes ?? undefined,
      },
    };
  }

  private normalizeDevice(
    item: Record<string, any>,
    section: string,
    deviceType: string,
    plantId: string,
    index: number
  ): NormalizedDevice {
    // Equipment data calls key on the inverter serial number.
    const serial = item.SN ?? item.serialNumber ?? undefined;
    const externalId = serial ?? `${plantId}:${section}:${item.name ?? index}`;
    return {
      external_device_id: String(externalId),
      external_plant_id: plantId,
      name: item.name ?? undefined,
      device_type: deviceType,
      model: item.model ?? undefined,
      serial: serial != null ? String(serial) : undefined,
      metadata: {
        manufacturer: item.manufacturer ?? undefined,
        category: section,
        connectedOptimizers: item.connectedOptimizers ?? undefined,
        // Equipment/power calls need the site timezone; carrying it on the
        // device lets the poll path restore it from DiscoveredPlant metadata.
        site_time_zone: this.siteTimezones.get(plantId),
      },
    };
  }

  /** Turn /equipment telemetries[] rows into NormalizedReadings. */
  private normalizeTelemetries(
    telemetries: any[],
    siteId: string,
    serialNumber: string,
    timeZone: string,
    device?: NormalizedDevice
  ): NormalizedReading[] {
    const readings: NormalizedReading[] = [];
    for (const row of telemetries) {
      if (!row || typeof row !== 'object') continue;
      const ts = row.date ? siteLocalToEpochMs(String(row.date), timeZone) : Date.now();

      // Flatten one level of nesting (L1Data.acVoltage etc.) to match the
      // scoped mapping keys.
      const flat: Record<string, any> = {};
      for (const [key, value] of Array.from(Object.entries(row as Record<string, any>))) {
        if (key === 'date') continue;
        if (value !== null && typeof value === 'object') {
          for (const [nestedKey, nestedValue] of Array.from(
            Object.entries(value as Record<string, any>)
          )) {
            flat[`${key}.${nestedKey}`] = nestedValue;
          }
        } else {
          flat[key] = value;
        }
      }

      for (const [key, rawValue] of Array.from(Object.entries(flat))) {
        const mapping = MAPPING_INDEX.get(`inverter.${key}`);
        if (!mapping) continue;
        const value = toNumber(rawValue);
        if (value === null) continue;
        readings.push({
          ts,
          plant_ext_id: device?.external_plant_id ?? siteId,
          device_ext_id: serialNumber,
          device_type: device?.device_type ?? 'string_inverter',
          metric: mapping.mapped_field,
          value: value * (mapping.scaling_factor ?? 1),
          unit: mapping.unit,
        });
      }
    }
    return readings;
  }

  // -- Registry helpers -------------------------------------------------------

  /** Registered devices we can poll (inverters with a real serial number). */
  private pollableDevices(deviceIds?: string[]): NormalizedDevice[] {
    const wanted = deviceIds ? new Set(deviceIds.map(String)) : null;
    const devices: NormalizedDevice[] = [];
    for (const device of Array.from(this.deviceRegistry.values())) {
      if (!SOLAREDGE_POLLABLE_DEVICE_TYPES.includes(device.device_type)) continue;
      if (!device.serial) continue;
      if (wanted && !wanted.has(String(device.external_device_id))) continue;
      devices.push(device);
    }
    return devices;
  }

  /** Unique site ids across the (optionally filtered) device registry. */
  private registeredSiteIds(deviceIds?: string[]): string[] {
    const wanted = deviceIds ? new Set(deviceIds.map(String)) : null;
    const siteIds = new Set<string>();
    for (const device of Array.from(this.deviceRegistry.values())) {
      if (wanted && !wanted.has(String(device.external_device_id))) continue;
      siteIds.add(String(device.external_plant_id));
    }
    return Array.from(siteIds.values());
  }

  /** Site tz: discoverPlants() capture → device metadata → UTC fallback. */
  private timezoneForSite(siteId: string, device?: NormalizedDevice): string {
    const captured = this.siteTimezones.get(String(siteId));
    if (captured) return captured;
    const fromDevice = device?.metadata?.site_time_zone;
    if (fromDevice) return String(fromDevice);
    for (const registered of Array.from(this.deviceRegistry.values())) {
      if (String(registered.external_plant_id) !== String(siteId)) continue;
      const tz = registered.metadata?.site_time_zone;
      if (tz) return String(tz);
    }
    return 'UTC';
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Helpers — site-local time (the API speaks the site's timezone, not UTC)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      // Unknown IANA zone — degrade to UTC rather than failing the poll.
      dtf = formatterFor('UTC');
    }
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

function zoneParts(epochMs: number, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Epoch ms → "YYYY-MM-DD HH:MM:SS" in the given zone. */
export function formatSiteLocalTime(epochMs: number, timeZone: string): string {
  const p = zoneParts(epochMs, timeZone);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)} ` +
    `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`
  );
}

/** Zone offset such that epoch + offset = wall-clock-as-UTC. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zoneParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epochMs;
}

/** "YYYY-MM-DD HH:MM:SS" wall-clock in the given zone → epoch ms. */
export function siteLocalToEpochMs(dateStr: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(dateStr.trim());
  if (!match) {
    const fallback = Date.parse(dateStr);
    return Number.isFinite(fallback) ? fallback : Date.now();
  }
  const asUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0)
  );
  // Two-pass offset resolution (handles DST transitions near the timestamp).
  const guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(guess, timeZone);
}

/** UTC calendar date of a Date → "YYYY-MM-DD". */
function utcDayString(day: Date): string {
  return `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
