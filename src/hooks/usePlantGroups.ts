'use client';

import { useState, useEffect, useMemo } from 'react';
import { useDataSource } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface InverterInfo {
  id: string;
  external_id: string;
  name: string | null;
  model: string | null;
  nominal_power_kw: number | null;
}

interface GroupInfo {
  id: string;
  name: string;
  slug: string;
  tilt: number;
  azimuth: number;
  inverter_model: string | null;
  inverter_nominal_power_kw: number | null;
  inverters: InverterInfo[];
}

export interface PlantGroup {
  id: string;
  name: string;
  slug: string;
  tilt: number;
  azimuth: number;
  inverterModel: string | null;
  inverterCount: number;
  inverterIds: string[]; // external_ids for cross-referencing with fault/soiling data
}

export interface EquipmentGroupMapping {
  groupId: string;
  groupName: string;
  groupSlug: string;
}

/**
 * Shared hook for fetching plant inverter groups and building
 * an equipment_id → group mapping used across Overview, Faults, Heatmap, Soiling.
 */
export function usePlantGroups(plantId: string) {
  const [rawGroups, setRawGroups] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { readOnly, dataRoot } = useDataSource();
  const prefix = usePlantRoutePrefix();

  useEffect(() => {
    if (!plantId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchGroups() {
      setLoading(true);
      setError(null);
      try {
        // Try the static fixture first — works for demo (no provider) and
        // showcase (readOnly provider). Falls back to the DB-backed API when
        // the fixture is absent, so customer plants onboarded via the wizard
        // still resolve through Prisma. On /dashboard (real org plants) skip
        // the fixture entirely and read the API to avoid a stray /data 404.
        if (prefix !== '/dashboard') {
          const staticRes = await fetch(
            `${dataRoot}/plants/${plantId}/inverter_groups.json`
          );
          if (staticRes.ok) {
            const json = await staticRes.json();
            const groups = json?.inverter_groups || json?.groups || [];
            if (Array.isArray(groups) && groups.length > 0) {
              if (!cancelled) {
                setRawGroups(groups);
                setLoading(false);
              }
              return;
            }
          }
        }
        if (readOnly) {
          if (!cancelled) {
            setRawGroups([]);
            setLoading(false);
          }
          return;
        }
        const res = await fetch(`/api/plants/${plantId}`);
        if (!res.ok) throw new Error('Failed to fetch plant data');
        const data = await res.json();
        if (!cancelled) {
          setRawGroups(data.data?.inverter_groups || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load groups');
          setRawGroups([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchGroups();
    return () => { cancelled = true; };
  }, [plantId, dataRoot, readOnly, prefix]);

  // Normalized group list
  const groups: PlantGroup[] = useMemo(() =>
    rawGroups.map(g => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      tilt: g.tilt,
      azimuth: g.azimuth,
      inverterModel: g.inverter_model,
      inverterCount: g.inverters.length,
      inverterIds: g.inverters.map(inv => {
        // Normalize INV_01_001 → INV 01.001 to match SCADA format
        const eid = inv.external_id;
        const m = eid.match(/^INV_(\d+)_(\d+)$/);
        return m ? `INV ${m[1]}.${m[2]}` : eid;
      }),
    })),
    [rawGroups]
  );

  // Map from external_id → group info (for mapping equipment_id in faults/soiling to groups)
  const equipmentToGroup: Map<string, EquipmentGroupMapping> = useMemo(() => {
    const map = new Map<string, EquipmentGroupMapping>();
    for (const group of rawGroups) {
      const mapping: EquipmentGroupMapping = {
        groupId: group.id,
        groupName: group.name,
        groupSlug: group.slug,
      };
      for (const inv of group.inverters) {
        map.set(inv.external_id, mapping);
        // Also map normalized SCADA format: INV_01_001 → INV 01.001
        const m = inv.external_id.match(/^INV_(\d+)_(\d+)$/);
        if (m) map.set(`INV ${m[1]}.${m[2]}`, mapping);
        if (inv.name && inv.name !== inv.external_id) {
          map.set(inv.name, mapping);
        }
      }
    }
    return map;
  }, [rawGroups]);

  // Inverter count per group
  const groupInverterCounts: Record<string, number> = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of groups) {
      counts[g.id] = g.inverterCount;
    }
    return counts;
  }, [groups]);

  return { groups, equipmentToGroup, groupInverterCounts, loading, error };
}
