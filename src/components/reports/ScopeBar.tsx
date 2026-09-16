'use client';

import type { DashboardScope, DateRangePreset } from '@/types/dashboard';
import { Calendar, Building2 } from 'lucide-react';

interface PlantOption {
  plantId: string;
  plantName: string;
  assetType?: string;
}

interface Props {
  scope: DashboardScope;
  onChange: (next: DashboardScope) => void;
  availablePlants: PlantOption[];
  readOnly?: boolean;
}

const RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_14d', label: 'Last 14 days' },
  { value: 'last_30d', label: 'Last 30 days' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'year_to_date', label: 'Year to date' },
  { value: 'custom', label: 'Custom…' },
];

/**
 * Top scope bar shown above the dashboard canvas. Controls the dashboard-
 * level defaults (widgets can override). Compact, read-only variant used on
 * the public share page.
 */
export default function ScopeBar({ scope, onChange, availablePlants, readOnly }: Props) {
  const togglePlant = (plantId: string) => {
    if (readOnly) return;
    const has = scope.plantIds.includes(plantId);
    onChange({
      ...scope,
      plantIds: has ? scope.plantIds.filter((p) => p !== plantId) : [...scope.plantIds, plantId],
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
      {/* Date range */}
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-gray-500" />
        <select
          value={scope.range}
          disabled={readOnly}
          onChange={(e) =>
            onChange({ ...scope, range: e.target.value as DateRangePreset })
          }
          className="text-sm border border-gray-200 rounded-md px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50"
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {scope.range === 'custom' && (
          <>
            <input
              type="date"
              value={scope.from?.slice(0, 10) ?? ''}
              disabled={readOnly}
              onChange={(e) => onChange({ ...scope, from: e.target.value || null })}
              className="text-sm border border-gray-200 rounded-md px-2 py-1"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={scope.to?.slice(0, 10) ?? ''}
              disabled={readOnly}
              onChange={(e) => onChange({ ...scope, to: e.target.value || null })}
              className="text-sm border border-gray-200 rounded-md px-2 py-1"
            />
          </>
        )}
      </div>

      {/* Plant multi-select (chips) */}
      <div className="flex items-center gap-2 flex-wrap">
        <Building2 className="w-4 h-4 text-gray-500" />
        {availablePlants.length === 0 ? (
          <span className="text-xs text-gray-400">No plants loaded</span>
        ) : (
          availablePlants.map((p) => {
            const selected = scope.plantIds.includes(p.plantId);
            return (
              <button
                key={p.plantId}
                onClick={() => togglePlant(p.plantId)}
                disabled={readOnly}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  selected
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300'
                } disabled:opacity-60`}
              >
                {p.plantName}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
