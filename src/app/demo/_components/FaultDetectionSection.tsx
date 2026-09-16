'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useFaults } from '@/hooks/useFaults';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import { useDataRoot } from '@/contexts/DataSourceContext';
import type { Fault, FaultMode, EnhancedFaultData } from '@/types/faults';
import FaultSummaryCards from './fault/FaultSummaryCards';
import FaultFilters from './fault/FaultFilters';
import FaultTable from './fault/FaultTable';
import FaultDetailPanel from './fault/FaultDetailPanel';
import RULTimelineChart from './fault/RULTimelineChart';
import StringAnomalyTable from './fault/StringAnomalyTable';

// Tab configuration
const TABS: { value: FaultMode | 'all'; label: string }[] = [
  { value: 'all', label: 'All Faults' },
  { value: 'reactive', label: 'Active' },
  { value: 'predictive', label: 'Predicted' },
];

export default function FaultDetectionSection() {
  const params = useParams();
  const plantId = params.plantId as string;
  const dataRoot = useDataRoot();

  const [selectedFault, setSelectedFault] = useState<Fault | null>(null);

  // Plant groups for inverter-group filtering
  const { groups, equipmentToGroup } = usePlantGroups(plantId);

  // Enhanced fault data (RUL predictions)
  const [enhancedFaultData, setEnhancedFaultData] = useState<EnhancedFaultData | null>(null);
  const [enhancedFaultLoading, setEnhancedFaultLoading] = useState(true);

  // Fetch enhanced fault data (RUL predictions)
  useEffect(() => {
    setEnhancedFaultLoading(true);
    fetch(`${dataRoot}/faults/${plantId}/fault_detection_enhanced.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load enhanced fault data');
        return res.json();
      })
      .then((json: EnhancedFaultData) => {
        setEnhancedFaultData(json);
        setEnhancedFaultLoading(false);
      })
      .catch(() => {
        setEnhancedFaultData(null);
        setEnhancedFaultLoading(false);
      });
  }, [plantId]);

  const {
    reactiveFaults,
    predictiveFaults,
    summary,
    loading,
    error,
    filters,
    setFilters,
    filteredReactiveFaults,
    filteredPredictiveFaults,
    filteredAllFaults,
    sortConfig,
    toggleSort,
    refresh,
    createTicketFromFault,
    validateTicket,
    exportCSV,
    faultsByGroup,
  } = useFaults(plantId, {
    currency: 'EUR',
    electricityPrice: 0.12,
    autoRefresh: false,
    equipmentToGroup,
    includeBess: true,
  });

  // Get unique fault types for filter dropdown
  const faultTypes = useMemo(() => {
    const types = new Set<string>();
    reactiveFaults.forEach((f) => types.add(f.fault_type));
    predictiveFaults.forEach((f) => types.add(f.fault_type));
    return Array.from(types).sort();
  }, [reactiveFaults, predictiveFaults]);

  // Get unique equipment IDs for filter dropdown
  const equipmentIds = useMemo(() => {
    const ids = new Set<string>();
    reactiveFaults.forEach((f) => ids.add(f.equipment_id));
    predictiveFaults.forEach((f) => ids.add(f.equipment_id));
    return Array.from(ids).filter((id) => id !== 'plant').sort();
  }, [reactiveFaults, predictiveFaults]);

  // Calculate severity counts for filter badges
  const severityCounts = useMemo(() => {
    const allFaults = [...reactiveFaults, ...predictiveFaults];
    return {
      critical: allFaults.filter((f) => f.severity === 'critical').length,
      warning: allFaults.filter((f) => f.severity === 'warning').length,
      info: allFaults.filter((f) => f.severity === 'info').length,
    };
  }, [reactiveFaults, predictiveFaults]);

  // Get faults based on active tab
  const displayedFaults = useMemo(() => {
    switch (filters.mode) {
      case 'reactive':
        return filteredReactiveFaults;
      case 'predictive':
        return filteredPredictiveFaults;
      default:
        return filteredAllFaults;
    }
  }, [filters.mode, filteredReactiveFaults, filteredPredictiveFaults, filteredAllFaults]);

  // Handle fault click
  const handleFaultClick = (fault: Fault) => {
    setSelectedFault(fault);
  };

  // Handle close detail panel
  const handleCloseDetail = () => {
    setSelectedFault(null);
  };

  // Handle tab change
  const handleTabChange = (mode: FaultMode | 'all') => {
    setFilters({ ...filters, mode });
  };

  // Get tab counts
  const tabCounts = {
    all: (summary?.reactive_count ?? 0) + (summary?.predictive_count ?? 0),
    reactive: summary?.reactive_count ?? 0,
    predictive: summary?.predictive_count ?? 0,
  };

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="bg-paper rounded-xl shadow-sm border border-divider p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <AlertTriangle className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-ink">Fault Detection</h2>
              <p className="text-sm text-ink-2">
                Real-time reactive and predictive fault monitoring
              </p>
            </div>
          </div>

          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm text-ink-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-signal-critical/10 border border-signal-critical/20 rounded-xl p-4"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-signal-critical flex-shrink-0" />
            <div>
              <h3 className="font-medium text-signal-critical">Error loading fault data</h3>
              <p className="text-sm text-signal-critical mt-1">{error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Summary Cards */}
      <FaultSummaryCards summary={summary} loading={loading} />

      {/* RUL Timeline Chart */}
      <RULTimelineChart
        predictions={enhancedFaultData?.rul_predictions}
        loading={enhancedFaultLoading}
        height={350}
        maxDays={90}
      />

      {/* Asset Type Filter */}
      <div className="flex gap-2 mb-0">
        {(['all', 'pv', 'bess'] as const).map((type) => {
          const isActive =
            type === 'all' ? !filters.asset_type : filters.asset_type === type;
          return (
            <button
              key={type}
              onClick={() =>
                setFilters({
                  ...filters,
                  asset_type: type === 'all' ? undefined : type,
                })
              }
              className={`px-4 py-1.5 text-sm font-medium rounded-full border transition-all ${
                isActive
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                  : 'bg-white text-ink-2 border-gray-300 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {type === 'all' ? 'All Assets' : type === 'pv' ? 'PV' : 'BESS'}
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-divider p-1 inline-flex">
        {TABS.map((tab) => {
          const isActive = filters.mode === tab.value;
          const count = tabCounts[tab.value];

          return (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                isActive
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-ink-2 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span
                className={`ml-2 px-1.5 py-0.5 text-xs rounded-full ${
                  isActive ? 'bg-blue-500 text-white' : 'bg-divider text-ink-2'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Group Filter */}
      {groups.length > 0 && (
        <div className="bg-white rounded-xl border border-divider p-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-ink-3 font-medium whitespace-nowrap">Group:</label>
            <select
              value={filters.group_id || ''}
              onChange={(e) =>
                setFilters({ ...filters, group_id: e.target.value || undefined })
              }
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">All Groups</option>
              {groups.map((group) => {
                const count = faultsByGroup[group.id]?.length ?? 0;
                return (
                  <option key={group.id} value={group.id}>
                    {group.name} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {/* Filters */}
      <FaultFilters
        filters={filters}
        onFilterChange={setFilters}
        onExportCSV={exportCSV}
        faultTypes={faultTypes}
        equipmentIds={equipmentIds}
        severityCounts={severityCounts}
      />

      {/* Fault Table */}
      <FaultTable
        faults={displayedFaults}
        loading={loading}
        onFaultClick={handleFaultClick}
        onCreateTicket={createTicketFromFault}
        sortConfig={sortConfig}
        onSort={toggleSort}
      />

      {/* String-Level Anomalies */}
      <StringAnomalyTable plantId={plantId} />

      {/* Detail Panel */}
      <AnimatePresence>
        {selectedFault && (
          <FaultDetailPanel
            fault={selectedFault}
            plantId={plantId}
            onClose={handleCloseDetail}
            onCreateTicket={createTicketFromFault}
            onValidateTicket={validateTicket}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
