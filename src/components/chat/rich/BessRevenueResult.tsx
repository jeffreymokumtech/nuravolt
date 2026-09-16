'use client';

import { Crown } from 'lucide-react';
import RevenueStackedBars, { LaneSwatch } from './RevenueStackedBars';
import { RichToolCard, StatCell } from './RichToolCard';
import { LANE_STYLE, currencySymbol } from '@/lib/config/bessServices';
import {
  groupServiceTotalsByLane,
  laneSubtotals,
  lanesPresent,
  type RevenueDay,
} from '@/hooks/useBESSData';

/**
 * Inline render for `tool-getBessRevenue` outputs. Two shapes:
 *   by:'day'     → { series: [{date,<service>...}] } → lane-grouped bars
 *   by:'service' → { services: {k:{total,share_pct}}, ... } → per-lane rows
 *
 * Both views are organised by ledger lane and NEITHER shows a grand total.
 * The tool still emits an all-services `total` and a cross-lane `share_pct`,
 * and this card deliberately ignores both: a declared availability payment and
 * a measured settlement can be paid on the same megawatt hour, so a combined
 * total double counts it and a share of that total is a share of a number that
 * should not exist. Shares are recomputed within a lane, and the top earner
 * badge is scoped to its own lane rather than crowning a contract fee over a
 * settled volume.
 */

interface ByDayOutput {
  plant?: { name?: string; slug?: string };
  currency?: string;
  series?: RevenueDay[];
}

interface ByServiceOutput {
  plant?: { name?: string; slug?: string };
  currency?: string;
  days?: number;
  window?: { from?: string; to?: string };
  total?: number;
  daily_mean?: number;
  services?: Record<string, { total: number; share_pct: number }>;
  top_service?: string;
}

export function BessRevenueResult({ output }: { output: ByDayOutput & ByServiceOutput }) {
  const plantName = output.plant?.name ?? output.plant?.slug ?? 'plant';
  // An absent currency prints bare numbers rather than claiming sterling.
  const sym = currencySymbol(output.currency ?? '');
  const fmt = (v: number) =>
    Math.abs(v) >= 1000 ? `${sym}${(v / 1000).toFixed(1)}k` : `${sym}${Math.round(v)}`;

  const dayLanes = Array.isArray(output.series) ? lanesPresent(output.series) : [];

  if (dayLanes.length > 0) {
    const lanes = dayLanes;
    const subtotals = laneSubtotals(output.series!);
    const dayCount = output.series!.length;

    return (
      <RichToolCard title={`Revenue by day · ${plantName}`} raw={output}>
        <div className="mb-2 grid grid-cols-3 gap-2">
          {lanes.map((lane) => (
            <StatCell
              key={lane}
              label={`${LANE_STYLE[lane].label} lane (${dayCount}d)`}
              value={fmt(subtotals[lane])}
            />
          ))}
        </div>
        <RevenueStackedBars series={output.series!} currency={output.currency} />
      </RichToolCard>
    );
  }

  if (output.services) {
    const groups = groupServiceTotalsByLane(output.services);
    if (!groups.length) return null;

    return (
      <RichToolCard title={`Revenue stack · ${plantName}`} raw={output}>
        <div className="mb-2.5 grid grid-cols-2 gap-2">
          <StatCell label="Days" value={String(output.days ?? '?')} />
          <StatCell
            label="Window"
            value={
              output.window?.from
                ? `${String(output.window.from).slice(5)} to ${String(output.window.to).slice(5)}`
                : 'n/a'
            }
          />
        </div>

        <div className="space-y-3">
          {groups.map((group) => {
            const maxRow = Math.max(...group.rows.map((r) => r.total), 1);
            return (
              <div key={group.lane}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-800">
                    <LaneSwatch lane={group.lane} color="#64748b" />
                    {LANE_STYLE[group.lane].label} lane
                  </span>
                  <span className="font-mono text-[11px] font-semibold text-gray-900">
                    {fmt(group.subtotal)}
                  </span>
                </div>
                <p className="mb-1.5 text-[10px] leading-snug text-gray-500">
                  {LANE_STYLE[group.lane].hint}
                </p>
                <div className="space-y-1.5">
                  {group.rows.map((row, i) => (
                    <div key={row.base} className="flex items-center gap-2">
                      <span
                        className="w-24 shrink-0 truncate text-[11px] text-gray-700"
                        title={row.label}
                      >
                        {row.label}
                      </span>
                      <div className="h-[9px] flex-1 overflow-hidden rounded bg-gray-100">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.max(2, (row.total / maxRow) * 100)}%`,
                            background: row.color,
                          }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-gray-900">
                        {fmt(row.total)}
                      </span>
                      <span className="w-11 shrink-0 text-right font-mono text-[10px] text-gray-500">
                        {row.shareInLanePct.toFixed(1)}%
                      </span>
                      {i === 0 && group.rows.length > 1 ? (
                        <Crown
                          className="h-3 w-3 shrink-0 text-amber-500"
                          aria-label="Top earner in this lane"
                        />
                      ) : (
                        <span className="h-3 w-3 shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-2.5 text-[10px] leading-snug text-gray-500">
          Three lanes of one ledger, never added together. Shares are within a lane, because a
          contracted availability payment and a settled volume can cover the same megawatt hour.
        </p>
      </RichToolCard>
    );
  }

  return null;
}
