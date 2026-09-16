'use client';

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

export type PlantTelemetry = {
  conn: 'ok' | 'degraded' | 'down';
  poll_seconds: number;
  // latency_ms / data_quality_pct were REMOVED: they were invented constants
  // (e.g. DQ 99.6% while the quality hub's own SLA said 97.4%). The command
  // bar's DQ chip is now sourced centrally by OpsShell from the real
  // /quality/today month-to-date coverage; nothing measures request latency.
};

export type AssetTypeChip = 'PV' | 'BESS' | 'PV+BESS' | 'WIND' | 'H2' | 'OTHER';

// Simplified plant type matching API response
interface PlantSummary {
  id: string;
  slug: string;
  name: string;
  asset_type: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  capacity_mw: number;
  installed_mw: number | null;
  // Optional fields populated for BESS / hybrid plants only.
  capacity_mwh?: number;
  chemistry?: string;
  market?: string;
  timezone: string;
  status: string;
  has_weather_station: boolean;
  has_dustiq_sensor: boolean;
  inverter_count: number;
  inverter_group_count: number;
  data_source_count: number;
  created_at: string;
  updated_at: string;
  // Optional telemetry block — merged in from per-plant overrides or defaulted.
  telemetry?: PlantTelemetry;
}

// Default telemetry applied to plants with no override.
const DEFAULT_TELEMETRY: PlantTelemetry = {
  conn: 'ok',
  poll_seconds: 2,
};

// Per-plant telemetry overrides keyed by slug.
const PLANT_TELEMETRY_OVERRIDES: Record<string, PlantTelemetry> = {
  alpha: { conn: 'ok', poll_seconds: 1.5 },
  ribera: { conn: 'ok', poll_seconds: 2.0 },
  eta: { conn: 'ok', poll_seconds: 2.0 },
  gamma: { conn: 'degraded', poll_seconds: 5.0 },
};

/**
 * Merge telemetry override (if any) into a plant. Idempotent — preserves
 * any telemetry already attached by the API.
 */
function withTelemetry(plant: PlantSummary): PlantSummary {
  if (plant.telemetry) return plant;
  const override = PLANT_TELEMETRY_OVERRIDES[plant.slug];
  return { ...plant, telemetry: override ?? DEFAULT_TELEMETRY };
}

/**
 * Resolve telemetry for a plant by slug or id. Falls back to the default
 * telemetry block when no override exists.
 */
export function getPlantTelemetry(plantId: string): PlantTelemetry {
  return PLANT_TELEMETRY_OVERRIDES[plantId] ?? DEFAULT_TELEMETRY;
}

/**
 * Derive a short asset-type chip label from the raw asset_type string.
 *   hybrid          -> "PV+BESS"
 *   solar | pv      -> "PV"
 *   battery | bess  -> "BESS"
 *   wind            -> "WIND"
 *   hydrogen        -> "H2"
 *   everything else -> "OTHER"
 */
export function assetTypeChip(assetType: string | null | undefined): AssetTypeChip {
  const t = (assetType ?? '').toLowerCase().trim();
  if (t === 'hybrid') return 'PV+BESS';
  if (t === 'solar' || t === 'pv') return 'PV';
  if (t === 'battery' || t === 'bess') return 'BESS';
  if (t === 'wind') return 'WIND';
  if (t === 'hydrogen' || t === 'h2') return 'H2';
  return 'OTHER';
}

interface PlantContextValue {
  plants: PlantSummary[];
  loading: boolean;
  error: string | null;
  refreshPlants: () => Promise<void>;
  // Legacy compat
  customPlants: any[];
  addPlant: (plant: any) => void;
  removePlant: (plantId: string) => void;
}

const PlantContext = createContext<PlantContextValue>({
  plants: [],
  loading: true,
  error: null,
  refreshPlants: async () => {},
  customPlants: [],
  addPlant: () => {},
  removePlant: () => {},
});

interface DemoPlantProviderProps {
  children: ReactNode;
  /**
   * Static plant list. When provided, the provider skips the /api/plants
   * fetch entirely. Used by the /showcase surface so it has no DB dependency
   * while reusing all the `useDemoPlants`-consuming components.
   */
  staticPlants?: PlantSummary[];
  /**
   * Alternate JSON URL to load from (no DB call). If set, the provider fetches
   * this static JSON instead of /api/plants. Expects `{ data: PlantSummary[] }`.
   */
  staticPlantsUrl?: string;
}

export function DemoPlantProvider({
  children,
  staticPlants,
  staticPlantsUrl,
}: DemoPlantProviderProps) {
  const [plants, setPlants] = useState<PlantSummary[]>(
    staticPlants ? staticPlants.map(withTelemetry) : []
  );
  const [loading, setLoading] = useState(!staticPlants);
  const [error, setError] = useState<string | null>(null);

  const fetchPlants = useCallback(async () => {
    // Static list wins — no network call.
    if (staticPlants) {
      setPlants(staticPlants.map(withTelemetry));
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const url = staticPlantsUrl ?? '/api/plants';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch plants');
      const data = await res.json();
      const fetched: PlantSummary[] = data.data || [];
      setPlants(fetched.map(withTelemetry));
      setError(null);
    } catch (err) {
      console.error('Failed to load plants:', err);
      setError(err instanceof Error ? err.message : 'Failed to load plants');
    } finally {
      setLoading(false);
    }
  }, [staticPlants, staticPlantsUrl]);

  useEffect(() => {
    fetchPlants();
  }, [fetchPlants]);

  // Legacy compat: addPlant just triggers a refetch (wizard already POSTed to API)
  const addPlant = useCallback((_plant: any) => {
    if (!staticPlants) fetchPlants();
  }, [fetchPlants, staticPlants]);

  const removePlant = useCallback((plantId: string) => {
    setPlants(prev => prev.filter(p => p.slug !== plantId && p.id !== plantId));
  }, []);

  return (
    <PlantContext.Provider value={{
      plants,
      loading,
      error,
      refreshPlants: fetchPlants,
      customPlants: plants, // Legacy compat
      addPlant,
      removePlant,
    }}>
      {children}
    </PlantContext.Provider>
  );
}

export function useDemoPlants() {
  return useContext(PlantContext);
}

export function usePlants() {
  return useContext(PlantContext);
}
