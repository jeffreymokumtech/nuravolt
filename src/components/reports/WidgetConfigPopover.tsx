'use client';

import { X } from 'lucide-react';
import type { DashboardWidget, DateRangePreset } from '@/types/dashboard';
import { CHART_METRIC_KEYS, CHART_METRICS } from '@/lib/reports/chart-metrics';
import { useScopeOptions } from '@/components/chat/useScopeOptions';

/**
 * Inline config editor for one report widget (the composer drawer's "full
 * editor"): title, plant, device, metric (chart.timeseries only), range.
 * Edits are applied to the parent's widget state immediately (parent
 * autosaves).
 */

const RANGES: Array<{ value: DateRangePreset; label: string }> = [
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_14d', label: 'Last 14 days' },
  { value: 'last_30d', label: 'Last 30 days' },
  { value: 'last_month', label: 'Last month' },
];

export function WidgetConfigPopover({
  widget,
  onChange,
  onClose,
}: {
  widget: DashboardWidget;
  onChange: (patch: Partial<DashboardWidget['config']>) => void;
  onClose: () => void;
}) {
  const { plants } = useScopeOptions(true, null);
  const c = widget.config ?? {};
  const isChart = widget.type === 'chart.timeseries';

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">
          Widget settings · {widget.type}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-400 hover:text-gray-700"
          aria-label="Close widget settings"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="col-span-2 block sm:col-span-3">
          <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Title
          </span>
          <input
            value={c.title ?? ''}
            onChange={(e) => onChange({ title: e.target.value || undefined })}
            placeholder="Widget title"
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Plant
          </span>
          <select
            value={c.plantIds?.[0] ?? ''}
            onChange={(e) =>
              onChange({ plantIds: e.target.value ? [e.target.value] : undefined })
            }
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            <option value="">Dashboard scope</option>
            {plants.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Device
          </span>
          <input
            value={c.deviceIds?.[0] ?? ''}
            onChange={(e) =>
              onChange({ deviceIds: e.target.value ? [e.target.value] : undefined })
            }
            placeholder="e.g. INV-01 (optional)"
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-mono"
          />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Range
          </span>
          <select
            value={c.range ?? ''}
            onChange={(e) =>
              onChange({ range: (e.target.value || undefined) as DateRangePreset | undefined })
            }
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            <option value="">Dashboard scope</option>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        {isChart && (
          <label className="block">
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Metric
            </span>
            <select
              value={String(c.options?.metric ?? 'power_ac')}
              onChange={(e) =>
                onChange({ options: { ...(c.options ?? {}), metric: e.target.value } })
              }
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
            >
              {CHART_METRIC_KEYS.map((m) => (
                <option key={m} value={m}>
                  {CHART_METRICS[m].label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
