import prisma from "@/libs/prisma";

// Demo-tenant scoping. Mirrors the inline constant used in tickets/route.ts
// until a shared org-resolution helper exists.
const DEMO_ORG_ID = "demo_org_alpha1";

export interface ActiveExclusion {
  stream_id: string;
  kpi_names: string[]; // empty array = excludes from ALL KPIs
  starts_at: Date;
  ends_at: Date | null;
}

/**
 * Returns active stream exclusions for a plant at a given timestamp.
 * "Active" means starts_at <= atDate AND (ends_at IS NULL OR ends_at > atDate).
 *
 * Use this in any KPI rollup endpoint (soiling forecast, faults aggregate,
 * BESS metrics) to filter out streams the operator has excluded from a
 * specific KPI — e.g. when calling: const excluded = await
 * getExcludedStreams(plantId, kpi='PR'); then skip those stream_ids when
 * aggregating PR.
 *
 * @param plantId - the plant
 * @param atDate - point-in-time to check; defaults to now
 * @param kpi - optional KPI name; if provided, also matches exclusions where kpi_names is empty (excludes all)
 */
export async function getExcludedStreams(
  plantId: string,
  atDate?: Date,
  kpi?: string,
): Promise<ActiveExclusion[]> {
  const at = atDate ?? new Date();

  try {
    const rows = await prisma.dataStreamExclusion.findMany({
      where: {
        org_clerk_id: DEMO_ORG_ID,
        plant_id: plantId,
        starts_at: { lte: at },
        OR: [{ ends_at: null }, { ends_at: { gt: at } }],
      },
      select: {
        stream_id: true,
        kpi_names: true,
        starts_at: true,
        ends_at: true,
      },
    });

    const active: ActiveExclusion[] = rows.map((r) => ({
      stream_id: r.stream_id,
      kpi_names: r.kpi_names,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
    }));

    if (kpi === undefined) {
      return active;
    }

    // Post-filter: keep exclusions that are global (empty kpi_names) or match this KPI.
    return active.filter(
      (e) => e.kpi_names.length === 0 || e.kpi_names.includes(kpi),
    );
  } catch {
    // Table may not exist yet (migration pending). Fail safe: no exclusions.
    return [];
  }
}

/**
 * Convenience: returns just the stream_id set.
 */
export async function getExcludedStreamIds(
  plantId: string,
  atDate?: Date,
  kpi?: string,
): Promise<Set<string>> {
  const exclusions = await getExcludedStreams(plantId, atDate, kpi);
  return new Set(exclusions.map((e) => e.stream_id));
}
