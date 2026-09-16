'use client';

import TelemetryStrip, { type TelemetryCell } from '@/components/ops/TelemetryStrip';

/**
 * Period-scoped loss KPIs (today / last 7 days / month-to-date /
 * year-to-date) for the plant overview. Presentational only — the caller
 * integrates the windows (see periodWindows in utils/timeBuckets) over the
 * twin daily series and passes the totals.
 *
 * Fixture plants are pinned in time, so "today" is the plant's last day with
 * data; the anchor date renders in each footer to keep that honest.
 */

export interface PeriodKpi {
  key: string;
  /** e.g. "LOSS TODAY", "LOSS 7D", "LOSS MTD", "LOSS YTD" */
  label: string;
  lossMwh: number | null;
  lossEur: number | null;
  /** e.g. "on 2025-12-13" or "to 2025-12-13" */
  anchorNote?: string;
}

function fmtMwh(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtEur(v: number): string {
  if (Math.abs(v) >= 10000) return `€${(v / 1000).toFixed(1)}k`;
  return `€${Math.round(v).toLocaleString()}`;
}

export default function PeriodKpiStrip({ items }: { items: PeriodKpi[] }) {
  if (!items.length) return null;
  const cells: TelemetryCell[] = items.map((item) => ({
    label: item.label,
    value: item.lossMwh != null ? fmtMwh(item.lossMwh) : '–',
    unit: 'MWh',
    tone: item.lossMwh != null && item.lossMwh > 0 ? 'warn' : 'neutral',
    footer:
      item.lossEur != null
        ? `${fmtEur(item.lossEur)} forgone${item.anchorNote ? ` · ${item.anchorNote}` : ''}`
        : (item.anchorNote ?? ''),
  }));
  return <TelemetryStrip cells={cells} />;
}
