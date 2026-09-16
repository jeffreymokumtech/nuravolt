'use client';

import { useCallback, useMemo, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { TIME_RANGE_DAYS, type TimeRange } from '@/components/ops/OpsTimeRange';
import { autoBucketFor, type Bucket } from '@/utils/timeBuckets';

/** Chart granularity: aggregation buckets plus explicit sub-daily. */
export type Granularity = Bucket | 'hour';

/**
 * Shared range state for range-aware chart panels. Turns an OpsTimeRange
 * preset (or a custom / brushed window) into concrete `{ from, to }` ISO
 * dates ready for API query params or client-side slicing, plus the bucket
 * (day/week/month) the window should aggregate at.
 *
 * `dataEnd` anchors presets to the last day with data instead of wall-clock
 * now — demo fixtures are pinned in time, so "last 30 days from today" would
 * window past the data and show nothing.
 */

export interface CustomRange {
  from: string;
  to: string;
}

export interface ChartRangeApi {
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  customRange: CustomRange | null;
  setCustomRange: (r: CustomRange | null) => void;
  /** ISO YYYY-MM-DD window bounds (inclusive). */
  from: string;
  to: string;
  spanDays: number;
  /** Effective granularity: manual override when set, else auto from span. */
  bucket: Granularity;
  setBucket: (b: Granularity | null) => void;
  bucketOverride: Granularity | null;
  isCustom: boolean;
}

export function useChartRange(
  initial: TimeRange,
  opts: { dataEnd?: string | null } = {}
): ChartRangeApi {
  const [range, setRangeState] = useState<TimeRange>(initial);
  const [customRange, setCustomRangeState] = useState<CustomRange | null>(null);
  const [bucketOverride, setBucketOverride] = useState<Granularity | null>(null);

  // Changing the window resets the bucket override: picking "7d" while a
  // month override is active would otherwise render a single lonely bucket.
  const setRange = useCallback((r: TimeRange) => {
    setCustomRangeState(null);
    setBucketOverride(null);
    setRangeState(r);
  }, []);

  const setCustomRange = useCallback((r: CustomRange | null) => {
    setBucketOverride(null);
    setCustomRangeState(r);
  }, []);

  const { from, to, spanDays } = useMemo(() => {
    if (customRange) {
      const fromD = parseISO(customRange.from);
      const toD = parseISO(customRange.to);
      const span = Math.max(
        1,
        Math.round((toD.getTime() - fromD.getTime()) / 86400000) + 1
      );
      return { from: customRange.from, to: customRange.to, spanDays: span };
    }
    const end = opts.dataEnd ? parseISO(opts.dataEnd) : new Date();
    const days = Math.max(1, Math.ceil(TIME_RANGE_DAYS[range]));
    return {
      from: format(subDays(end, days - 1), 'yyyy-MM-dd'),
      to: format(end, 'yyyy-MM-dd'),
      spanDays: days,
    };
  }, [customRange, range, opts.dataEnd]);

  const bucket = bucketOverride ?? autoBucketFor(spanDays);

  return {
    range,
    setRange,
    customRange,
    setCustomRange,
    from,
    to,
    spanDays,
    bucket,
    setBucket: setBucketOverride,
    bucketOverride,
    isCustom: customRange !== null,
  };
}
