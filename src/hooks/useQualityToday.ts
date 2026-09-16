'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DegradedStream } from '@/components/soiling/quality/StreamHealthRow';
import type { CurationEntry } from '@/components/soiling/quality/CurationLogCard';

/**
 * useQualityToday — single shared fetch of the daily data-quality snapshot
 * (/api/soiling/plants/{plantId}/quality/today).
 *
 * The command-bar DQ chip (OpsShell), the Today tab, the Summary tab and the
 * freshness strip all need this payload; before this hook each fetched it
 * independently (3× per quality-page load). A module-level cache keyed by
 * plantId shares ONE in-flight request between all subscribers and lets any
 * of them trigger a refresh that updates every consumer.
 *
 * SWR-lite on purpose: no external dependency, no revalidation loops — the
 * snapshot is daily-grained, so cache-until-refresh is the right freshness
 * model. `refresh()` is wired to the hub's Refresh control.
 */

export interface QualitySlaPayload {
  contract_pct: number;
  /** 'configured' when read from plant SLA config; 'default' when the
   *  platform default is used because no SLA is configured. */
  contract_source?: 'configured' | 'default';
  mtd_pct: number;
  projected_eom_pct: number;
  /** How projected_eom_pct was derived (e.g. 'linear run-rate'). */
  projection_method?: string;
  days_remaining_in_month: number;
  iec_reference: string;
}

export interface QualityFreshnessSummary {
  total_streams: number;
  fresh: number;
  stale_under_1h: number;
  stale_under_24h: number;
  stale_over_24h: number;
}

export interface QualitySatelliteFallback {
  active: boolean;
  fallback_source: string;
  substituting_for: string;
  ghi_confidence_band_pct: number;
  engaged_at: string;
}

export interface QualityKpiImpact {
  kpi: string;
  nominal: number;
  band_lo: number;
  band_hi: number;
  degraded_inputs_pct: number;
  reference?: string;
}

export interface QualityTodayPayload {
  plant_id: string;
  generated_at: string;
  sla: QualitySlaPayload | null;
  freshness_summary?: QualityFreshnessSummary;
  top_degraded: DegradedStream[];
  satellite_fallback_active: QualitySatelliteFallback | null;
  kpi_impact: QualityKpiImpact[];
  curation_log_recent: CurationEntry[];
  /** 'computed' (live SQL) | 'fixture' (frozen demo snapshot) | absent (legacy). */
  _source?: string;
  coverage?: string;
}

interface CacheEntry {
  data: QualityTodayPayload | null;
  error: boolean;
  promise: Promise<void> | null;
  subscribers: Set<() => void>;
}

const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<string, CacheEntry>();

function getEntry(plantId: string): CacheEntry {
  let entry = cache.get(plantId);
  if (!entry) {
    entry = { data: null, error: false, promise: null, subscribers: new Set() };
    cache.set(plantId, entry);
  }
  return entry;
}

function notify(entry: CacheEntry) {
  entry.subscribers.forEach((fn) => fn());
}

function fetchToday(plantId: string, entry: CacheEntry): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = (async () => {
    try {
      const res = await fetch(
        `/api/soiling/plants/${encodeURIComponent(plantId)}/quality/today`,
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entry.data = (await res.json()) as QualityTodayPayload;
      entry.error = false;
    } catch {
      entry.data = null;
      entry.error = true;
    } finally {
      window.clearTimeout(timeoutId);
      entry.promise = null;
      notify(entry);
    }
  })();
  entry.promise = promise;
  notify(entry); // let subscribers observe the in-flight (loading) state
  return promise;
}

/** Force a refetch for a plant; all subscribed components update. */
export function refreshQualityToday(plantId: string): Promise<void> {
  const entry = getEntry(plantId);
  entry.data = null;
  entry.error = false;
  return fetchToday(plantId, entry);
}

export function useQualityToday(plantId: string | undefined | null): {
  data: QualityTodayPayload | null;
  isLoading: boolean;
  hasError: boolean;
  refresh: () => Promise<void>;
} {
  const [, force] = useState(0);

  useEffect(() => {
    if (!plantId) return;
    const entry = getEntry(plantId);
    const rerender = () => force((n) => n + 1);
    entry.subscribers.add(rerender);
    if (!entry.data && !entry.error && !entry.promise) {
      void fetchToday(plantId, entry);
    }
    return () => {
      entry.subscribers.delete(rerender);
    };
  }, [plantId]);

  const refresh = useCallback(() => {
    if (!plantId) return Promise.resolve();
    return refreshQualityToday(plantId);
  }, [plantId]);

  if (!plantId) {
    return { data: null, isLoading: false, hasError: false, refresh };
  }
  const entry = getEntry(plantId);
  return {
    data: entry.data,
    isLoading: entry.promise !== null && !entry.data,
    hasError: entry.error,
    refresh,
  };
}
