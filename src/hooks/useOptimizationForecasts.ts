/**
 * React hook for loading and caching optimization forecasts
 *
 * Loads three forecast types:
 * - ML predictions (365 days)
 * - AOD forecast (5 days)
 * - Rain forecast (16 days)
 *
 * Features:
 * - 6-hour cache TTL in sessionStorage
 * - Parallel loading for performance
 * - Error handling with retry logic
 * - Loading states for UI feedback
 */

import { useState, useEffect } from 'react';
import type {
  OptimizationForecasts,
  DigitalTwinDataPoint,
  AODForecastPoint,
  RainForecastPoint,
} from '@/types/soiling';
import { loadAODForecast } from '@/utils/aodDataLoader';
import { fetchRainForecast } from '@/utils/rainDataFetcher';
import { useDataRoot } from '@/contexts/DataSourceContext';

// Cache TTL: 6 hours in milliseconds
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// SessionStorage keys
const CACHE_KEY_PREFIX = 'optimization_forecasts_';

interface ForecastCache {
  data: OptimizationForecasts;
  timestamp: number;
}

interface UseOptimizationForecastsResult {
  forecasts: OptimizationForecasts | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to load and cache optimization forecasts
 *
 * @param plantId Plant identifier (e.g., 'alpha1', 'eta', 'ribera')
 * @returns Forecasts data, loading state, error state, and refetch function
 */
export function useOptimizationForecasts(plantId: string): UseOptimizationForecastsResult {
  const [forecasts, setForecasts] = useState<OptimizationForecasts | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState<number>(0);
  const dataRoot = useDataRoot();

  useEffect(() => {
    let isMounted = true;

    async function loadForecasts() {
      try {
        setLoading(true);
        setError(null);

        // Check cache first
        const cachedData = getCachedForecasts(plantId);
        if (cachedData) {
          if (isMounted) {
            setForecasts(cachedData);
            setLoading(false);
          }
          return;
        }

        // Load all forecasts in parallel
        const [mlData, aodData, rainData] = await Promise.all([
          loadMLForecast365d(plantId, dataRoot),
          loadAODForecast(plantId, dataRoot).catch(() => null), // Optional: graceful fallback
          fetchRainForecast(plantId).catch(() => null), // Optional: graceful fallback
        ]);

        const forecastData: OptimizationForecasts = {
          ml: mlData,
          aod: aodData || undefined,
          rain: rainData || undefined,
          loaded_at: new Date().toISOString(),
        };

        // Cache the result
        cacheForecasts(plantId, forecastData);

        if (isMounted) {
          setForecasts(forecastData);
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to load optimization forecasts:', err);
        if (isMounted) {
          setError(err instanceof Error ? err : new Error('Failed to load forecasts'));
          setLoading(false);
        }
      }
    }

    loadForecasts();

    return () => {
      isMounted = false;
    };
  }, [plantId, refetchTrigger]);

  const refetch = () => {
    // Clear cache and trigger reload
    clearCachedForecasts(plantId);
    setRefetchTrigger(prev => prev + 1);
  };

  return { forecasts, loading, error, refetch };
}

// ============================================================
// ML Forecast Loading
// ============================================================

/**
 * Load 365-day ML forecast from public data directory
 *
 * @param plantId Plant identifier
 * @returns Array of digital twin data points
 */
async function loadMLForecast365d(
  plantId: string,
  dataRoot: string,
): Promise<DigitalTwinDataPoint[]> {
  const response = await fetch(`${dataRoot}/soiling/${plantId}/ml_forecast_365d.json`);

  if (!response.ok) {
    throw new Error(`Failed to load ML forecast: ${response.statusText}`);
  }

  const data = await response.json();

  // Handle different JSON structures
  if (data.forecasts) {
    return data.forecasts;
  } else if (data.daily_forecasts) {
    return data.daily_forecasts;
  } else if (Array.isArray(data)) {
    return data;
  }

  throw new Error('Invalid ML forecast JSON structure');
}

// ============================================================
// Cache Management
// ============================================================

/**
 * Get cached forecasts if available and not expired
 *
 * @param plantId Plant identifier
 * @returns Cached forecasts or null
 */
function getCachedForecasts(plantId: string): OptimizationForecasts | null {
  try {
    const cacheKey = CACHE_KEY_PREFIX + plantId;
    const cachedStr = sessionStorage.getItem(cacheKey);

    if (!cachedStr) {
      return null;
    }

    const cached: ForecastCache = JSON.parse(cachedStr);
    const now = Date.now();

    // Check if cache is still valid (within TTL)
    if (now - cached.timestamp > CACHE_TTL_MS) {
      // Cache expired, remove it
      sessionStorage.removeItem(cacheKey);
      return null;
    }

    return cached.data;
  } catch (err) {
    console.warn('Failed to read cached forecasts:', err);
    return null;
  }
}

/**
 * Cache forecasts in sessionStorage
 *
 * @param plantId Plant identifier
 * @param forecasts Forecast data to cache
 */
function cacheForecasts(plantId: string, forecasts: OptimizationForecasts): void {
  try {
    const cacheKey = CACHE_KEY_PREFIX + plantId;
    const cache: ForecastCache = {
      data: forecasts,
      timestamp: Date.now(),
    };

    sessionStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch (err) {
    console.warn('Failed to cache forecasts:', err);
    // Not critical, continue without caching
  }
}

/**
 * Clear cached forecasts for a plant
 *
 * @param plantId Plant identifier
 */
function clearCachedForecasts(plantId: string): void {
  try {
    const cacheKey = CACHE_KEY_PREFIX + plantId;
    sessionStorage.removeItem(cacheKey);
  } catch (err) {
    console.warn('Failed to clear cached forecasts:', err);
  }
}
