/**
 * Upsert-SQL contract tests for src/lib/db/timeseries.ts. No server and no
 * database — the emitted statement is compared against the deployed migration.
 *
 * The bug these guard: `analysis_results` is keyed by an *expression* index
 * (COALESCE over the two nullable columns), and Postgres refuses a plain column
 * list as the ON CONFLICT target (42P10). `measurements` is the opposite case —
 * a plain column list — so its target must stay plain.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// The module instantiates a PrismaClient at import time; stub it so these stay
// pure module checks.
vi.mock('@/libs/prisma', () => ({
  default: { $executeRawUnsafe: vi.fn(), $queryRawUnsafe: vi.fn() },
}));

import { buildAnalysisResultsUpsertSql } from '@/lib/db/timeseries';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'prisma/migrations/20260403060556_timescaledb_hypertables/migration.sql',
  ),
  'utf8',
);
const MODULE_SRC = fs.readFileSync(
  path.join(ROOT, 'src/lib/db/timeseries.ts'),
  'utf8',
);

/** Whitespace-insensitive form so formatting drift does not fail the compare. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function indexExpression(indexName: string, table: string): string {
  const re = new RegExp(
    `CREATE UNIQUE INDEX ${indexName} ON ${table} \\((.+)\\);`,
  );
  const m = MIGRATION.match(re);
  expect(m, `${indexName} not found in the migration`).toBeTruthy();
  return norm(m![1]);
}

function conflictTarget(sql: string): string {
  const m = sql.match(/ON CONFLICT \((.+)\)\s*\n\s*DO UPDATE/);
  expect(m, 'no ON CONFLICT ... DO UPDATE in the emitted SQL').toBeTruthy();
  return norm(m![1]);
}

describe('analysis_results bulk upsert', () => {
  const sql = buildAnalysisResultsUpsertSql(2);

  it('targets the COALESCE expression form, not a plain column list', () => {
    expect(sql).toContain("COALESCE(device_id, '')");
    expect(sql).toContain(
      "COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)",
    );
    expect(conflictTarget(sql)).not.toBe(
      'time, plant_id, device_id, domain, metric',
    );
  });

  it('mirrors idx_ar_unique exactly', () => {
    expect(conflictTarget(sql)).toBe(
      indexExpression('idx_ar_unique', 'analysis_results'),
    );
  });

  it('inserts run_id so the conflict target can resolve', () => {
    const cols = sql.match(/INSERT INTO analysis_results \(([^)]+)\)/)![1];
    expect(cols.split(',').map((c) => c.trim())).toEqual([
      'time',
      'plant_id',
      'device_id',
      'domain',
      'metric',
      'value',
      'confidence',
      'model_version',
      'run_id',
      'metadata',
    ]);
  });

  it('casts plant_id and run_id to uuid (Prisma binds params as text)', () => {
    expect(sql).toContain('$2::uuid');
    expect(sql).toContain('$9::uuid');
    expect(sql).toContain('$10::jsonb');
  });

  it('numbers one placeholder row per record, 10 params each', () => {
    expect(buildAnalysisResultsUpsertSql(1).match(/\$\d+/g)!.length).toBe(10);
    const two = sql.match(/\$\d+/g)!;
    expect(two.length).toBe(20);
    expect(two[19]).toBe('$20');
  });

  it('does not overwrite run_id, which is part of the key', () => {
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(setClause).not.toMatch(/\brun_id\s*=/);
  });
});

describe('measurements bulk upsert (unchanged)', () => {
  it('keeps the plain column list that idx_meas_unique actually is', () => {
    const expr = indexExpression('idx_meas_unique', 'measurements');
    expect(expr).toBe('time, plant_id, device_id, metric');
    expect(MODULE_SRC).toContain(
      'ON CONFLICT (time, plant_id, device_id, metric)',
    );
  });
});
