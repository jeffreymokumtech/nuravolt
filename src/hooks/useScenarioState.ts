'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Generic scenario-slider state hook.
 *
 * - Initialises from `defaults`.
 * - Persists to localStorage under `key` so demo state survives reloads.
 * - Exposes `setParam`, `reset`, and an `isDirty` flag (any param drifted
 *   from defaults).
 *
 * Use one hook instance per scenario surface (e.g. the warranty sandbox).
 * For per-plant scenarios pass `key={`bess.sandbox.${plantSlug}`}`.
 */
export function useScenarioState<T extends Record<string, number>>(
  defaults: T,
  key: string
): {
  params: T;
  setParam: <K extends keyof T>(k: K, v: T[K]) => void;
  setMany: (patch: Partial<T>) => void;
  reset: () => void;
  isDirty: boolean;
} {
  const defaultsRef = useRef(defaults);
  const [params, setParams] = useState<T>(defaults);

  // Hydrate once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setParams((p) => ({ ...p, ...parsed }));
      }
    } catch {
      // Storage disabled or corrupt — fall back to defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on every change. Synchronous JSON.stringify is fine here —
  // the param object is tiny and writes happen on slider release / click.
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(params));
    } catch {
      // Ignore — quota or private-mode failure shouldn't break the UI.
    }
  }, [key, params]);

  const setParam = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setParams((p) => ({ ...p, [k]: v }));
  }, []);

  const setMany = useCallback((patch: Partial<T>) => {
    setParams((p) => ({ ...p, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setParams(defaultsRef.current);
  }, []);

  const isDirty = useMemo(() => {
    const d = defaultsRef.current;
    for (const k in d) if (d[k] !== params[k]) return true;
    return false;
  }, [params]);

  return { params, setParam, setMany, reset, isDirty };
}
