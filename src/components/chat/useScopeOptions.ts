'use client';

import { useEffect, useState } from 'react';

/**
 * Lazy scope option lists for the chat surfaces, shared by AssetContextChip
 * (selects) and MessageInput's tag palette. Fetches only while `active`;
 * fails gracefully to empty lists (anonymous /showcase gets 401s).
 */

export interface PlantOpt {
  id: string;
  slug: string;
  name: string;
}

export interface InverterOpt {
  id: string;
  name: string;
  group: string;
}

export function useScopeOptions(active: boolean, plantId: string | null | undefined) {
  const [plants, setPlants] = useState<PlantOpt[]>([]);
  const [inverters, setInverters] = useState<InverterOpt[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [loadingInverters, setLoadingInverters] = useState(false);
  const [fetchedPlants, setFetchedPlants] = useState(false);

  useEffect(() => {
    if (!active || fetchedPlants || loadingPlants) return;
    setLoadingPlants(true);
    fetch('/api/chat/scope/plants')
      .then((r) => (r.ok ? r.json() : { plants: [] as PlantOpt[] }))
      .then((d) => setPlants(d.plants ?? []))
      .catch(() => setPlants([]))
      .finally(() => {
        setLoadingPlants(false);
        setFetchedPlants(true);
      });
  }, [active, fetchedPlants, loadingPlants]);

  useEffect(() => {
    if (!active || !plantId) {
      setInverters([]);
      return;
    }
    let alive = true;
    setLoadingInverters(true);
    fetch(`/api/chat/scope/plants/${encodeURIComponent(plantId)}/inverters`)
      .then((r) => (r.ok ? r.json() : { inverters: [] as InverterOpt[] }))
      .then((d) => {
        if (alive) setInverters(d.inverters ?? []);
      })
      .catch(() => {
        if (alive) setInverters([]);
      })
      .finally(() => {
        if (alive) setLoadingInverters(false);
      });
    return () => {
      alive = false;
    };
  }, [active, plantId]);

  return { plants, inverters, loadingPlants, loadingInverters };
}
