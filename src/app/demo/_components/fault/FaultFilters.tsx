'use client';

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Filter, Download, X, Search, ChevronDown } from 'lucide-react';
import SeverityFilterButtons, { Severity } from '@/components/ui/SeverityFilterButtons';
import type { FaultFilters as FaultFiltersType, FaultSeverity, FaultUrgency, PowerLossRange, FaultTemporalStatus } from '@/types/faults';

interface FaultFiltersProps {
  filters: FaultFiltersType;
  onFilterChange: (filters: FaultFiltersType) => void;
  onExportCSV: () => void;
  faultTypes: string[];
  equipmentIds: string[];
  severityCounts?: { critical: number; warning: number; info: number };
}

const URGENCY_OPTIONS: { value: FaultUrgency; label: string; color: string }[] = [
  { value: 'urgent', label: 'Urgent', color: 'text-signal-critical bg-signal-critical/10 border-signal-critical/20' },
  { value: 'soon', label: 'Soon', color: 'text-orange-600 bg-orange-50 border-orange-200' },
  { value: 'planned', label: 'Planned', color: 'text-blue-600 bg-blue-50 border-blue-200' },
  { value: 'monitoring', label: 'Monitoring', color: 'text-ink-2 bg-paper border-divider' },
];

export default function FaultFilters({
  filters,
  onFilterChange,
  onExportCSV,
  faultTypes,
  equipmentIds,
  severityCounts = { critical: 0, warning: 0, info: 0 },
}: FaultFiltersProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Convert severity filter to array for toggle buttons
  const selectedSeverities = useMemo(() => {
    if (!filters.severity) return [];
    return [filters.severity as Severity];
  }, [filters.severity]);

  const handleSeverityChange = (selected: Severity[]) => {
    if (selected.length === 0 || selected.length === 3) {
      // All or none selected = show all
      onFilterChange({ ...filters, severity: undefined });
    } else if (selected.length === 1) {
      onFilterChange({ ...filters, severity: selected[0] as FaultSeverity });
    } else {
      // Multiple selected - for now just use first one (could extend to multi-select)
      onFilterChange({ ...filters, severity: selected[0] as FaultSeverity });
    }
  };

  const hasActiveFilters = Object.entries(filters).some(([key, v]) => {
    if (key === 'mode') return v !== undefined && v !== 'all';
    if (key === 'powerLossRange') {
      const range = v as PowerLossRange | undefined;
      return range && (range.min !== undefined || range.max !== undefined);
    }
    return v !== undefined;
  });

  const clearFilters = () => {
    onFilterChange({ mode: 'all' });
  };

  const activeFilterCount = [
    filters.severity,
    filters.urgency,
    filters.fault_type,
    filters.equipment_id,
    filters.status,
    filters.powerLossRange?.min,
    filters.powerLossRange?.max,
  ].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Primary Filter Bar */}
      <div className="bg-white rounded-xl border border-divider p-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
            <input
              type="text"
              placeholder="Search faults by type, equipment..."
              value={filters.search || ''}
              onChange={(e) =>
                onFilterChange({ ...filters, search: e.target.value || undefined })
              }
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all ${
                showAdvanced || hasActiveFilters
                  ? 'text-blue-700 bg-blue-50 border border-blue-200'
                  : 'text-ink-2 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
            >
              <Filter className="w-4 h-4" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="px-1.5 py-0.5 text-xs bg-blue-600 text-white rounded-full">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={onExportCSV}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-ink-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export</span>
            </motion.button>
          </div>
        </div>

        {/* Severity Toggle Buttons - Always Visible */}
        <div className="mt-4 pt-4 border-t border-divider">
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-3 font-medium">Severity:</span>
            <SeverityFilterButtons
              selected={selectedSeverities}
              onChange={handleSeverityChange}
              counts={severityCounts}
            />
          </div>
        </div>
      </div>

      {/* Advanced Filters Panel */}
      <AnimatePresence>
        {showAdvanced && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="bg-white rounded-xl border border-divider p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-ink">Advanced Filters</h3>
                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-signal-critical hover:bg-red-50 rounded transition-colors"
                  >
                    <X className="w-3 h-3" />
                    Clear all
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Urgency Filter */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">
                    Urgency
                  </label>
                  <select
                    value={filters.urgency || ''}
                    onChange={(e) =>
                      onFilterChange({
                        ...filters,
                        urgency: (e.target.value as FaultUrgency) || undefined,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All</option>
                    {URGENCY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Fault Type Filter */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">
                    Fault Type
                  </label>
                  <select
                    value={filters.fault_type || ''}
                    onChange={(e) =>
                      onFilterChange({
                        ...filters,
                        fault_type: e.target.value || undefined,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All types</option>
                    {faultTypes.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Equipment Filter */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">
                    Equipment
                  </label>
                  <select
                    value={filters.equipment_id || ''}
                    onChange={(e) =>
                      onFilterChange({
                        ...filters,
                        equipment_id: e.target.value || undefined,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All equipment</option>
                    {equipmentIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Status Filter */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">
                    Status
                  </label>
                  <select
                    value={filters.status || ''}
                    onChange={(e) =>
                      onFilterChange({
                        ...filters,
                        status: (e.target.value as FaultTemporalStatus) || undefined,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All</option>
                    <option value="current">Current</option>
                    <option value="historical">Historical</option>
                  </select>
                </div>

                {/* Power Loss Range */}
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">
                    Energy Loss Range (kWh)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      placeholder="Min"
                      value={filters.powerLossRange?.min ?? ''}
                      onChange={(e) => {
                        const val = e.target.value ? parseFloat(e.target.value) : undefined;
                        onFilterChange({
                          ...filters,
                          powerLossRange: {
                            ...filters.powerLossRange,
                            min: val,
                          },
                        });
                      }}
                      className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <span className="text-ink-3">to</span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={filters.powerLossRange?.max ?? ''}
                      onChange={(e) => {
                        const val = e.target.value ? parseFloat(e.target.value) : undefined;
                        onFilterChange({
                          ...filters,
                          powerLossRange: {
                            ...filters.powerLossRange,
                            max: val,
                          },
                        });
                      }}
                      className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
