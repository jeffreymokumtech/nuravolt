import {
  format,
  parseISO,
  startOfWeek,
  startOfMonth,
  startOfDay,
  subDays,
  startOfYear,
} from 'date-fns';

/**
 * Date-bucketing helpers shared by every range-aware chart and KPI strip.
 * All windows anchor to a caller-supplied `dataEnd` rather than wall-clock
 * "now": demo fixtures are pinned in time, so anchoring to today would
 * silently window past the data and render zeros.
 */

export type Bucket = 'day' | 'week' | 'month';

export interface BucketedRow {
  /** Bucket start date, YYYY-MM-DD. */
  date: string;
  /** Display label (e.g. "Jun 12", "W24", "Jun 25"). */
  label: string;
  /** One aggregated value per requested field, keyed by field name. */
  values: Record<string, number | null>;
  /** How many source rows landed in this bucket. */
  count: number;
}

interface BucketOptions {
  bucket: Bucket;
  /** 'sum' for energy-like fields, 'mean' for rates/ratios. Default 'mean'. */
  reduce?: 'sum' | 'mean';
  /** Per-field override of the default reduce. */
  reduceByField?: Record<string, 'sum' | 'mean'>;
}

function bucketStart(d: Date, bucket: Bucket): Date {
  if (bucket === 'week') return startOfWeek(d, { weekStartsOn: 1 });
  if (bucket === 'month') return startOfMonth(d);
  return startOfDay(d);
}

function bucketLabel(d: Date, bucket: Bucket): string {
  if (bucket === 'month') return format(d, 'MMM yy');
  return format(d, 'MMM d');
}

/**
 * Group time-stamped rows into day/week/month buckets and reduce the named
 * numeric fields. Null/NaN values are skipped (a bucket with no finite
 * samples for a field yields null, keeping line-chart gap semantics).
 */
export function bucketSeries<T>(
  rows: T[],
  getDate: (row: T) => string,
  getValues: (row: T) => Record<string, number | null | undefined>,
  opts: BucketOptions
): BucketedRow[] {
  const { bucket, reduce = 'mean', reduceByField = {} } = opts;
  const map = new Map<string, { date: Date; sums: Record<string, number>; counts: Record<string, number>; count: number }>();

  for (const row of rows) {
    const raw = getDate(row);
    if (!raw) continue;
    const d = parseISO(raw);
    if (Number.isNaN(d.getTime())) continue;
    const start = bucketStart(d, bucket);
    const key = format(start, 'yyyy-MM-dd');
    let entry = map.get(key);
    if (!entry) {
      entry = { date: start, sums: {}, counts: {}, count: 0 };
      map.set(key, entry);
    }
    entry.count += 1;
    const values = getValues(row);
    for (const [field, v] of Object.entries(values)) {
      if (v == null || !Number.isFinite(v)) continue;
      entry.sums[field] = (entry.sums[field] ?? 0) + v;
      entry.counts[field] = (entry.counts[field] ?? 0) + 1;
    }
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => {
      const values: Record<string, number | null> = {};
      for (const field of Object.keys(entry.sums)) {
        const mode = reduceByField[field] ?? reduce;
        values[field] =
          mode === 'sum' ? entry.sums[field] : entry.sums[field] / (entry.counts[field] || 1);
      }
      return { date: key, label: bucketLabel(entry.date, bucket), values, count: entry.count };
    });
}

/** Sensible default bucket for a window span, so long ranges stay readable. */
export function autoBucketFor(spanDays: number): Bucket {
  if (spanDays <= 45) return 'day';
  if (spanDays <= 180) return 'week';
  return 'month';
}

export interface PeriodWindow {
  key: 'today' | '7d' | 'mtd' | 'ytd';
  label: string;
  from: string;
  to: string;
}

/**
 * The four KPI windows (today / last 7 days / month-to-date / year-to-date),
 * anchored to the last day with data.
 */
export function periodWindows(dataEnd: Date | string): PeriodWindow[] {
  const end = typeof dataEnd === 'string' ? parseISO(dataEnd) : dataEnd;
  const iso = (d: Date) => format(d, 'yyyy-MM-dd');
  const to = iso(end);
  return [
    { key: 'today', label: 'TODAY', from: to, to },
    { key: '7d', label: '7 DAYS', from: iso(subDays(end, 6)), to },
    { key: 'mtd', label: 'MTD', from: iso(startOfMonth(end)), to },
    { key: 'ytd', label: 'YTD', from: iso(startOfYear(end)), to },
  ];
}
