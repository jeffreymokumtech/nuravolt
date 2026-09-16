'use client';

import { useEffect, useState } from 'react';

/**
 * Client-side plan/feature lookup for UI gating (UpgradeGate panels, export
 * buttons, upgrade CTAs). One fetch of /api/billing/plan on mount — the
 * server-side requireFeature() 402s remain the real enforcement.
 */
export interface PlanFeaturesState {
  plan: string | null;
  features: Record<string, boolean>;
  loading: boolean;
}

export function usePlanFeatures(): PlanFeaturesState {
  const [state, setState] = useState<PlanFeaturesState>({
    plan: null,
    features: {},
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/billing/plan')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setState({
          plan: data?.plan ?? null,
          features: data?.features ?? {},
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
