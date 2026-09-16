/**
 * Cloud vendor connector contract.
 *
 * Every vendor-cloud integration (Huawei FusionSolar today; SolarEdge,
 * Solarman, Sungrow later) implements this small interface so discovery and
 * polling can be wired generically. Vendor API schemas are fixed, so each
 * connector ships its own static field mappings — the heuristic/LLM field
 * mapper is bypassed for cloud connectors.
 */

export interface NormalizedPlant {
  /** Plant identifier in the vendor system (e.g. FusionSolar plantCode). */
  external_plant_id: string;
  name: string;
  location?: {
    lat?: number;
    lng?: number;
    address?: string;
    country?: string;
  };
  /** Installed capacity in MW. */
  capacity_mw?: number;
  /** ISO date string when available (e.g. grid connection date). */
  commissioning_date?: string;
  timezone?: string;
  metadata?: Record<string, any>;
}

export interface NormalizedDevice {
  /** Device identifier used for data calls (e.g. FusionSolar numeric dev id). */
  external_device_id: string;
  external_plant_id: string;
  name?: string;
  /** Normalized device class: 'string_inverter' | 'residential_inverter' | 'emi' | 'battery' | 'power_sensor' | 'dongle' | 'logger' | 'other' */
  device_type: string;
  /** Vendor-native type id (e.g. FusionSolar devTypeId). */
  vendor_type_id?: number;
  model?: string;
  serial?: string;
  latitude?: number;
  longitude?: number;
  /**
   * Free-form vendor extras. Two keys are conventional across connectors:
   *   - `vendor_device_id`  raw vendor identifier when `external_device_id`
   *     carries a canonical id instead (see buildBessDeviceId below)
   *   - `canonical_device_id`  canonical id emitted on readings when the data
   *     calls still have to address the device by its raw vendor id
   */
  metadata?: Record<string, any>;
}

/**
 * One time-series point in long format. `metric` is always a DataFieldType
 * enum member name (the canonical taxonomy in prisma/schema.prisma).
 */
export interface NormalizedReading {
  /** Epoch milliseconds. */
  ts: number;
  plant_ext_id: string;
  device_ext_id: string;
  device_type?: string;
  /** DataFieldType member name, e.g. 'power_ac'. */
  metric: string;
  value: number;
  unit?: string;
}

/**
 * Static vendor-schema → DataFieldType mapping. `original_field` is scoped by
 * device class (e.g. 'inverter.active_power', 'emi.temperature') because the
 * same vendor key can mean different things on different device types and
 * FieldMapping is unique on (connection_id, original_field).
 */
export interface StaticFieldMapping {
  original_field: string;
  /** DataFieldType member name. */
  mapped_field: string;
  unit?: string;
  scaling_factor?: number;
}

// ---------------------------------------------------------------------------
// Canonical BESS device_ext_id grain
// ---------------------------------------------------------------------------
// Battery telemetry is hierarchical the way PV strings are, so it uses the same
// dotted-suffix convention as the PV ids ("INV 01.032.MPPT-1.STR-2"):
//
//   BESS <asset>                          asset      (whole battery asset)
//   BESS <asset>.U-<n>                    unit       (container / enclosure)
//   BESS <asset>.U-<n>.R-<k>              rack       (string / rack)
//   BESS <asset>.U-<n>.R-<k>.M-<m>        module
//   BESS <asset>.U-<n>.R-<k>.M-<m>.C-<c>  cell
//
// Identity lives in device_ext_id, NEVER in the metric name — a per-cell metric
// name would blow the DataFieldType enum up combinatorially. 'PLANT' stays
// reserved for plant-grain rollups and is never a BESS asset token.
//
// This is the single definition: the lakehouse writers and the drill-down API
// route import it rather than re-deriving the regex.
//
// All five levels parse. The analytics and serving stack deliberately stops at
// rack: silver_bess_telemetry attributes a module or cell row up to its rack and
// carries no deeper id, there is no gold below rack grain, and no metric names a
// cell. That is a product decision with vendor evidence behind it (per-cell data
// essentially never leaves the site, and ΔV from the reported max/min extremes
// is the imbalance signal exactly), not a backlog item. Reasoning, evidence and
// confidence caveats: docs/BESS_GRAIN_POLICY.md, pinned by
// tests/bess/test_grain_boundary.py.

/** Hierarchy levels a canonical BESS device_ext_id can address. */
export type BessDeviceGrain = 'asset' | 'unit' | 'rack' | 'module' | 'cell';

export interface BessDeviceIdParts {
  /** Asset token, e.g. 'athi-1'. Must not contain '.' and must not be 'PLANT'. */
  asset: string;
  /** Container / enclosure index. */
  unit?: number;
  /** Rack (string) index within the unit. */
  rack?: number;
  /** Module index within the rack. */
  module?: number;
  /** Cell index within the module. */
  cell?: number;
}

export interface ParsedBessDeviceId extends BessDeviceIdParts {
  grain: BessDeviceGrain;
  /** The canonical id this was parsed from. */
  device_ext_id: string;
}

export const BESS_DEVICE_ID_PREFIX = 'BESS ';

/** Reserved device_ext_id for plant-grain rollups — never a BESS asset token. */
export const PLANT_ROLLUP_DEVICE_ID = 'PLANT';

const BESS_DEVICE_ID_RE =
  /^BESS ([^.]+?)(?:\.U-(\d+))?(?:\.R-(\d+))?(?:\.M-(\d+))?(?:\.C-(\d+))?$/;

/**
 * Normalize a raw vendor label into an asset token: '.' is the grain separator
 * so it cannot survive, and surrounding/duplicate whitespace is collapsed.
 * Returns '' when nothing usable is left (callers should fall back to a vendor id).
 */
export function sanitizeBessAssetToken(raw: string): string {
  return String(raw ?? '')
    .replace(/\./g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a canonical BESS device_ext_id. Throws on an unusable asset token or a
 * gap in the hierarchy (a rack index without a unit index, etc.) — a silently
 * malformed id would key telemetry to a device nobody can find again.
 */
export function buildBessDeviceId(parts: BessDeviceIdParts): string {
  const asset = sanitizeBessAssetToken(parts.asset);
  if (!asset) {
    throw new Error('buildBessDeviceId: asset token is empty');
  }
  if (asset === PLANT_ROLLUP_DEVICE_ID) {
    throw new Error(`buildBessDeviceId: '${PLANT_ROLLUP_DEVICE_ID}' is reserved for plant rollups`);
  }

  const levels: Array<[string, number | undefined]> = [
    ['U', parts.unit],
    ['R', parts.rack],
    ['M', parts.module],
    ['C', parts.cell],
  ];

  let id = `${BESS_DEVICE_ID_PREFIX}${asset}`;
  let ended = false;
  for (const [token, index] of levels) {
    if (index === undefined || index === null) {
      ended = true;
      continue;
    }
    if (ended) {
      throw new Error('buildBessDeviceId: hierarchy has a gap (a level was skipped)');
    }
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`buildBessDeviceId: ${token} index must be a non-negative integer`);
    }
    id += `.${token}-${index}`;
  }
  return id;
}

/** Parse a canonical BESS device_ext_id. Returns null for anything else. */
export function parseBessDeviceId(deviceExtId: string): ParsedBessDeviceId | null {
  const match = BESS_DEVICE_ID_RE.exec(String(deviceExtId ?? ''));
  if (!match) return null;

  const asset = match[1].trim();
  if (!asset || asset === PLANT_ROLLUP_DEVICE_ID) return null;

  const unit = match[2] === undefined ? undefined : Number(match[2]);
  const rack = match[3] === undefined ? undefined : Number(match[3]);
  const moduleIndex = match[4] === undefined ? undefined : Number(match[4]);
  const cell = match[5] === undefined ? undefined : Number(match[5]);

  // A deeper level without its parent is not addressable — reject rather than
  // guess which level the caller meant.
  if (rack !== undefined && unit === undefined) return null;
  if (moduleIndex !== undefined && rack === undefined) return null;
  if (cell !== undefined && moduleIndex === undefined) return null;

  let grain: BessDeviceGrain = 'asset';
  if (cell !== undefined) grain = 'cell';
  else if (moduleIndex !== undefined) grain = 'module';
  else if (rack !== undefined) grain = 'rack';
  else if (unit !== undefined) grain = 'unit';

  return {
    device_ext_id: String(deviceExtId),
    asset,
    unit,
    rack,
    module: moduleIndex,
    cell,
    grain,
  };
}

export function isBessDeviceId(deviceExtId: string): boolean {
  return parseBessDeviceId(deviceExtId) !== null;
}

export interface CloudVendorConnector {
  /** Login / token refresh. Idempotent; connectors cache tokens internally. */
  authenticate(): Promise<void>;

  /** List plants (stations) visible to the API account. */
  discoverPlants(): Promise<NormalizedPlant[]>;

  /** List devices for the given plants and register them for data calls. */
  discoverDevices(plantIds: string[]): Promise<NormalizedDevice[]>;

  /** Fetch historical (e.g. 5-minute) data for one calendar day. */
  backfill(deviceIds: string[], day: Date): Promise<NormalizedReading[]>;

  /** Fetch current realtime KPIs. Empty deviceIds = all registered devices. */
  pollRealtime(deviceIds?: string[]): Promise<NormalizedReading[]>;

  /** Fixed vendor schema → DataFieldType mappings (confidence 1.0). */
  staticFieldMappings(): StaticFieldMapping[];
}
