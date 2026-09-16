/**
 * Data hook for the hydrogen (electrolyzer) console.
 * Fetches /api/hydrogen/plants/{plantId} once and exposes the pieces.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HydrogenPlantResponse } from '@/types/hydrogen';

export function useHydrogenData(plantId: string) {
  const [data, setData] = useState<HydrogenPlantResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/hydrogen/plants/${plantId}`);
      if (!res.ok) throw new Error(`Failed to load hydrogen data (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to load hydrogen data'));
    } finally {
      setIsLoading(false);
    }
  }, [plantId]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    asset: data?.asset ?? null,
    production: data?.production ?? [],
    stackHealth: data?.stackHealth ?? [],
    source: data?._source ?? 'empty',
    isLoading,
    error,
    refetch: load,
  };
}
