/**
 * Data fetching hook for Wind Power Plant analytics.
 * Fetches from /api/wind/plants/{plantId}/ endpoints.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useDataSource } from '@/contexts/DataSourceContext';
import type {
  WindPlantSummary,
  WindTurbine,
  TurbineHealthSummary,
  PowerCurveAnalysis,
  WindFault,
  WindComponentRUL,
  WindFaultCategory,
  WindFaultSeverity,
  ScadaTimeSeriesResponse,
  LabeledEventsResponse,
} from '@/types/wind';
import type { WindRoseData } from '@/components/wind/WindRose';
import type { WakeAnalysisData } from '@/components/wind/WakeMap';

export interface WindSiteData {
  rose: WindRoseData | null;
  wake: WakeAnalysisData | null;
}

// Response types
interface WindTurbinesData {
  turbines: (WindTurbine & { health: TurbineHealthSummary | null })[];
  count: number;
}

interface WindFaultsData {
  faults: WindFault[];
  total: number;
}

interface WindRULData {
  predictions: WindComponentRUL[];
  criticalCount: number;
}

// Filter types
interface WindFaultFilters {
  status?: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity?: WindFaultSeverity;
  category?: WindFaultCategory;
  turbineId?: string;
}

interface WindRULFilters {
  turbineId?: string;
  component?: string;
  urgentOnly?: boolean;
}

interface ScadaFilters {
  turbineId: string;
  start?: string;
  end?: string;
  resolution?: '10min' | 'hourly' | 'daily';
  signals?: string[];
}

interface LabeledEventsFilters {
  turbineId?: string;
  category?: WindFaultCategory;
  severity?: WindFaultSeverity;
}

// Hook return type
interface UseWindDataReturn {
  // Data
  plant: WindPlantSummary | null;
  turbines: WindTurbinesData | null;
  powerCurve: PowerCurveAnalysis | null;
  faults: WindFaultsData | null;
  rul: WindRULData | null;
  // Selected state
  selectedTurbineId: string | null;
  selectedTurbine: (WindTurbine & { health: TurbineHealthSummary | null }) | null;
  // Loading/error
  isLoading: boolean;
  error: Error | null;
  // Actions
  refetch: () => Promise<void>;
  selectTurbine: (turbineId: string | null) => Promise<void>;
  fetchPowerCurve: (turbineId?: string | null) => Promise<PowerCurveAnalysis | null>;
  fetchFaults: (filters?: WindFaultFilters) => Promise<WindFaultsData | null>;
  fetchRUL: (filters?: WindRULFilters) => Promise<WindRULData | null>;
  // CARE dataset methods
  fetchScada: (filters: ScadaFilters) => Promise<ScadaTimeSeriesResponse | null>;
  fetchLabeledEvents: (filters?: LabeledEventsFilters) => Promise<LabeledEventsResponse | null>;
  /** Site climate + wake analysis (wind rose, Jensen wake losses). */
  fetchSite: () => Promise<WindSiteData | null>;
}

interface UseWindDataOptions {
  autoLoad?: boolean;
  defaultTurbineId?: string | null;
}

export function useWindData(
  plantId: string,
  options: UseWindDataOptions = {}
): UseWindDataReturn {
  const { autoLoad = true, defaultTurbineId = null } = options;
  const { readOnly, dataRoot } = useDataSource();
  const basePath = `/api/wind/plants/${plantId}`;
  const staticBase = `${dataRoot}/wind/${plantId}`;

  // In readOnly (showcase) mode, rewrite /api/wind/plants/{id}/... URLs to
  // static JSON files under /data/showcase/wind/{id}/...
  const windFetch = useCallback(
    (url: string): Promise<Response> => {
      if (!readOnly) return fetch(url);
      const [pathPart, queryPart] = url.split('?');
      const suffix = pathPart.replace(basePath, '');
      const params = new URLSearchParams(queryPart || '');
      let staticUrl: string;
      if (suffix === '' || suffix === '/') {
        staticUrl = `${staticBase}/summary.json`;
      } else if (suffix === '/turbines') {
        staticUrl = `${staticBase}/turbines.json`;
      } else if (suffix === '/faults') {
        staticUrl = `${staticBase}/faults.json`;
      } else if (suffix === '/rul') {
        staticUrl = `${staticBase}/rul.json`;
      } else if (suffix === '/power-curve') {
        const turbineId = params.get('turbineId');
        staticUrl = `${staticBase}/power_curve/power_curve_${turbineId || 'fleet'}.json`;
      } else {
        // /scada, /labeled-events — no static fallback, return 404-like response
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return fetch(staticUrl);
    },
    [readOnly, basePath, staticBase]
  );

  // State
  const [plant, setPlant] = useState<WindPlantSummary | null>(null);
  const [turbines, setTurbines] = useState<WindTurbinesData | null>(null);
  const [powerCurve, setPowerCurve] = useState<PowerCurveAnalysis | null>(null);
  const [faults, setFaults] = useState<WindFaultsData | null>(null);
  const [rul, setRUL] = useState<WindRULData | null>(null);
  const [selectedTurbineId, setSelectedTurbineId] = useState<string | null>(defaultTurbineId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Derived state
  const selectedTurbine = useMemo(() => {
    if (!turbines || !selectedTurbineId) return null;
    return turbines.turbines.find((t) => t.id === selectedTurbineId) || null;
  }, [turbines, selectedTurbineId]);

  // Fetch plant summary
  const fetchPlant = useCallback(async (): Promise<WindPlantSummary | null> => {
    try {
      const response = await windFetch(basePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch plant: ${response.statusText}`);
      }
      const data = await response.json();
      setPlant(data.plant);
      return data.plant;
    } catch (err) {
      console.error('Error fetching wind plant:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch turbines with health
  const fetchTurbines = useCallback(async (): Promise<WindTurbinesData | null> => {
    try {
      const response = await windFetch(`${basePath}/turbines`);
      if (!response.ok) {
        throw new Error(`Failed to fetch turbines: ${response.statusText}`);
      }
      const data: WindTurbinesData = await response.json();
      setTurbines(data);
      return data;
    } catch (err) {
      console.error('Error fetching turbines:', err);
      throw err;
    }
  }, [basePath]);

  // Fetch power curve (fleet or specific turbine)
  const fetchPowerCurve = useCallback(
    async (turbineId?: string | null): Promise<PowerCurveAnalysis | null> => {
      try {
        const url = turbineId
          ? `${basePath}/power-curve?turbineId=${turbineId}`
          : `${basePath}/power-curve`;
        const response = await windFetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch power curve: ${response.statusText}`);
        }
        const data = await response.json();
        setPowerCurve(data.analysis);
        return data.analysis;
      } catch (err) {
        console.error('Error fetching power curve:', err);
        throw err;
      }
    },
    [basePath]
  );

  // Fetch faults with optional filters
  const fetchFaults = useCallback(
    async (filters?: WindFaultFilters): Promise<WindFaultsData | null> => {
      try {
        const params = new URLSearchParams();
        if (filters?.status) params.set('status', filters.status);
        if (filters?.severity) params.set('severity', filters.severity);
        if (filters?.category) params.set('category', filters.category);
        if (filters?.turbineId) params.set('turbineId', filters.turbineId);

        const queryString = params.toString();
        const url = queryString
          ? `${basePath}/faults?${queryString}`
          : `${basePath}/faults`;

        const response = await windFetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch faults: ${response.statusText}`);
        }
        const data: WindFaultsData = await response.json();
        setFaults(data);
        return data;
      } catch (err) {
        console.error('Error fetching faults:', err);
        throw err;
      }
    },
    [basePath]
  );

  // Fetch RUL predictions with optional filters
  const fetchRUL = useCallback(
    async (filters?: WindRULFilters): Promise<WindRULData | null> => {
      try {
        const params = new URLSearchParams();
        if (filters?.turbineId) params.set('turbineId', filters.turbineId);
        if (filters?.component) params.set('component', filters.component);
        if (filters?.urgentOnly) params.set('urgent', 'true');

        const queryString = params.toString();
        const url = queryString ? `${basePath}/rul?${queryString}` : `${basePath}/rul`;

        const response = await windFetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch RUL: ${response.statusText}`);
        }
        const data: WindRULData = await response.json();
        setRUL(data);
        return data;
      } catch (err) {
        console.error('Error fetching RUL:', err);
        throw err;
      }
    },
    [basePath]
  );

  // Fetch SCADA time-series data
  const fetchScada = useCallback(
    async (filters: ScadaFilters): Promise<ScadaTimeSeriesResponse | null> => {
      try {
        const params = new URLSearchParams();
        params.set('turbineId', filters.turbineId);
        if (filters.start) params.set('start', filters.start);
        if (filters.end) params.set('end', filters.end);
        if (filters.resolution) params.set('resolution', filters.resolution);
        if (filters.signals?.length) params.set('signals', filters.signals.join(','));

        const url = `${basePath}/scada?${params.toString()}`;
        const response = await windFetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch SCADA data: ${response.statusText}`);
        }
        const data: ScadaTimeSeriesResponse = await response.json();
        return data;
      } catch (err) {
        console.error('Error fetching SCADA:', err);
        throw err;
      }
    },
    [basePath]
  );

  // Fetch labeled events from CARE dataset
  const fetchLabeledEvents = useCallback(
    async (filters?: LabeledEventsFilters): Promise<LabeledEventsResponse | null> => {
      try {
        const params = new URLSearchParams();
        if (filters?.turbineId) params.set('turbineId', filters.turbineId);
        if (filters?.category) params.set('category', filters.category);
        if (filters?.severity) params.set('severity', filters.severity);

        const queryString = params.toString();
        const url = queryString
          ? `${basePath}/labeled-events?${queryString}`
          : `${basePath}/labeled-events`;

        const response = await windFetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch labeled events: ${response.statusText}`);
        }
        const data: LabeledEventsResponse = await response.json();
        return data;
      } catch (err) {
        console.error('Error fetching labeled events:', err);
        throw err;
      }
    },
    [basePath]
  );

  // Site climate + wake analysis. In readOnly (showcase) mode the two
  // fixtures are fetched directly; otherwise the /site API merges them.
  const fetchSite = useCallback(async (): Promise<WindSiteData | null> => {
    try {
      if (readOnly) {
        const [roseRes, wakeRes] = await Promise.all([
          fetch(`${staticBase}/wind_rose.json`),
          fetch(`${staticBase}/wake_analysis.json`),
        ]);
        const rose = roseRes.ok ? await roseRes.json() : null;
        const wake = wakeRes.ok ? await wakeRes.json() : null;
        if (!rose && !wake) return null;
        return { rose, wake };
      }
      const response = await fetch(`${basePath}/site`);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.rose && !data.wake) return null;
      return { rose: data.rose, wake: data.wake };
    } catch (err) {
      console.error('Error fetching site analysis:', err);
      return null;
    }
  }, [readOnly, staticBase, basePath]);

  // Refetch all data
  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      await Promise.all([
        fetchPlant(),
        fetchTurbines(),
        fetchPowerCurve(selectedTurbineId),
        fetchFaults(),
        fetchRUL(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [fetchPlant, fetchTurbines, fetchPowerCurve, fetchFaults, fetchRUL, selectedTurbineId]);

  // Select a specific turbine
  const selectTurbine = useCallback(
    async (turbineId: string | null) => {
      setSelectedTurbineId(turbineId);

      if (turbineId) {
        setIsLoading(true);
        setError(null);

        try {
          await Promise.all([
            fetchPowerCurve(turbineId),
            fetchFaults({ turbineId }),
            fetchRUL({ turbineId }),
          ]);
        } catch (err) {
          setError(err instanceof Error ? err : new Error('Unknown error'));
        } finally {
          setIsLoading(false);
        }
      } else {
        // Reset to fleet-level data
        try {
          await Promise.all([fetchPowerCurve(), fetchFaults(), fetchRUL()]);
        } catch (err) {
          console.error('Error resetting to fleet data:', err);
        }
      }
    },
    [fetchPowerCurve, fetchFaults, fetchRUL]
  );

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad && plantId) {
      refetch();
    }
  }, [autoLoad, plantId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    plant,
    turbines,
    powerCurve,
    faults,
    rul,
    selectedTurbineId,
    selectedTurbine,
    isLoading,
    error,
    refetch,
    selectTurbine,
    fetchPowerCurve,
    fetchFaults,
    fetchRUL,
    // CARE dataset methods
    fetchScada,
    fetchLabeledEvents,
    fetchSite,
  };
}

export default useWindData;
