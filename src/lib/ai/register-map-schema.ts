/**
 * Pure schema + parsing helpers for the Modbus register-map auto-mapper.
 *
 * This module is intentionally dependency-free (no Prisma, no AWS SDK) so it
 * can be imported from both server code (register-map-llm.ts, the
 * /register-map API route) and client components (RegisterMapUploader) as
 * well as the fixture-based test script.
 *
 * The LLM-facing extraction logic lives in ./register-map-llm.ts.
 */

// ============================================================================
// Closed taxonomy — must mirror the DataFieldType enum in prisma/schema.prisma
// (same discipline as src/lib/services/field-mapping-llm.ts)
// ============================================================================
export const VALID_FIELD_TYPES: readonly string[] = [
  // PV measurements
  'power_ac', 'power_dc', 'reactive_power',
  'voltage_dc', 'voltage_ac_l1', 'voltage_ac_l2', 'voltage_ac_l3',
  'current_dc', 'current_ac_l1', 'current_ac_l2', 'current_ac_l3',
  'irradiance_poa', 'irradiance_ghi', 'irradiance_dni',
  'temp_module', 'temp_ambient', 'temp_inverter',
  'energy_daily', 'energy_total', 'power_loss', 'financial_impact',
  // Weather
  'wind_speed', 'humidity', 'precipitation', 'soiling_ratio',
  // Electrical
  'frequency', 'power_factor',
  // Status & identifiers
  'status_code', 'alarm_code',
  'plant_id', 'inverter_id', 'string_id', 'timestamp',
  // BESS
  'bess_soc', 'bess_soh', 'bess_power_charge', 'bess_power_discharge',
  'bess_temp_cell', 'bess_temp_pack', 'bess_temp_ambient',
  'bess_voltage_cell', 'bess_voltage_pack', 'bess_current', 'bess_c_rate',
  'bess_cycle_count', 'bess_throughput', 'bess_rte',
  'bess_hvac_status', 'bess_contactor_status',
  // Wind
  'wind_power', 'wind_direction', 'wind_rotor_rpm', 'wind_nacelle_temp',
  'wind_pitch_angle', 'wind_yaw_angle', 'wind_availability',
  // Explicit "could not map"
  'unmapped',
];

// ============================================================================
// Modbus data-type whitelist + alias normalization
// ============================================================================
export const VALID_DATA_TYPES: readonly string[] = [
  'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'float32', 'float64', 'string', 'bool',
  'bitfield16', 'bitfield32', 'enum16', 'acc32', 'acc64', 'sunssf',
];

export const DEFAULT_DATA_TYPE = 'uint16';

const DATA_TYPE_ALIASES: Record<string, string> = {
  u16: 'uint16', uint: 'uint16', ushort: 'uint16', word: 'uint16', uword: 'uint16',
  s16: 'int16', i16: 'int16', sint16: 'int16', int: 'int16', short: 'int16',
  u32: 'uint32', dword: 'uint32', udword: 'uint32', ulong: 'uint32',
  s32: 'int32', i32: 'int32', sint32: 'int32', long: 'int32',
  u64: 'uint64', s64: 'int64', i64: 'int64',
  f32: 'float32', float: 'float32', real: 'float32', single: 'float32',
  f64: 'float64', double: 'float64',
  boolean: 'bool', bit: 'bool',
  ascii: 'string', text: 'string', str: 'string', char: 'string', utf8: 'string',
  bitfield: 'bitfield16', enum: 'enum16',
  acc: 'acc32', accumulator: 'acc32',
};

/**
 * Normalize a raw data-type token to the whitelist. Unknown tokens fall back
 * to `uint16` (the safe single-register Modbus default) rather than being
 * rejected — a register with an unrecognized type note is still a register.
 */
export function normalizeDataType(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return DEFAULT_DATA_TYPE;
  if (VALID_DATA_TYPES.includes(s)) return s;
  if (DATA_TYPE_ALIASES[s]) return DATA_TYPE_ALIASES[s];
  return DEFAULT_DATA_TYPE;
}

// ============================================================================
// Result types
// ============================================================================
export interface ExtractedRegister {
  /** Modbus register address, decimal, >= 0 */
  address: number;
  /** Register / signal name from the source document */
  name: string;
  /** One of VALID_DATA_TYPES (normalized) */
  dataType: string;
  unit?: string;
  /** Multiplier from raw register value to engineering unit (gain) */
  scale?: number;
  byteOrder?: string;
  /** DataFieldType member or 'unmapped' */
  mapped_field: string;
  confidence: number;
  source_excerpt?: string;
}

export type RegisterMapMethod = 'csv+llm' | 'csv+heuristic' | 'llm' | 'none';

export interface RegisterMapResult {
  registers: ExtractedRegister[];
  vendor?: string;
  model?: string;
  notes?: string;
  /** Which extraction path produced the result */
  method: RegisterMapMethod;
}

// ============================================================================
// Confidence clamp — identical to field-mapping-llm.ts:
//   floor 0.5 (LLM-derived values always need operator review headroom),
//   ceiling 0.85 (never outrank a high-confidence deterministic match).
// ============================================================================
export function clampLlmConfidence(value: unknown): number {
  const n = Number(value);
  return Math.min(0.85, Math.max(0.5, Number.isFinite(n) ? n : 0.65));
}

// ============================================================================
// Row validation (used on every LLM-extracted row)
// ============================================================================

function parseAddress(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  const s = String(raw ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/**
 * Validate a raw (LLM-emitted) register row against the closed schema.
 * Returns null when the row is structurally unusable (bad address / no name);
 * out-of-taxonomy mapped_field values are coerced to 'unmapped' and
 * confidence is clamped to [0.5, 0.85].
 */
export function validateExtractedRegister(raw: any): ExtractedRegister | null {
  if (!raw || typeof raw !== 'object') return null;

  const address = parseAddress(raw.address);
  if (address === null) return null;

  const name = String(raw.name ?? '').trim();
  if (!name) return null;

  const mapped =
    typeof raw.mapped_field === 'string' && VALID_FIELD_TYPES.includes(raw.mapped_field)
      ? raw.mapped_field
      : 'unmapped';

  const scaleNum = Number(raw.scale);
  const scale = Number.isFinite(scaleNum) && scaleNum !== 0 ? scaleNum : undefined;

  const unit =
    typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim().slice(0, 16) : undefined;
  const byteOrder =
    typeof raw.byteOrder === 'string' && raw.byteOrder.trim()
      ? raw.byteOrder.trim().slice(0, 32)
      : undefined;
  const excerpt =
    typeof raw.source_excerpt === 'string' && raw.source_excerpt.trim()
      ? raw.source_excerpt.trim().slice(0, 240)
      : undefined;

  return {
    address,
    name: name.slice(0, 120),
    dataType: normalizeDataType(raw.dataType),
    unit,
    scale,
    byteOrder,
    mapped_field: mapped,
    confidence: clampLlmConfidence(raw.confidence),
    source_excerpt: excerpt,
  };
}

// ============================================================================
// Deterministic CSV/TSV fast path
// ============================================================================

export interface ParsedCsvRegisterMap {
  /** Rows with mapped_field='unmapped', confidence=0 — mapping is assigned later */
  registers: ExtractedRegister[];
  delimiter: string;
  headerColumns: string[];
  /** Data rows attempted (excluding the header) */
  rowCount: number;
  /** Rows dropped for a non-numeric/negative address or empty name */
  skippedRows: number;
}

function normalizeHeaderCell(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAddressHeader(h: string): boolean {
  if (h.includes('name') || h.includes('desc')) return false;
  return (
    h.includes('address') ||
    h.includes('addr') ||
    h === 'register' ||
    h === 'reg' ||
    h === 'regno' ||
    h === 'regnr' ||
    h === 'registernumber' ||
    h === 'offset' ||
    h === 'registeroffset'
  );
}

function findNameColumn(headers: string[], addressIdx: number): number {
  const groups: Array<(h: string) => boolean> = [
    h => h.includes('name'),
    h => h.includes('signal') || h.includes('parameter') || h.includes('label') ||
         h === 'tag' || h === 'field' || h === 'datapoint' || h === 'point' ||
         h === 'quantity' || h === 'measurement',
    h => h.includes('desc'),
  ];
  for (const match of groups) {
    const idx = headers.findIndex((h, i) => i !== addressIdx && match(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

function detectDelimiter(line: string): string | null {
  const candidates: Array<[string, number]> = [
    ['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    [',', (line.match(/,/g) || []).length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : null;
}

/** Minimal delimited-line splitter with double-quote support. */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map(c => c.trim().replace(/^"|"$/g, '').trim());
}

function parseScaleCell(cell: string | undefined): number | undefined {
  if (!cell) return undefined;
  const s = cell.trim();
  const frac = s.match(/^1\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const denom = Number(frac[1]);
    return denom !== 0 ? 1 / denom : undefined;
  }
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

/**
 * Deterministic CSV/TSV register-export parser. Returns null when the text
 * does not look like a delimited register table (no header row with both an
 * address-like and a name-like column, or too few valid data rows) — the
 * caller then falls through to the LLM full-extraction path.
 */
export function parseRegisterCsv(text: string): ParsedCsvRegisterMap | null {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;

  // The header may not be the first line (title rows above it are common in
  // vendor exports) — scan the first few lines for a plausible header.
  let headerIdx = -1;
  let delimiter: string | null = null;
  let addressIdx = -1;
  let nameIdx = -1;
  let headers: string[] = [];

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const delim = detectDelimiter(lines[i]);
    if (!delim) continue;
    const cells = splitDelimited(lines[i], delim).map(normalizeHeaderCell);
    const aIdx = cells.findIndex(isAddressHeader);
    if (aIdx < 0) continue;
    const nIdx = findNameColumn(cells, aIdx);
    if (nIdx < 0) continue;
    headerIdx = i;
    delimiter = delim;
    addressIdx = aIdx;
    nameIdx = nIdx;
    headers = cells;
    break;
  }

  if (headerIdx < 0 || !delimiter) return null;

  const dataTypeIdx = headers.findIndex(
    h => h.includes('datatype') || h === 'type' || h === 'format' ||
         h.includes('valuetype') || h === 'dataformat'
  );
  const unitIdx = headers.findIndex(
    h => h === 'unit' || h === 'units' || h === 'uom' || h.includes('engineeringunit')
  );
  const scaleIdx = headers.findIndex(
    h => h === 'scale' || h === 'scaling' || h.includes('scalefactor') ||
         h === 'gain' || h === 'multiplier' || h === 'factor' ||
         h === 'ratio' || h === 'resolution'
  );
  const byteOrderIdx = headers.findIndex(
    h => h.includes('byteorder') || h.includes('endian') || h.includes('wordorder')
  );

  const registers: ExtractedRegister[] = [];
  let rowCount = 0;
  let skippedRows = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitDelimited(lines[i], delimiter);
    if (cells.every(c => c === '')) continue;
    rowCount++;

    const address = parseAddress(cells[addressIdx]);
    const name = (cells[nameIdx] ?? '').trim();
    if (address === null || !name) {
      skippedRows++;
      continue;
    }

    registers.push({
      address,
      name: name.slice(0, 120),
      dataType: normalizeDataType(dataTypeIdx >= 0 ? cells[dataTypeIdx] : undefined),
      unit: unitIdx >= 0 && cells[unitIdx] ? cells[unitIdx].slice(0, 16) : undefined,
      scale: scaleIdx >= 0 ? parseScaleCell(cells[scaleIdx]) : undefined,
      byteOrder: byteOrderIdx >= 0 && cells[byteOrderIdx] ? cells[byteOrderIdx].slice(0, 32) : undefined,
      mapped_field: 'unmapped',
      confidence: 0,
    });
  }

  // Guard against prose that happens to contain a delimiter: require at
  // least 2 valid rows and a majority of data rows parsing cleanly.
  if (registers.length < 2 || registers.length < rowCount * 0.5) return null;

  return {
    registers,
    delimiter,
    headerColumns: headers,
    rowCount,
    skippedRows,
  };
}

// ============================================================================
// Source-text prefilter for very long inputs (datasheet PDFs)
// ============================================================================

export const MAX_SOURCE_CHARS = 24_000;

const REGISTER_LINE_RE = /\b(0x[0-9A-Fa-f]{2,6}|[1-9]\d{2,5})\b/;

/**
 * Keep the parts of a long document that look like register tables: lines
 * containing a plausible register address plus a word, with ±2 lines of
 * context. Falls back to a head-truncate when the document has no obvious
 * register-table region. Always returns <= maxChars characters.
 */
export function prefilterRegisterText(text: string, maxChars: number = MAX_SOURCE_CHARS): string {
  if (text.length <= maxChars) return text;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const isRegisterLine = (l: string) => REGISTER_LINE_RE.test(l) && /[A-Za-z]{2,}/.test(l);

  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isRegisterLine(lines[i])) hits.push(i);
  }

  if (hits.length >= 8) {
    const keep = new Set<number>();
    for (const h of hits) {
      for (let j = Math.max(0, h - 2); j <= Math.min(lines.length - 1, h + 2); j++) {
        keep.add(j);
      }
    }
    const kept: string[] = [];
    let prev = -2;
    for (let i = 0; i < lines.length; i++) {
      if (!keep.has(i)) continue;
      if (i > prev + 1 && kept.length > 0) kept.push('...');
      kept.push(lines[i]);
      prev = i;
    }
    return kept.join('\n').slice(0, maxChars);
  }

  return text.slice(0, maxChars);
}

// ============================================================================
// FieldMapping persistence plan (contract shared by route + tests + wizard)
// ============================================================================

export const AUTO_CONFIRM_THRESHOLD = 0.85;

/** Scoped original_field key — mirrors the Huawei `inverter.<name>` convention. */
export function registerOriginalField(name: string): string {
  return `modbus.${name.trim().replace(/\s+/g, '_')}`;
}

export interface RegisterPersistenceRow {
  /** FieldMapping.original_field — `modbus.<name>` scoped, deduped */
  original_field: string;
  /** FieldMapping.field_path — the register address as a string */
  field_path: string;
  /** FieldMapping.mapped_field — DataFieldType member (or 'unmapped') */
  mapped_field: string;
  unit?: string;
  /** FieldMapping.scaling_factor */
  scaling_factor: number;
  /** FieldMapping.confidence_score */
  confidence_score: number;
  /** Auto-confirm rule: confidence >= 0.85 (same as discover/route.ts) */
  is_confirmed: boolean;
  /** false when mapped_field === 'unmapped' — the route skips these upserts */
  persisted: boolean;
}

/**
 * Build the FieldMapping upsert plan for an extracted register map. One row
 * per register (stable original_field keys, address-suffixed on name
 * collisions); rows with mapped_field 'unmapped' are included but flagged
 * persisted=false so the UI can still address them via PATCH.
 */
export function buildRegisterPersistenceRows(
  registers: ExtractedRegister[]
): RegisterPersistenceRow[] {
  const seen = new Set<string>();
  const rows: RegisterPersistenceRow[] = [];

  for (const reg of registers) {
    let key = registerOriginalField(reg.name);
    if (seen.has(key)) key = `${key}@${reg.address}`;
    if (seen.has(key)) continue; // exact duplicate (same name + address) — skip
    seen.add(key);

    rows.push({
      original_field: key,
      field_path: String(reg.address),
      mapped_field: reg.mapped_field,
      unit: reg.unit,
      scaling_factor: reg.scale ?? 1.0,
      confidence_score: reg.confidence,
      is_confirmed: reg.confidence >= AUTO_CONFIRM_THRESHOLD && reg.mapped_field !== 'unmapped',
      persisted: reg.mapped_field !== 'unmapped',
    });
  }

  return rows;
}
