import prisma from '@/libs/prisma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeasurementQuery {
  plantId: string;
  metrics?: string[];
  deviceIds?: string[];
  from?: Date;
  to?: Date;
  resolution?: 'raw' | 'daily';
  limit?: number;
}

export interface AnalysisQuery {
  plantId: string;
  domain: string;
  metrics?: string[];
  deviceId?: string;
  from?: Date;
  to?: Date;
  resolution?: 'raw' | 'daily';
  limit?: number;
}

export interface MeasurementRow {
  time: Date;
  plant_id: string;
  device_id: string;
  metric: string;
  value: number;
  unit: string | null;
  quality: number;
}

export interface AnalysisRow {
  time: Date;
  plant_id: string;
  device_id: string | null;
  domain: string;
  metric: string;
  value: number;
  confidence: number | null;
  model_version: string | null;
  metadata: any;
}

export interface DailyMeasurementRow {
  bucket: Date;
  plant_id: string;
  device_id: string;
  metric: string;
  avg_value: number;
  min_value: number;
  max_value: number;
  sample_count: number;
}

export interface DailyAnalysisRow {
  bucket: Date;
  plant_id: string;
  device_id: string;
  domain: string;
  metric: string;
  avg_value: number;
  min_value: number;
  max_value: number;
  avg_confidence: number;
  sample_count: number;
}

// ---------------------------------------------------------------------------
// Plant lookup helper
// ---------------------------------------------------------------------------

/**
 * Resolve a plant slug or UUID to the canonical plant UUID.
 * Returns null when no matching plant is found.
 */
export async function resolvePlantId(slugOrId: string): Promise<string | null> {
  const plant = await prisma.plant.findFirst({
    where: {
      OR: [
        { id: slugOrId },
        { slug: slugOrId },
      ],
    },
    select: { id: true },
  });
  return plant?.id ?? null;
}

// ---------------------------------------------------------------------------
// Internal helpers for dynamic WHERE clause building
// ---------------------------------------------------------------------------

interface WhereFragment {
  clauses: string[];
  params: unknown[];
}

function buildMeasurementWhere(
  query: MeasurementQuery,
  startIndex: number,
): WhereFragment {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  // plant_id is always required
  clauses.push(`plant_id = $${idx}::uuid`);
  params.push(query.plantId);
  idx++;

  if (query.metrics && query.metrics.length > 0) {
    clauses.push(`metric = ANY($${idx})`);
    params.push(query.metrics);
    idx++;
  }

  if (query.deviceIds && query.deviceIds.length > 0) {
    clauses.push(`device_id = ANY($${idx})`);
    params.push(query.deviceIds);
    idx++;
  }

  if (query.from) {
    const timeCol = query.resolution === 'daily' ? 'bucket' : 'time';
    clauses.push(`${timeCol} >= $${idx}`);
    params.push(query.from);
    idx++;
  }

  if (query.to) {
    const timeCol = query.resolution === 'daily' ? 'bucket' : 'time';
    clauses.push(`${timeCol} <= $${idx}`);
    params.push(query.to);
    idx++;
  }

  return { clauses, params };
}

function buildAnalysisWhere(
  query: AnalysisQuery,
  startIndex: number,
): WhereFragment {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  clauses.push(`plant_id = $${idx}::uuid`);
  params.push(query.plantId);
  idx++;

  clauses.push(`domain = $${idx}`);
  params.push(query.domain);
  idx++;

  if (query.metrics && query.metrics.length > 0) {
    clauses.push(`metric = ANY($${idx})`);
    params.push(query.metrics);
    idx++;
  }

  if (query.deviceId) {
    clauses.push(`device_id = $${idx}`);
    params.push(query.deviceId);
    idx++;
  }

  if (query.from) {
    const timeCol = query.resolution === 'daily' ? 'bucket' : 'time';
    clauses.push(`${timeCol} >= $${idx}`);
    params.push(query.from);
    idx++;
  }

  if (query.to) {
    const timeCol = query.resolution === 'daily' ? 'bucket' : 'time';
    clauses.push(`${timeCol} <= $${idx}`);
    params.push(query.to);
    idx++;
  }

  return { clauses, params };
}

// ---------------------------------------------------------------------------
// Query: measurements
// ---------------------------------------------------------------------------

/**
 * Query the `measurements` hypertable (or `measurements_daily` continuous
 * aggregate when resolution is 'daily').
 *
 * All filters are parameterized to prevent SQL injection.
 */
export async function queryMeasurements(
  query: MeasurementQuery,
): Promise<MeasurementRow[] | DailyMeasurementRow[]> {
  const useDaily = query.resolution === 'daily';
  const table = useDaily ? 'measurements_daily' : 'measurements';
  const orderCol = useDaily ? 'bucket' : 'time';
  const limit = Math.min(query.limit ?? 10_000, 100_000);

  const { clauses, params } = buildMeasurementWhere(query, 1);

  const whereSQL = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitIdx = params.length + 1;
  params.push(limit);

  const sql = `SELECT * FROM ${table} ${whereSQL} ORDER BY ${orderCol} DESC LIMIT $${limitIdx}`;

  const rows = await prisma.$queryRawUnsafe<any[]>(sql, ...params);
  return rows;
}

// ---------------------------------------------------------------------------
// Query: analysis_results
// ---------------------------------------------------------------------------

/**
 * Query the `analysis_results` hypertable (or `analysis_daily` continuous
 * aggregate when resolution is 'daily').
 */
export async function queryAnalysisResults(
  query: AnalysisQuery,
): Promise<AnalysisRow[] | DailyAnalysisRow[]> {
  const useDaily = query.resolution === 'daily';
  const table = useDaily ? 'analysis_daily' : 'analysis_results';
  const orderCol = useDaily ? 'bucket' : 'time';
  const limit = Math.min(query.limit ?? 10_000, 100_000);

  const { clauses, params } = buildAnalysisWhere(query, 1);

  const whereSQL = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitIdx = params.length + 1;
  params.push(limit);

  const sql = `SELECT * FROM ${table} ${whereSQL} ORDER BY ${orderCol} DESC LIMIT $${limitIdx}`;

  const rows = await prisma.$queryRawUnsafe<any[]>(sql, ...params);
  return rows;
}

// ---------------------------------------------------------------------------
// Soiling forecast snapshot (analysis_results is the canonical store — the
// Prisma SoilingForecast/SoilingEvent tables have no writer and stay empty)
// ---------------------------------------------------------------------------

export interface SoilingForecastPoint {
  plant_id: string;
  /** ISO date (YYYY-MM-DD) */
  date: string;
  soiling_ratio: number | null;
  soiling_loss_pct: number | null;
  is_cleaning_needed: boolean;
}

/** Same threshold the soiling forecast route uses for cleaningRecommended. */
const CLEANING_NEEDED_SR = 0.92;

/**
 * Upcoming soiling forecast points for one plant (ascending by date), pivoted
 * from the long-format `analysis_results` rows. Returns [] when the plant has
 * no soiling rows — callers should treat that as "no forecast yet", not zero.
 */
export async function querySoilingForecastPoints(
  plantUuid: string,
  days = 14,
): Promise<SoilingForecastPoint[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rows = (await queryAnalysisResults({
    plantId: plantUuid,
    domain: 'soiling',
    metrics: ['soiling_ratio', 'soiling_loss_pct'],
    from: todayStart,
    to: new Date(todayStart.getTime() + days * 86_400_000),
    limit: days * 2,
  })) as AnalysisRow[];

  const byDate = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const dateKey = new Date(row.time).toISOString().split('T')[0];
    if (!byDate.has(dateKey)) byDate.set(dateKey, {});
    byDate.get(dateKey)![row.metric] = row.value;
  }
  return Array.from(byDate.keys())
    .sort()
    .slice(0, days)
    .map((date) => {
      const m = byDate.get(date)!;
      const sr = m['soiling_ratio'] ?? null;
      return {
        plant_id: plantUuid,
        date,
        soiling_ratio: sr,
        soiling_loss_pct: m['soiling_loss_pct'] ?? (sr != null ? (1 - sr) * 100 : null),
        is_cleaning_needed: sr != null && sr < CLEANING_NEEDED_SR,
      };
    });
}

// ---------------------------------------------------------------------------
// Insert: measurements (bulk upsert)
// ---------------------------------------------------------------------------

export interface MeasurementInsert {
  time: Date;
  plant_id: string;
  device_id: string;
  metric: string;
  value: number;
  unit?: string;
  quality?: number;
  source_id?: string;
}

/**
 * Bulk-upsert measurement rows into the `measurements` hypertable.
 *
 * Uses a single multi-row INSERT with ON CONFLICT to update existing rows.
 * Returns the number of rows affected.
 */
export async function insertMeasurements(
  records: MeasurementInsert[],
): Promise<number> {
  if (records.length === 0) return 0;

  // Build multi-row VALUES clause with numbered parameters.
  // Each row has 8 columns: time, plant_id, device_id, metric, value, unit, quality, source_id
  const COLS_PER_ROW = 8;
  const valuePlaceholders: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < records.length; i++) {
    const base = i * COLS_PER_ROW + 1;
    valuePlaceholders.push(
      // plant_id is a real uuid column; Prisma binds params as text, so cast it
      // (and source_id) explicitly or Postgres rejects the row (42804).
      `($${base}, $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::uuid)`,
    );
    const r = records[i];
    params.push(
      r.time,
      r.plant_id,
      r.device_id,
      r.metric,
      r.value,
      r.unit ?? null,
      r.quality ?? 100,
      r.source_id ?? null,
    );
  }

  const sql = `
    INSERT INTO measurements (time, plant_id, device_id, metric, value, unit, quality, source_id)
    VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (time, plant_id, device_id, metric)
    DO UPDATE SET
      value   = EXCLUDED.value,
      quality = EXCLUDED.quality,
      unit    = COALESCE(EXCLUDED.unit, measurements.unit),
      source_id = COALESCE(EXCLUDED.source_id, measurements.source_id)
  `;

  // $queryRawUnsafe returns the number of affected rows for INSERT statements
  // Prisma wraps the result; we use $executeRawUnsafe which returns the count directly.
  const count = await prisma.$executeRawUnsafe(sql, ...params);
  return count;
}

// ---------------------------------------------------------------------------
// Insert: analysis_results (bulk upsert)
// ---------------------------------------------------------------------------

export interface AnalysisInsert {
  time: Date;
  plant_id: string;
  device_id?: string;
  domain: string;
  metric: string;
  value: number;
  confidence?: number;
  model_version?: string;
  run_id?: string;
  metadata?: any;
}

// Each row has 10 columns
const ANALYSIS_COLS_PER_ROW = 10;

/**
 * Build the bulk-upsert statement for `rowCount` analysis_results rows.
 *
 * The ON CONFLICT target has to mirror `idx_ar_unique` expression for
 * expression (see prisma/migrations/20260403060556_timescaledb_hypertables):
 * it is an *expression* index over COALESCE(device_id, '') and
 * COALESCE(run_id, <zero uuid>), and Postgres will not match a plain column
 * list against it (42P10, "no unique or exclusion constraint matching the ON
 * CONFLICT specification"). Kept in sync with the Python writer's
 * _ANALYSIS_INSERT in nuravolt/db/writer.py.
 *
 * Exported so the SQL can be asserted on without a live database.
 */
export function buildAnalysisResultsUpsertSql(rowCount: number): string {
  const valuePlaceholders: string[] = [];

  for (let i = 0; i < rowCount; i++) {
    const base = i * ANALYSIS_COLS_PER_ROW + 1;
    valuePlaceholders.push(
      // plant_id is a real uuid column; Prisma binds params as text, so cast it
      // (and run_id / metadata) explicitly or Postgres rejects the row (42804).
      `($${base}, $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::uuid, $${base + 9}::jsonb)`,
    );
  }

  // run_id is part of the conflict key, so it is deliberately absent from the
  // SET list: any row we conflict with already carries the same run_id.
  return `
    INSERT INTO analysis_results (time, plant_id, device_id, domain, metric, value, confidence, model_version, run_id, metadata)
    VALUES ${valuePlaceholders.join(', ')}
    ON CONFLICT (time, plant_id, COALESCE(device_id, ''), domain, metric, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET
      value         = EXCLUDED.value,
      confidence    = COALESCE(EXCLUDED.confidence, analysis_results.confidence),
      model_version = COALESCE(EXCLUDED.model_version, analysis_results.model_version),
      metadata      = COALESCE(EXCLUDED.metadata, analysis_results.metadata)
  `;
}

/**
 * Bulk-upsert analysis result rows into the `analysis_results` hypertable.
 *
 * Upserts on the `idx_ar_unique` key (time, plant_id, device_id, domain,
 * metric, run_id — with the nullable columns coalesced, see
 * buildAnalysisResultsUpsertSql). Returns the number of rows affected.
 */
export async function insertAnalysisResults(
  records: AnalysisInsert[],
): Promise<number> {
  if (records.length === 0) return 0;

  const params: unknown[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    params.push(
      r.time,
      r.plant_id,
      r.device_id ?? null,
      r.domain,
      r.metric,
      r.value,
      r.confidence ?? null,
      r.model_version ?? null,
      r.run_id ?? null,
      r.metadata ? JSON.stringify(r.metadata) : null,
    );
  }

  const sql = buildAnalysisResultsUpsertSql(records.length);

  const count = await prisma.$executeRawUnsafe(sql, ...params);
  return count;
}
