import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { resolvePlantForRead } from '@/lib/api/tenant';

/**
 * Zone (block) layout per plant: the array's physical grouping of inverters.
 * This is real site structure, not demo data. Per-zone performance below is
 * computed from the real per-inverter soiling estimate, so this route no longer
 * spawns Python (which could never run on Vercel and silently served random
 * demo numbers on prod).
 */
const ZONE_LAYOUTS: Record<string, {
  zones: Array<{
    zone_id: string;
    zone_name: string;
    inverter_pattern: string;
    inverter_count: number;
  }>;
}> = {
  alpha1: {
    zones: [
      { zone_id: 'zone_a', zone_name: 'Zone A (North)', inverter_pattern: 'INV_0[1-5]', inverter_count: 30 },
      { zone_id: 'zone_b', zone_name: 'Zone B (Central)', inverter_pattern: 'INV_0[6-9]|INV_10', inverter_count: 60 },
      { zone_id: 'zone_c', zone_name: 'Zone C (South)', inverter_pattern: 'INV_1[1-5]', inverter_count: 60 },
    ],
  },
  alpha: {
    zones: [
      { zone_id: 'zone_a', zone_name: 'Zone A (North)', inverter_pattern: 'INV_0[1-5]', inverter_count: 30 },
      { zone_id: 'zone_b', zone_name: 'Zone B (Central)', inverter_pattern: 'INV_0[6-9]|INV_10', inverter_count: 60 },
      { zone_id: 'zone_c', zone_name: 'Zone C (South)', inverter_pattern: 'INV_1[1-5]', inverter_count: 60 },
    ],
  },
  ribera: {
    zones: [
      { zone_id: 'zone_1', zone_name: 'Block 1', inverter_pattern: 'INV_0[1-3]', inverter_count: 30 },
      { zone_id: 'zone_2', zone_name: 'Block 2', inverter_pattern: 'INV_0[4-6]', inverter_count: 30 },
      { zone_id: 'zone_3', zone_name: 'Block 3', inverter_pattern: 'INV_0[7-9]', inverter_count: 30 },
      { zone_id: 'zone_4', zone_name: 'Block 4', inverter_pattern: 'INV_1[0-2]', inverter_count: 30 },
    ],
  },
  eta: {
    zones: [
      { zone_id: 'zone_main', zone_name: 'Main Array', inverter_pattern: 'INV_.*', inverter_count: 28 },
    ],
  },
  delta: {
    zones: [
      { zone_id: 'zone_east', zone_name: 'East Section', inverter_pattern: 'INV_0[1-2]', inverter_count: 20 },
      { zone_id: 'zone_west', zone_name: 'West Section', inverter_pattern: 'INV_0[3-4]', inverter_count: 20 },
    ],
  },
  zeta: {
    zones: [
      { zone_id: 'zone_main', zone_name: 'Main Array', inverter_pattern: 'INV_.*', inverter_count: 30 },
    ],
  },
  gamma: {
    zones: [
      { zone_id: 'zone_north', zone_name: 'North Field', inverter_pattern: 'INV_0[1-2]', inverter_count: 18 },
      { zone_id: 'zone_south', zone_name: 'South Field', inverter_pattern: 'INV_0[3-4]', inverter_count: 17 },
    ],
  },
  epsilon: {
    zones: [
      { zone_id: 'zone_1', zone_name: 'Array 1', inverter_pattern: 'INV_0[1-2]', inverter_count: 20 },
      { zone_id: 'zone_2', zone_name: 'Array 2', inverter_pattern: 'INV_0[3-4]', inverter_count: 20 },
      { zone_id: 'zone_3', zone_name: 'Array 3', inverter_pattern: 'INV_0[5-6]', inverter_count: 18 },
    ],
  },
  // Shared demo org plant (24 inverters in 4 blocks; see docs/DEMO_ACCOUNT.md)
  'kilima-solar': {
    zones: [
      { zone_id: 'zone_1', zone_name: 'Block A (North)', inverter_pattern: 'INV-0[1-6]', inverter_count: 6 },
      { zone_id: 'zone_2', zone_name: 'Block B (East)', inverter_pattern: 'INV-0[7-9]|INV-1[0-2]', inverter_count: 6 },
      { zone_id: 'zone_3', zone_name: 'Block C (South)', inverter_pattern: 'INV-1[3-8]', inverter_count: 6 },
      { zone_id: 'zone_4', zone_name: 'Block D (West)', inverter_pattern: 'INV-19|INV-2[0-4]', inverter_count: 6 },
    ],
  },
  // Showcase plants (anonymised for public demo at /showcase)
  helios: {
    zones: [
      { zone_id: 'zone_1', zone_name: 'Block 1', inverter_pattern: 'INV 01', inverter_count: 29 },
      { zone_id: 'zone_2', zone_name: 'Block 2', inverter_pattern: 'INV 02', inverter_count: 31 },
      { zone_id: 'zone_3', zone_name: 'Block 3', inverter_pattern: 'INV 03', inverter_count: 33 },
      { zone_id: 'zone_4', zone_name: 'Block 4', inverter_pattern: 'INV 04', inverter_count: 27 },
    ],
  },
};

interface PerInverterSr {
  metadata?: {
    generated_at?: string;
    provenance?: { stats_window?: { start?: string; end?: string } };
  };
  inverters?: Record<string, { current_sr?: number; sr_7d_avg?: number }>;
}

/** Read the real per-inverter SR estimate for a plant, if the artifact exists. */
function loadPerInverterSr(plantId: string): PerInverterSr | null {
  const p = path.join(
    process.cwd(),
    'public',
    'data',
    'soiling',
    plantId,
    'per_inverter',
    `${plantId}_per_inverter_sr.json`,
  );
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PerInverterSr;
  } catch {
    return null;
  }
}

function priorityFor(sr: number): { priority: 'low' | 'medium' | 'high'; recommendation: string } {
  if (sr >= 0.95) return { priority: 'low', recommendation: 'Performance within normal range' };
  if (sr >= 0.9) return { priority: 'medium', recommendation: 'Consider scheduling cleaning within 2 weeks' };
  return { priority: 'high', recommendation: 'Prioritize cleaning for this zone' };
}

/**
 * Compute zone performance from the real per-inverter SR. Each inverter is
 * matched to its block by the layout regex; the block's SR is the mean of its
 * inverters. When the per-inverter artifact is absent, zones render without
 * performance rather than fabricated numbers.
 */
function computeZones(plantId: string) {
  const layout = ZONE_LAYOUTS[plantId] || {
    zones: [{ zone_id: 'zone_default', zone_name: 'Full array', inverter_pattern: '.*', inverter_count: 0 }],
  };

  const perInv = loadPerInverterSr(plantId);
  const invEntries = perInv?.inverters ? Object.entries(perInv.inverters) : [];

  const performance = layout.zones.map((zone) => {
    let re: RegExp | null = null;
    try {
      re = new RegExp(`^(?:${zone.inverter_pattern})$`);
    } catch {
      re = null;
    }
    const srs = invEntries
      .filter(([id]) => (re ? re.test(id) : false))
      .map(([, v]) => (typeof v.current_sr === 'number' ? v.current_sr : NaN))
      .filter((n) => Number.isFinite(n));

    if (srs.length === 0) {
      return {
        zone_id: zone.zone_id,
        avg_sr: null,
        avg_loss_pct: null,
        health_score: null,
        cleaning_priority: null,
        recommendation: 'No per-inverter estimate available for this block yet',
        matched_inverters: 0,
      };
    }

    const avgSr = srs.reduce((a, b) => a + b, 0) / srs.length;
    const { priority, recommendation } = priorityFor(avgSr);
    return {
      zone_id: zone.zone_id,
      avg_sr: Math.round(avgSr * 10000) / 10000,
      avg_loss_pct: Math.round((1 - avgSr) * 1000) / 10,
      health_score: Math.round(Math.max(0, Math.min(100, ((avgSr - 0.5) / 0.5) * 100))),
      cleaning_priority: priority,
      recommendation,
      matched_inverters: srs.length,
    };
  });

  const withSr = performance.filter((p) => typeof p.avg_sr === 'number') as Array<{ avg_sr: number }>;
  const plantAvgSr =
    withSr.length > 0 ? withSr.reduce((s, p) => s + p.avg_sr, 0) / withSr.length : null;

  const window = perInv?.metadata?.provenance?.stats_window;
  const analyzedAt = perInv?.metadata?.generated_at ?? new Date().toISOString();

  return {
    success: true,
    plant_id: plantId,
    zones: layout.zones,
    performance,
    summary: {
      total_zones: layout.zones.length,
      total_inverters: layout.zones.reduce((sum, z) => sum + z.inverter_count, 0),
      avg_sr: plantAvgSr,
      zones_needing_cleaning: performance.filter((p) => p.cleaning_priority === 'high').length,
    },
    has_per_inverter_data: invEntries.length > 0,
    analysis_timestamp: analyzedAt,
    analyzed_at: analyzedAt,
    data_period: {
      start: window?.start ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      end: window?.end ?? new Date().toISOString().slice(0, 10),
    },
  };
}

/**
 * GET /api/soiling/plants/[plantId]/zones
 * Per-block soiling performance, computed in-process from the real per-inverter
 * SR estimate. Org-owned plants need a session + PlantAccess; demo/unaffiliated
 * plants stay publicly readable (showcase).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { plantId: string } },
) {
  const { plantId } = params;
  const readAccess = await resolvePlantForRead(plantId);
  if (!readAccess.ok) return readAccess.response;

  try {
    return NextResponse.json(computeZones(plantId));
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/zones:', error);
    return NextResponse.json({ error: 'Failed to compute zones' }, { status: 500 });
  }
}

/**
 * POST /api/soiling/plants/[plantId]/zones
 * Saving a custom zone configuration is not built yet (it used to spawn Python).
 * Honest 501 rather than a fake "saved" response.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Editing zone configuration is not available yet', code: 'not_implemented' },
    { status: 501 },
  );
}
