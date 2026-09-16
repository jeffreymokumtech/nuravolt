'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/helpers/utils';

/**
 * Segmented time-range selector for ops charts. The active option gets an
 * info-tone background; inactive options are muted mono caps with a hover
 * tint. Sits in the panel header `meta` slot.
 *
 * `onCustomRange` opt-in adds a calendar-icon popover for arbitrary date
 * ranges; when applied, the parent receives `{ from, to }` and can decide
 * what range tag to display (e.g. switch to "custom").
 */

export type TimeRange = '6h' | '24h' | '7d' | '14d' | '30d' | '90d' | '1y' | 'all';

export const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  '6h': 0.25,
  '24h': 1,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
  '1y': 365,
  all: 365 * 5,
};

interface OpsTimeRangeProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  /** Subset of ranges to show; defaults to ['24h','7d','30d','90d','1y','all']. */
  options?: TimeRange[];
  /** Optional handler for the custom-range popover. Adds a Calendar icon. */
  onCustomRange?: (range: { from: string; to: string }) => void;
  className?: string;
}

const RANGE_LABEL: Record<TimeRange, string> = {
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '14d': '14d',
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
  all: 'all',
};

const DEFAULT_OPTIONS: TimeRange[] = ['24h', '7d', '30d', '90d', '1y', 'all'];

/**
 * Sibling segmented control for aggregation granularity (day/week/month).
 * Same visual language as the range picker; sits next to it in a panel
 * `meta` slot. Pass `value=null` to show the auto-derived bucket as active
 * without an explicit override.
 */
export type BucketOption = 'hour' | 'day' | 'week' | 'month';

const BUCKET_LABEL: Record<BucketOption, string> = {
  hour: 'hr',
  day: 'day',
  week: 'wk',
  month: 'mo',
};

export function OpsBucketToggle({
  value,
  effective,
  onChange,
  options = ['day', 'week', 'month'],
  className,
}: {
  /** Explicit user override, or null when auto. */
  value: BucketOption | null;
  /** The bucket actually in effect (auto-derived when value is null). */
  effective: BucketOption;
  /** Called with the clicked bucket, or null when the active override is clicked again (back to auto). */
  onChange: (bucket: BucketOption | null) => void;
  options?: BucketOption[];
  className?: string;
}) {
  const [hoverOpt, setHoverOpt] = useState<BucketOption | null>(null);
  return (
    <div
      className={cn(
        'relative inline-flex rounded-lg border p-[2px] font-mono text-[10px]',
        className
      )}
      style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}
      title="Aggregation granularity"
    >
      {options.map((opt) => {
        const isActive = opt === effective;
        const isHover = opt === hoverOpt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(value === opt ? null : opt)}
            aria-pressed={isActive}
            onMouseEnter={() => setHoverOpt(opt)}
            onMouseLeave={() => setHoverOpt(null)}
            className="rounded px-2 py-[2px] transition-all"
            style={{
              background: isActive
                ? 'var(--ops-nav-active-bg)'
                : isHover
                  ? 'var(--ops-row-hair)'
                  : 'transparent',
              color: isActive
                ? 'var(--ops-info)'
                : isHover
                  ? 'var(--ops-bright)'
                  : 'var(--ops-muted)',
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {BUCKET_LABEL[opt]}
          </button>
        );
      })}
    </div>
  );
}

export default function OpsTimeRange({
  value,
  onChange,
  options = DEFAULT_OPTIONS,
  onCustomRange,
  className,
}: OpsTimeRangeProps) {
  const [hoverOpt, setHoverOpt] = useState<TimeRange | 'custom' | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen]);

  return (
    <div
      className={cn(
        'relative inline-flex rounded-lg border p-[2px] font-mono text-[10px]',
        className
      )}
      style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}
    >
      {options.map((opt) => {
        const isActive = opt === value;
        const isHover = opt === hoverOpt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={isActive}
            onMouseEnter={() => setHoverOpt(opt)}
            onMouseLeave={() => setHoverOpt(null)}
            className="rounded px-2 py-[2px] transition-all"
            style={{
              background: isActive
                ? 'var(--ops-nav-active-bg)'
                : isHover
                  ? 'var(--ops-row-hair)'
                  : 'transparent',
              color: isActive
                ? 'var(--ops-info)'
                : isHover
                  ? 'var(--ops-bright)'
                  : 'var(--ops-muted)',
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {RANGE_LABEL[opt]}
          </button>
        );
      })}
      {onCustomRange && (
        <>
          <button
            type="button"
            onClick={() => setPopoverOpen(!popoverOpen)}
            onMouseEnter={() => setHoverOpt('custom')}
            onMouseLeave={() => setHoverOpt(null)}
            title="Custom range"
            className="inline-flex items-center justify-center rounded-sm px-1.5 py-[2px] transition-all"
            style={{
              background:
                hoverOpt === 'custom' || popoverOpen ? 'var(--ops-row-hair)' : 'transparent',
              color:
                popoverOpen
                  ? 'var(--ops-info)'
                  : hoverOpt === 'custom'
                    ? 'var(--ops-bright)'
                    : 'var(--ops-muted)',
            }}
          >
            <Calendar size={11} />
          </button>
          {popoverOpen && (
            <div
              ref={popoverRef}
              className="absolute top-full right-0 z-30 mt-1 flex flex-col gap-2 rounded-md border p-2.5 font-mono text-[10.5px]"
              style={{
                background: 'var(--ops-panel)',
                borderColor: 'var(--ops-hair)',
                minWidth: 220,
                boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              }}
            >
              <div className="flex items-center justify-between">
                <span style={{ color: 'var(--ops-muted)' }}>From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="rounded-sm border px-1.5 py-[2px] font-mono text-[10px]"
                  style={{
                    background: 'var(--ops-panel-2)',
                    borderColor: 'var(--ops-hair)',
                    color: 'var(--ops-txt)',
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: 'var(--ops-muted)' }}>To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="rounded-sm border px-1.5 py-[2px] font-mono text-[10px]"
                  style={{
                    background: 'var(--ops-panel-2)',
                    borderColor: 'var(--ops-hair)',
                    color: 'var(--ops-txt)',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  onCustomRange({ from, to });
                  setPopoverOpen(false);
                }}
                className="mt-1 rounded border px-2 py-1 font-mono text-[10px] transition-colors hover:brightness-95"
                style={{
                  color: 'var(--ops-info)',
                  background: 'var(--ops-info-bg)',
                  borderColor: 'var(--ops-info-border)',
                }}
              >
                Apply range
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
