/**
 * Data fetching hook for per-inverter soiling analysis.
 * Loads static JSON files from public/data/soiling/{plantId}/
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  FleetSummary,
  InverterSoilingMetrics,
  DailySoilingData,
} from '@/types/soiling';

interface UseSoilingDataOptions {
  autoLoad?: boolean;
}

interface UseSoilingDataReturn {
  // Fleet data
  fleetSummary: FleetSummary | null;
  fleetLoading: boolean;
  fleetError: Error | null;
  refetchFleetSummary: () => Promise<void>;

  // Inverter data
  inverterMetrics: Map<string, InverterSoilingMetrics>;
  fetchInverterData: (inverterId: string) => Promise<InverterSoilingMetrics | null>;
  fetchMultipleInverters: (inverterIds: string[]) => Promise<void>;
  inverterLoading: boolean;

  // Time series data
  dailySoilingData: DailySoilingData | null;
  fetchDailySoilingData: () => Promise<void>;
  timeSeriesLoading: boolean;

  // Helpers
  getInverterList: () => string[];
  getGroupInverters: (groupId: string) => string[];
  isLoading: boolean;
}

export function useSoilingData(
  plantId: string = 'alpha1',
  options: UseSoilingDataOptions = {}
): UseSoilingDataReturn {
  const { autoLoad = true } = options;
  const basePath = `/data/soiling/${plantId}`;

  // State
  const [fleetSummary, setFleetSummary] = useState<FleetSummary | null>(null);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetError, setFleetError] = useState<Error | null>(null);

  const [inverterMetrics, setInverterMetrics] = useState<Map<string, InverterSoilingMetrics>>(
    new Map()
  );
  const [inverterLoading, setInverterLoading] = useState(false);

  const [dailySoilingData, setDailySoilingData] = useState<DailySoilingData | null>(null);
  const [timeSeriesLoading, setTimeSeriesLoading] = useState(false);

  // Convert inverterId to filename format (PV-01.001 -> PV_01_001)
  const inverterIdToFilename = useCallback((inverterId: string): string => {
    return inverterId.replace(/[\s.-]/g, '_');
  }, []);

  // Fetch fleet summary
  const refetchFleetSummary = useCallback(async () => {
    setFleetLoading(true);
    setFleetError(null);
    try {
      const response = await fetch(`${basePath}/fleet_summary.json`);
      if (!response.ok) {
        throw new Error(`Failed to fetch fleet summary: ${response.statusText}`);
      }
      const data: FleetSummary = await response.json();
      setFleetSummary(data);
    } catch (err) {
      setFleetError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setFleetLoading(false);
    }
  }, [basePath]);

  // Fetch single inverter data
  const fetchInverterData = useCallback(
    async (inverterId: string): Promise<InverterSoilingMetrics | null> => {
      // Check cache first
      if (inverterMetrics.has(inverterId)) {
        return inverterMetrics.get(inverterId)!;
      }

      setInverterLoading(true);
      try {
        const filename = inverterIdToFilename(inverterId);
        const response = await fetch(`${basePath}/inverters/${filename}.json`);
        if (!response.ok) {
          console.error(`Failed to fetch inverter ${inverterId}: ${response.statusText}`);
          return null;
        }
        const data: InverterSoilingMetrics = await response.json();

        // Update cache
        setInverterMetrics((prev) => {
          const updated = new Map(prev);
          updated.set(inverterId, data);
          return updated;
        });

        return data;
      } catch (err) {
        console.error(`Error fetching inverter ${inverterId}:`, err);
        return null;
      } finally {
        setInverterLoading(false);
      }
    },
    [basePath, inverterIdToFilename, inverterMetrics]
  );

  // Fetch multiple inverters in parallel
  const fetchMultipleInverters = useCallback(
    async (inverterIds: string[]) => {
      setInverterLoading(true);
      try {
        const results = await Promise.all(
          inverterIds.map(async (id) => {
            if (inverterMetrics.has(id)) {
              return { id, data: inverterMetrics.get(id)! };
            }
            const filename = inverterIdToFilename(id);
            const response = await fetch(`${basePath}/inverters/${filename}.json`);
            if (!response.ok) return { id, data: null };
            const data = await response.json();
            return { id, data };
          })
        );

        setInverterMetrics((prev) => {
          const updated = new Map(prev);
          results.forEach(({ id, data }) => {
            if (data) updated.set(id, data);
          });
          return updated;
        });
      } finally {
        setInverterLoading(false);
      }
    },
    [basePath, inverterIdToFilename, inverterMetrics]
  );

  // Fetch daily soiling ratio time series
  const fetchDailySoilingData = useCallback(async () => {
    if (dailySoilingData) return; // Already loaded

    setTimeSeriesLoading(true);
    try {
      const response = await fetch(`${basePath}/time_series/daily_soiling_ratio.json`);
      if (!response.ok) {
        throw new Error(`Failed to fetch time series: ${response.statusText}`);
      }
      const data: DailySoilingData = await response.json();
      setDailySoilingData(data);
    } catch (err) {
      console.error('Error fetching daily soiling data:', err);
    } finally {
      setTimeSeriesLoading(false);
    }
  }, [basePath, dailySoilingData]);

  // Get list of all inverter IDs
  const getInverterList = useCallback((): string[] => {
    if (!fleetSummary) return [];

    const inverters: string[] = [];
    const groups = fleetSummary.plantInfo.inverterGroups;

    groups.forEach((group) => {
      const groupMetrics = fleetSummary.groupMetrics[group];
      if (groupMetrics) {
        // Generate inverter IDs based on group pattern
        const groupNum = group.split('-')[1]; // "PV-01" -> "01"
        for (let i = 1; i <= groupMetrics.inverterCount; i++) {
          const invNum = i.toString().padStart(3, '0');
          inverters.push(`${group}.${invNum}`);
        }
      }
    });

    return inverters;
  }, [fleetSummary]);

  // Get inverters for a specific group
  const getGroupInverters = useCallback(
    (groupId: string): string[] => {
      if (!fleetSummary) return [];

      const groupMetrics = fleetSummary.groupMetrics[groupId];
      if (!groupMetrics) return [];

      const inverters: string[] = [];
      for (let i = 1; i <= groupMetrics.inverterCount; i++) {
        const invNum = i.toString().padStart(3, '0');
        inverters.push(`${groupId}.${invNum}`);
      }
      return inverters;
    },
    [fleetSummary]
  );

  // Auto-load fleet summary on mount
  useEffect(() => {
    if (autoLoad && !fleetSummary && !fleetLoading) {
      refetchFleetSummary();
    }
  }, [autoLoad, fleetSummary, fleetLoading, refetchFleetSummary]);

  // Combined loading state
  const isLoading = useMemo(
    () => fleetLoading || inverterLoading || timeSeriesLoading,
    [fleetLoading, inverterLoading, timeSeriesLoading]
  );

  return {
    fleetSummary,
    fleetLoading,
    fleetError,
    refetchFleetSummary,
    inverterMetrics,
    fetchInverterData,
    fetchMultipleInverters,
    inverterLoading,
    dailySoilingData,
    fetchDailySoilingData,
    timeSeriesLoading,
    getInverterList,
    getGroupInverters,
    isLoading,
  };
}

export default useSoilingData;
