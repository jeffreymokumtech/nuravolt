'use client';

/**
 * Shared client helpers for BESS report widgets: resolve a plant's first
 * BESS asset and fetch its sub-resources from the DB/fixture-unified API
 * (/api/bess/plants/...). The API works for DB-backed org plants (e.g.
 * region_a-storage) AND fixture demo/showcase plants; widgets keep the raw
 * static-fixture path only as a last-resort fallback for surfaces where the
 * API is not reachable.
 */

export async function fetchFirstBessAsset(
  plantId: string
): Promise<{ id: string; installationDate: string | null } | null> {
  try {
    const res = await fetch(`/api/bess/plants/${encodeURIComponent(plantId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const a = data?.assets?.[0];
    return a ? { id: a.id, installationDate: a.installationDate ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Find the first plant in the widget's scope that actually has a BESS asset.
 * A mixed PV+BESS scope used to resolve to plantIds[0] (usually the PV
 * plant), leaving every BESS widget empty even though a storage plant was
 * in scope.
 */
export async function resolveBessPlant(
  plantIds: string[]
): Promise<{ plantId: string; asset: { id: string; installationDate: string | null } } | null> {
  for (const pid of plantIds) {
    const asset = await fetchFirstBessAsset(pid);
    if (asset) return { plantId: pid, asset };
  }
  return null;
}

export async function fetchBessAssetResource<T>(
  plantId: string,
  assetId: string,
  resource: 'dispatch' | 'cycling' | 'warranty'
): Promise<T | null> {
  try {
    const res = await fetch(
      `/api/bess/plants/${encodeURIComponent(plantId)}/assets/${encodeURIComponent(assetId)}/${resource}`
    );
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
