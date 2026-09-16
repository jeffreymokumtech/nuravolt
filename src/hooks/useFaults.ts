'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  ReactiveFault,
  PredictiveFault,
  FaultSummary,
  FaultFilters,
  FaultDetectionResponse,
  Fault,
  FaultSortConfig,
  FaultSortField,
} from '@/types/faults';
import { isReactiveFault, isPredictiveFault } from '@/types/faults';
import type { TicketValidationAction } from '@/types/tickets';
import { getElectricityPrice } from '@/config/electricity';
import { useDataRoot, useDataSource } from '@/contexts/DataSourceContext';

// Digital twin alignment constants
const DIGITAL_TWIN_WINDOW_DAYS = 30;
const DIGITAL_TWIN_MIN_LOSS_PCT = 25; // Only surface significant gaps (>25% loss vs twin)
const DIGITAL_TWIN_MIN_RESIDUAL_KWH = 500; // Avoid small residuals creating noise
const DIGITAL_TWIN_MAX_FAULTS = 3; // Cap synthetic faults to avoid alarm fatigue

interface UseFaultsOptions {
  currency?: string;
  electricityPrice?: number;
  autoRefresh?: boolean;
  refreshInterval?: number; // ms
  equipmentToGroup?: Map<string, { groupId: string; groupName: string; groupSlug: string }>;
  includeBess?: boolean;
}

interface UseFaultsReturn {
  // Data
  reactiveFaults: ReactiveFault[];
  predictiveFaults: PredictiveFault[];
  allFaults: Fault[];
  summary: FaultSummary | null;

  // State
  loading: boolean;
  error: string | null;

  // Filters
  filters: FaultFilters;
  setFilters: (filters: FaultFilters) => void;
  filteredReactiveFaults: ReactiveFault[];
  filteredPredictiveFaults: PredictiveFault[];
  filteredAllFaults: Fault[];

  // Sorting
  sortConfig: FaultSortConfig | null;
  setSortConfig: (config: FaultSortConfig | null) => void;
  toggleSort: (field: FaultSortField) => void;

  // Group aggregation
  faultsByGroup: Record<string, Fault[]>;

  // Actions
  refresh: () => Promise<void>;
  createTicketFromFault: (fault: Fault) => Promise<{ id: string } | { error: string }>;
  validateTicket: (ticketId: string, action: TicketValidationAction, notes?: string) => Promise<boolean>;
  exportCSV: () => void;
}

/**
 * Hook for fetching and managing fault detection data.
 */
export function useFaults(
  plantId: string,
  options: UseFaultsOptions = {}
): UseFaultsReturn {
  const {
    currency = 'EUR',
    electricityPrice = getElectricityPrice(plantId), // Use config-based price by default
    autoRefresh = false,
    refreshInterval = 60000, // 1 minute
    equipmentToGroup,
    includeBess = false,
  } = options;

  const dataRoot = useDataRoot();
  const { readOnly } = useDataSource();

  // Data state
  const [reactiveFaults, setReactiveFaults] = useState<ReactiveFault[]>([]);
  const [predictiveFaults, setPredictiveFaults] = useState<PredictiveFault[]>([]);
  const [summary, setSummary] = useState<FaultSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [digitalTwinLosses, setDigitalTwinLosses] = useState<Record<string, number>>({});
  const [digitalTwinMaxLoss, setDigitalTwinMaxLoss] = useState(0);
  const [inverterRatedPowerKw, setInverterRatedPowerKw] = useState<number>(60);

  // Filter state
  const [filters, setFilters] = useState<FaultFilters>({
    mode: 'all',
  });

  // Sort state
  const [sortConfig, setSortConfig] = useState<FaultSortConfig | null>(null);

  // Toggle sort on a field (cycle: asc -> desc -> null)
  const toggleSort = useCallback((field: FaultSortField) => {
    setSortConfig((prev) => {
      if (!prev || prev.field !== field) {
        return { field, direction: 'desc' }; // Default to descending (highest first)
      }
      if (prev.direction === 'desc') {
        return { field, direction: 'asc' };
      }
      return null; // Clear sort
    });
  }, []);

  // Helper: Get energy loss from any fault type
  const getEnergyLoss = useCallback((fault: Fault): number => {
    if (isReactiveFault(fault)) {
      return fault.energy_loss_kwh;
    }
    return (fault as PredictiveFault).projected_energy_loss_kwh;
  }, []);

  // Helper: Get power loss from any fault type
  const getPowerLoss = useCallback((fault: Fault): number => {
    if (isReactiveFault(fault)) {
      return fault.power_loss_kw;
    }
    return (fault as PredictiveFault).projected_power_loss_kw;
  }, []);

  // Fetch faults from API
  const fetchFaults = useCallback(async () => {
    if (!plantId) return;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        plantId,
        currency,
        electricityPrice: electricityPrice.toString(),
      });

      const response = await fetch(`/api/faults?${params}`);
      const data: FaultDetectionResponse = await response.json();

      if (data.error) {
        setError(data.error);
        return;
      }

      let mergedReactive = data.reactive_faults || [];
      let mergedPredictive = data.predictive_faults || [];
      let mergedSummary = data.summary || null;

      // Fetch BESS faults and merge when enabled
      if (includeBess) {
        try {
          const bessRes = await fetch(`/api/bess/faults?plantId=${plantId}`);
          const bessData = await bessRes.json();

          if (bessData.reactive_faults) {
            mergedReactive = [...mergedReactive, ...bessData.reactive_faults];
          }
          if (bessData.predictive_faults) {
            mergedPredictive = [...mergedPredictive, ...bessData.predictive_faults];
          }
          if (mergedSummary && bessData.summary) {
            mergedSummary = {
              ...mergedSummary,
              reactive_count: mergedSummary.reactive_count + (bessData.summary.reactive_count || 0),
              predictive_count: mergedSummary.predictive_count + (bessData.summary.predictive_count || 0),
              critical_count: mergedSummary.critical_count + (bessData.summary.critical_count || 0),
              current_loss_kwh: mergedSummary.current_loss_kwh + (bessData.summary.current_loss_kwh || 0),
              current_loss_value: mergedSummary.current_loss_value + (bessData.summary.current_loss_value || 0),
              projected_loss_kwh: mergedSummary.projected_loss_kwh + (bessData.summary.projected_loss_kwh || 0),
            };
          }
        } catch (bessErr) {
          console.warn('Failed to fetch BESS faults:', bessErr);
        }
      }

      setReactiveFaults(mergedReactive);
      setPredictiveFaults(mergedPredictive);
      setSummary(mergedSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch faults');
    } finally {
      setLoading(false);
    }
  }, [plantId, currency, electricityPrice, includeBess]);

  // Initial fetch
  useEffect(() => {
    fetchFaults();
  }, [fetchFaults]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(fetchFaults, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchFaults]);

  // Load recent digital twin power loss trends to prioritize high-impact inverters
  useEffect(() => {
    if (!plantId) return;

    const loadDigitalTwinContext = async () => {
      try {
        const [timelineRes, plantRes] = await Promise.allSettled([
          fetch(`${dataRoot}/digitaltwin/${plantId}/timeline_heatmap_data.json`),
          readOnly ? Promise.resolve(null) : fetch(`/api/plants/${plantId}`),
        ]);

        // Derive recent loss per inverter from digital twin heatmap (last 30 days)
        if (timelineRes.status === 'fulfilled' && timelineRes.value.ok) {
          const timeline = await timelineRes.value.json();
          const daily = timeline?.daily;
          if (daily?.data?.length && daily?.inverters?.length) {
            const recentRows = daily.data.slice(Math.max(0, daily.data.length - DIGITAL_TWIN_WINDOW_DAYS));
            const aggregates: Record<string, { sum: number; count: number; max: number }> = {};

            recentRows.forEach((row: (number | null)[]) => {
              row.forEach((value, idx) => {
                if (value === null || value <= 0) return; // Ignore gains/clean performance
                const inverterId = daily.inverters[idx];
                if (!aggregates[inverterId]) {
                  aggregates[inverterId] = { sum: 0, count: 0, max: 0 };
                }
                aggregates[inverterId].sum += value;
                aggregates[inverterId].count += 1;
                aggregates[inverterId].max = Math.max(aggregates[inverterId].max, value);
              });
            });

            const dtLosses: Record<string, number> = {};
            let maxLoss = 0;
            Object.entries(aggregates).forEach(([inverterId, stats]) => {
              const avgLoss = stats.sum / Math.max(1, stats.count);
              if (avgLoss >= DIGITAL_TWIN_MIN_LOSS_PCT) {
                dtLosses[inverterId] = avgLoss;
                maxLoss = Math.max(maxLoss, avgLoss);
              }
            });

            setDigitalTwinLosses(dtLosses);
            setDigitalTwinMaxLoss(maxLoss);
          }
        }

        // Use plant API to estimate per-inverter power for loss translation
        if (plantRes.status === 'fulfilled' && plantRes.value && plantRes.value.ok) {
          const plant = await plantRes.value.json();
          const data = plant?.data;
          if (data?.capacity_mw && data?.inverter_count) {
            setInverterRatedPowerKw((data.capacity_mw * 1000) / data.inverter_count);
          }
        }
      } catch (err) {
        console.warn('Failed to align digital twin losses with faults', err);
      }
    };

    loadDigitalTwinContext();
  }, [plantId]);

  // Create synthetic "unclassified performance loss" faults for residual loss that reactive alarms don't explain
  const digitalTwinFaults = useMemo((): ReactiveFault[] => {
    if (!Object.keys(digitalTwinLosses).length) return [];

    // Pre-compute reactive loss per inverter to subtract from digital twin loss
    const reactiveLossByInverter: Record<string, number> = {};
    reactiveFaults.forEach((f) => {
      reactiveLossByInverter[f.equipment_id] = (reactiveLossByInverter[f.equipment_id] || 0) + f.energy_loss_kwh;
    });

    return Object.entries(digitalTwinLosses)
      .map(([equipmentId, avgLossPct]) => {
        const dtPowerLossKw = (avgLossPct / 100) * inverterRatedPowerKw;
        const dtEnergyLossKwh = dtPowerLossKw * 24 * DIGITAL_TWIN_WINDOW_DAYS;
        const explainedKwh = reactiveLossByInverter[equipmentId] || 0;
        const residualKwh = Math.max(0, dtEnergyLossKwh - explainedKwh);
        if (residualKwh < DIGITAL_TWIN_MIN_RESIDUAL_KWH) {
          return null;
        }

        const residualPct = (residualKwh / (inverterRatedPowerKw * 24 * DIGITAL_TWIN_WINDOW_DAYS)) * 100;
        const severity: ReactiveFault['severity'] =
          residualPct >= 20 ? 'critical' : residualPct >= 10 ? 'warning' : 'info';
        const residualPowerKw = residualKwh / (24 * DIGITAL_TWIN_WINDOW_DAYS);

        return {
          id: `dt-unclassified-${equipmentId.replace(/\s+/g, '-').toLowerCase()}`,
          fault_type: 'unclassified_performance_loss',
          severity,
          equipment_id: equipmentId,
          equipment_name: equipmentId,
          timestamp_start: new Date(Date.now() - DIGITAL_TWIN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
          timestamp_end: null,
          value: residualPct / 100,
          threshold: null,
          message: `Unclassified performance loss: ${residualPct.toFixed(1)}% residual vs digital twin after accounting for active alarms.`,
          duration_minutes: DIGITAL_TWIN_WINDOW_DAYS * 24 * 60,
          power_loss_kw: residualPowerKw,
          energy_loss_kwh: residualKwh,
          loss_computation: {
            method: 'digital_twin',
            power_formula: 'residual_kWh / (24 * window_days)',
            energy_formula: 'digital_twin_loss_kWh - reactive_loss_kWh',
            factors: {
              inverter_rated_kw: inverterRatedPowerKw,
              window_days: DIGITAL_TWIN_WINDOW_DAYS,
              avg_loss_pct: avgLossPct,
              reactive_loss_kwh: explainedKwh,
              rationale: 'Residual digital twin loss not explained by reactive alarms (last 30 days)',
            },
          },
        };
      })
      .filter((f): f is ReactiveFault => Boolean(f))
      .sort((a, b) => b.energy_loss_kwh - a.energy_loss_kwh)
      .slice(0, DIGITAL_TWIN_MAX_FAULTS);
  }, [digitalTwinLosses, reactiveFaults, inverterRatedPowerKw]);

  // Combine real reactive faults with digital twin gaps for display/ordering
  const enhancedReactiveFaults = useMemo(() => {
    return [...reactiveFaults, ...digitalTwinFaults];
  }, [reactiveFaults, digitalTwinFaults]);

  // Combined faults list
  const allFaults = useMemo((): Fault[] => {
    return [...enhancedReactiveFaults, ...predictiveFaults];
  }, [enhancedReactiveFaults, predictiveFaults]);

  // Adjust summary to reflect digital twin surfaced gaps
  const displaySummary = useMemo(() => {
    if (!summary) return summary;
    const dtLossKwh = digitalTwinFaults.reduce((sum, f) => sum + f.energy_loss_kwh, 0);
    const dtCritical = digitalTwinFaults.filter((f) => f.severity === 'critical').length;

    return {
      ...summary,
      current_loss_kwh: summary.current_loss_kwh + dtLossKwh,
      current_loss_value: summary.current_loss_value + dtLossKwh * electricityPrice,
      reactive_count: summary.reactive_count + digitalTwinFaults.length,
      critical_count: summary.critical_count + dtCritical,
    };
  }, [summary, digitalTwinFaults, electricityPrice]);

  // Apply filters to reactive faults
  const filteredReactiveFaults = useMemo(() => {
    return enhancedReactiveFaults.filter((fault) => {
      const isCurrent = !fault.timestamp_end || new Date(fault.timestamp_end).getTime() >= Date.now();

      // Asset type filter
      if (filters.asset_type && fault.asset_type && fault.asset_type !== filters.asset_type) {
        return false;
      }
      // If asset_type filter is set but fault has no asset_type, treat as 'pv'
      if (filters.asset_type && !fault.asset_type && filters.asset_type !== 'pv') {
        return false;
      }

      // Severity filter
      if (filters.severity && fault.severity !== filters.severity) {
        return false;
      }

      // Fault type filter
      if (filters.fault_type && fault.fault_type !== filters.fault_type) {
        return false;
      }

      // Equipment filter
      if (filters.equipment_id && fault.equipment_id !== filters.equipment_id) {
        return false;
      }

      // Group filter
      if (filters.group_id && equipmentToGroup) {
        const group = equipmentToGroup.get(fault.equipment_id);
        if (!group || group.groupId !== filters.group_id) {
          return false;
        }
      }

      // Search filter
      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesType = fault.fault_type.toLowerCase().includes(searchLower);
        const matchesEquipment = fault.equipment_name.toLowerCase().includes(searchLower);
        const matchesMessage = fault.message.toLowerCase().includes(searchLower);
        if (!matchesType && !matchesEquipment && !matchesMessage) {
          return false;
        }
      }

      // Temporal status filter
      if (filters.status === 'current' && !isCurrent) return false;
      if (filters.status === 'historical' && isCurrent) return false;

      return true;
    });
  }, [enhancedReactiveFaults, filters, equipmentToGroup]);

  // Apply filters to predictive faults
  const filteredPredictiveFaults = useMemo(() => {
    return predictiveFaults.filter((fault) => {
      // Predictive faults are treated as current/upcoming
      if (filters.status === 'historical') return false;

      // Asset type filter
      if (filters.asset_type && fault.asset_type && fault.asset_type !== filters.asset_type) {
        return false;
      }
      // If asset_type filter is set but fault has no asset_type, treat as 'pv'
      if (filters.asset_type && !fault.asset_type && filters.asset_type !== 'pv') {
        return false;
      }

      // Urgency filter
      if (filters.urgency && fault.urgency !== filters.urgency) {
        return false;
      }

      // Fault type filter
      if (filters.fault_type && fault.fault_type !== filters.fault_type) {
        return false;
      }

      // Equipment filter
      if (filters.equipment_id && fault.equipment_id !== filters.equipment_id) {
        return false;
      }

      // Group filter
      if (filters.group_id && equipmentToGroup) {
        const group = equipmentToGroup.get(fault.equipment_id);
        if (!group || group.groupId !== filters.group_id) {
          return false;
        }
      }

      // Search filter
      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesType = fault.fault_type.toLowerCase().includes(searchLower);
        const matchesName = fault.display_name.toLowerCase().includes(searchLower);
        const matchesAction = fault.recommended_action.toLowerCase().includes(searchLower);
        if (!matchesType && !matchesName && !matchesAction) {
          return false;
        }
      }

      return true;
    });
  }, [predictiveFaults, filters, equipmentToGroup]);

  // Apply mode filter, power loss filter, and sorting to get all filtered faults
  const filteredAllFaults = useMemo((): Fault[] => {
    // Step 1: Get base faults by mode
    let faults: Fault[];
    if (filters.mode === 'reactive') {
      faults = [...filteredReactiveFaults];
    } else if (filters.mode === 'predictive') {
      faults = [...filteredPredictiveFaults];
    } else {
      faults = [...filteredReactiveFaults, ...filteredPredictiveFaults];
    }

    // Step 2: Apply power loss range filter
    if (filters.powerLossRange) {
      const { min, max } = filters.powerLossRange;
      faults = faults.filter((fault) => {
        const loss = getEnergyLoss(fault);
        if (min !== undefined && loss < min) return false;
        if (max !== undefined && loss > max) return false;
        return true;
      });
    }

    // Step 3: Apply sorting
    if (sortConfig) {
      const { field, direction } = sortConfig;
      const multiplier = direction === 'asc' ? 1 : -1;

      faults.sort((a, b) => {
        let valueA: number | string;
        let valueB: number | string;

        switch (field) {
          case 'energy_loss':
            valueA = getEnergyLoss(a);
            valueB = getEnergyLoss(b);
            break;
          case 'power_loss':
            valueA = getPowerLoss(a);
            valueB = getPowerLoss(b);
            break;
          case 'fault_type':
            valueA = a.fault_type;
            valueB = b.fault_type;
            break;
          case 'equipment_name':
            valueA = a.equipment_name;
            valueB = b.equipment_name;
            break;
          case 'severity': {
            // Map severity to numeric for sorting
            const severityOrder = { critical: 3, warning: 2, info: 1 };
            valueA = isReactiveFault(a) ? severityOrder[a.severity] || 0 : 0;
            valueB = isReactiveFault(b) ? severityOrder[b.severity] || 0 : 0;
            break;
          }
          case 'urgency': {
            // Map urgency to numeric for sorting
            const urgencyOrder = { urgent: 4, soon: 3, planned: 2, monitoring: 1 };
            valueA = isPredictiveFault(a) ? urgencyOrder[a.urgency] || 0 : 0;
            valueB = isPredictiveFault(b) ? urgencyOrder[b.urgency] || 0 : 0;
            break;
          }
          case 'date':
            valueA = isReactiveFault(a)
              ? new Date(a.timestamp_start).getTime()
              : new Date((a as PredictiveFault).estimated_date || 0).getTime();
            valueB = isReactiveFault(b)
              ? new Date(b.timestamp_start).getTime()
              : new Date((b as PredictiveFault).estimated_date || 0).getTime();
            break;
          case 'duration':
            valueA = isReactiveFault(a) ? a.duration_minutes : 0;
            valueB = isReactiveFault(b) ? b.duration_minutes : 0;
            break;
          case 'days_to_fault':
            valueA = isPredictiveFault(a) ? a.days_to_fault : Infinity;
            valueB = isPredictiveFault(b) ? b.days_to_fault : Infinity;
            break;
          default:
            return 0;
        }

        if (typeof valueA === 'string' && typeof valueB === 'string') {
          return valueA.localeCompare(valueB) * multiplier;
        }

        return ((valueA as number) - (valueB as number)) * multiplier;
      });
    } else {
      // Default ordering: prioritize digital twin gaps, then energy loss, then recency
      const maxEnergyLoss = faults.reduce((max, fault) => Math.max(max, getEnergyLoss(fault)), 0);
      const priorityScore = (fault: Fault) => {
        const energyLoss = maxEnergyLoss ? getEnergyLoss(fault) / maxEnergyLoss : 0;
        const digitalTwinLoss = digitalTwinMaxLoss
          ? (digitalTwinLosses[fault.equipment_id] || 0) / digitalTwinMaxLoss
          : 0;

        const severityScore = isReactiveFault(fault)
          ? fault.severity === 'critical'
            ? 1
            : fault.severity === 'warning'
              ? 0.6
              : 0.3
          : (fault as PredictiveFault).urgency === 'urgent'
            ? 0.8
            : (fault as PredictiveFault).urgency === 'soon'
              ? 0.6
              : 0.3;

        // Push stale alarms down the list
        const now = Date.now();
        const faultDate = isReactiveFault(fault)
          ? new Date(fault.timestamp_start).getTime()
          : new Date((fault as PredictiveFault).estimated_date || now).getTime();
        const daysAgo = Math.max(0, (now - faultDate) / (1000 * 60 * 60 * 24));
        const recencyScore =
          daysAgo <= 7 ? 1 : daysAgo <= 30 ? 0.85 : daysAgo <= 90 ? 0.6 : daysAgo <= 180 ? 0.35 : 0.15;

        return (digitalTwinLoss * 0.55) + (energyLoss * 0.3) + (recencyScore * 0.1) + (severityScore * 0.05);
      };

      faults.sort((a, b) => priorityScore(b) - priorityScore(a));
    }

    return faults;
  }, [
    filteredReactiveFaults,
    filteredPredictiveFaults,
    filters.mode,
    filters.powerLossRange,
    sortConfig,
    getEnergyLoss,
    getPowerLoss,
    digitalTwinLosses,
    digitalTwinMaxLoss,
  ]);

  // Group all faults by their inverter group
  const faultsByGroup = useMemo((): Record<string, Fault[]> => {
    if (!equipmentToGroup) return {};
    const grouped: Record<string, Fault[]> = {};
    for (const fault of allFaults) {
      const group = equipmentToGroup.get(fault.equipment_id);
      if (group) {
        if (!grouped[group.groupId]) {
          grouped[group.groupId] = [];
        }
        grouped[group.groupId].push(fault);
      }
    }
    return grouped;
  }, [allFaults, equipmentToGroup]);

  // Create ticket from fault
  const createTicketFromFault = useCallback(
    async (fault: Fault): Promise<{ id: string } | { error: string }> => {
      try {
        // Determine severity for ticket
        const getSeverity = (f: Fault): 'low' | 'medium' | 'high' | 'critical' => {
          if ('severity' in f) {
            // Reactive fault
            if (f.severity === 'critical') return 'critical';
            if (f.severity === 'warning') return 'high';
            return 'medium';
          } else {
            // Predictive fault
            if (f.urgency === 'urgent') return 'critical';
            if (f.urgency === 'soon') return 'high';
            if (f.urgency === 'planned') return 'medium';
            return 'low';
          }
        };

        // Build trigger metadata
        const isReactive = 'severity' in fault;
        const triggerMetadata = isReactive
          ? {
              anomaly_type: fault.fault_type,
              severity: getSeverity(fault),
              detected_at: (fault as ReactiveFault).timestamp_start,
              metric_name: fault.fault_type,
              expected_value: (fault as ReactiveFault).threshold,
              actual_value: (fault as ReactiveFault).value,
              deviation_pct: (fault as ReactiveFault).threshold
                ? Math.abs(
                    (((fault as ReactiveFault).value || 0) -
                      ((fault as ReactiveFault).threshold || 0)) /
                      ((fault as ReactiveFault).threshold || 1)
                  ) * 100
                : 0,
            }
          : {
              anomaly_type: fault.fault_type,
              severity: getSeverity(fault),
              detected_at: new Date().toISOString(),
              metric_name: (fault as PredictiveFault).display_name,
              expected_value: (fault as PredictiveFault).threshold,
              actual_value: (fault as PredictiveFault).current_value,
              deviation_pct:
                (fault as PredictiveFault).threshold && (fault as PredictiveFault).current_value
                  ? Math.abs(
                      (((fault as PredictiveFault).current_value || 0) -
                        (fault as PredictiveFault).threshold) /
                        (fault as PredictiveFault).threshold
                    ) * 100
                  : 0,
            };

        const response = await fetch('/api/tickets/triggers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            trigger_type: 'PERFORMANCE_ANOMALY',
            trigger_id: fault.id,
            plant_id: plantId,
            inverter_id: fault.equipment_id !== 'plant' ? fault.equipment_id : undefined,
            trigger_metadata: triggerMetadata,
            auto_priority: true,
          }),
        });

        const result = await response.json();

        if (result.error) {
          return { error: result.error };
        }

        return { id: result.id };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Failed to create ticket' };
      }
    },
    [plantId]
  );

  // Validate ticket (mark as correct/incorrect for ML feedback loop)
  const validateTicket = useCallback(
    async (ticketId: string, action: TicketValidationAction, notes?: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tickets/${ticketId}/validate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action, notes }),
        });

        if (!response.ok) {
          console.error('Failed to validate ticket:', await response.text());
          return false;
        }

        // Refresh faults to update ticket status
        await fetchFaults();
        return true;
      } catch (err) {
        console.error('Error validating ticket:', err);
        return false;
      }
    },
    [fetchFaults]
  );

  // Export faults to CSV
  const exportCSV = useCallback(() => {
    const rows: string[] = [];

    // Header
    rows.push([
      'Type',
      'Fault',
      'Equipment',
      'Severity/Urgency',
      'Start Date',
      'Duration (min)',
      'Days to Fault',
      'Power Loss (kW)',
      'Energy Loss (kWh)',
      'Message/Action',
    ].join(','));

    // Reactive faults
    filteredReactiveFaults.forEach((f) => {
      rows.push([
        'Reactive',
        f.fault_type,
        f.equipment_name,
        f.severity,
        f.timestamp_start,
        f.duration_minutes.toString(),
        '',
        f.power_loss_kw.toString(),
        f.energy_loss_kwh.toString(),
        `"${f.message.replace(/"/g, '""')}"`,
      ].join(','));
    });

    // Predictive faults
    filteredPredictiveFaults.forEach((f) => {
      rows.push([
        'Predictive',
        f.fault_type,
        f.equipment_name,
        f.urgency,
        f.estimated_date || '',
        '',
        f.days_to_fault.toString(),
        f.projected_power_loss_kw.toString(),
        f.projected_energy_loss_kwh.toString(),
        `"${f.recommended_action.replace(/"/g, '""')}"`,
      ].join(','));
    });

    // Create and download file
    const csvContent = rows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `faults_${plantId}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredReactiveFaults, filteredPredictiveFaults, plantId]);

  return {
    // Data
    reactiveFaults: enhancedReactiveFaults,
    predictiveFaults,
    allFaults,
    summary: displaySummary,

    // State
    loading,
    error,

    // Filters
    filters,
    setFilters,
    filteredReactiveFaults,
    filteredPredictiveFaults,
    filteredAllFaults,

    // Sorting
    sortConfig,
    setSortConfig,
    toggleSort,

    // Group aggregation
    faultsByGroup,

    // Actions
    refresh: fetchFaults,
    createTicketFromFault,
    validateTicket,
    exportCSV,
  };
}
