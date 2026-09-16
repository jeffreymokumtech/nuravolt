'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { anonymizePlantName, anonymizeLocation } from '@/utils/anonymize';

interface AnonymizationContextType {
  isAnonymized: boolean;
  setAnonymized: (value: boolean) => void;
  anonName: (name: string) => string;
  anonLocation: (location: string) => string;
  /**
   * Per-plant scale factor used to anonymize numeric magnitudes (capacity,
   * production, revenue) without changing relative trends.
   *
   *   OFF -> always 1.0
   *   ON  -> seeded per-plant value in the range [0.85, 1.18]
   *
   * Plants in the hard-coded seed map get fixed factors so screenshots
   * stay consistent. Unseeded plants use a deterministic slug-hash fallback
   * so the same slug always produces the same factor.
   */
  scaleFactor: (plantId: string) => number;
}

const STORAGE_KEY = 'nuravolt-demo-anonymized';

// Hard-coded per-plant scale factors. Values chosen inside [0.85, 1.18]
// so anonymized magnitudes stay plausibly close to real ones.
const PLANT_SCALE_SEEDS: Record<string, number> = {
  alpha: 1.08,
  ribera: 0.92,
  eta: 1.15,
  gamma: 0.87,
  epsilon: 1.04,
  delta: 0.95,
  zeta: 1.12,
  theta: 0.89,
};

const SCALE_MIN = 0.85;
const SCALE_MAX = 1.18;

/**
 * Deterministic 32-bit hash of a string (FNV-1a-ish). Stable across runs
 * so the same plantId always produces the same scale factor.
 */
function hashSlug(slug: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function deterministicScale(plantId: string): number {
  const h = hashSlug(plantId);
  const frac = (h % 10000) / 10000; // [0, 1)
  return SCALE_MIN + frac * (SCALE_MAX - SCALE_MIN);
}

const AnonymizationContext = createContext<AnonymizationContextType | undefined>(undefined);

export function AnonymizationProvider({ children }: { children: React.ReactNode }) {
  const [isAnonymized, setIsAnonymized] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'true') {
      setIsAnonymized(true);
    }
  }, []);

  const setAnonymized = (value: boolean) => {
    setIsAnonymized(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  };

  const anonName = (name: string) => isAnonymized ? anonymizePlantName(name) : name;
  const anonLocation = (location: string) => isAnonymized ? anonymizeLocation(location) : location;

  const scaleFactor = (plantId: string): number => {
    if (!isAnonymized) return 1.0;
    if (!plantId) return 1.0;
    const seeded = PLANT_SCALE_SEEDS[plantId];
    if (typeof seeded === 'number') return seeded;
    return deterministicScale(plantId);
  };

  return (
    <AnonymizationContext.Provider
      value={{ isAnonymized, setAnonymized, anonName, anonLocation, scaleFactor }}
    >
      {children}
    </AnonymizationContext.Provider>
  );
}

export function useAnonymization() {
  const context = useContext(AnonymizationContext);
  if (!context) {
    return {
      isAnonymized: false,
      setAnonymized: () => {},
      anonName: (name: string) => name,
      anonLocation: (location: string) => location,
      scaleFactor: (_plantId: string) => 1.0,
    };
  }
  return context;
}
