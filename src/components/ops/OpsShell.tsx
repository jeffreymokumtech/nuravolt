'use client';

import type { ReactNode } from 'react';
import OpsCommandBar, { type CommandBarMeta } from './OpsCommandBar';
import OpsNavRail, { type NavItem, navForAssetChip, ORG_NAV } from './OpsNavRail';
import CommandPalette from './CommandPalette';
import type { StatusTone } from './StatusLed';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { useQualityToday } from '@/hooks/useQualityToday';

/**
 * The page wrapper for every plant route on /dashboard, /demo and /showcase —
 * and, on /dashboard, for the org-scope screens (fleet home, org settings).
 * Composes the command bar across the top, the nav rail on the left, and a
 * content slot for the page-specific layout. The whole shell sits on the
 * warm grid canvas so the dark-mode 32px grid overlay reads through panel
 * gaps. Links resolve against the current surface via usePlantRoutePrefix.
 *
 * Scope is inferred from `plantId`: present → plant scope (asset-aware rail,
 * plant breadcrumb, telemetry); absent → org scope (ORG_NAV rail, two-crumb
 * breadcrumb, no telemetry).
 */

interface OpsShellProps {
  /** Omit for org-scope screens (fleet home, org settings). */
  plantId?: string;
  activeNavKey: string;
  navItems?: NavItem[];
  /** Optional per-nav-item status dots. */
  navStatus?: Partial<Record<string, StatusTone | null>>;
  commandBar: CommandBarMeta;
  children: ReactNode;
}

export default function OpsShell({
  plantId,
  activeNavKey,
  navItems,
  navStatus,
  commandBar,
  children,
}: OpsShellProps) {
  const prefix = usePlantRoutePrefix();
  // Asset-type-aware nav rail. Resolve the canonical chip from real plant
  // data (asset_type is authoritative; the command bar's display chip is
  // free-form text and inconsistent across pages). Pages may still override
  // by passing navItems explicitly. Falls back to DEFAULT_NAV until plants
  // load or when the plant is unknown. Org scope always gets the ORG rail.
  const { plants } = useDemoPlants();
  const plant = plantId
    ? plants.find((p) => p.slug === plantId || p.id === plantId)
    : undefined;
  const resolvedNav =
    navItems ??
    (plantId
      ? plant
        ? navForAssetChip(assetTypeChip(plant.asset_type))
        : // Plant not resolved yet (still loading, or not in this viewer's
          // scope). Fall back to the PV set rather than letting the rail use
          // its full DEFAULT_NAV: that showed a BESS tab on plants with no
          // battery, which lands on an empty console and reads as broken.
          // Under-showing for a moment self-corrects once the plant loads;
          // offering a dead end does not.
          navForAssetChip('PV')
      : ORG_NAV);

  // Data-quality % in the command bar comes from the SAME source the quality
  // hub reports (month-to-date coverage SLA, /quality/today) — never from a
  // page-passed constant. Shared fetch: on the quality page the shell, the
  // hub header and every tab consume the same cached request. Plants with no
  // quality data show no DQ chip. The fabricated latency figure is dropped
  // entirely (nothing measures it).
  const { data: qualityToday } = useQualityToday(plantId);
  const realDq =
    typeof qualityToday?.sla?.mtd_pct === 'number' ? qualityToday.sla.mtd_pct : null;
  const { latencyMs: _droppedLatency, ...commandBarRest } = commandBar;

  return (
    <div className="ops-canvas min-h-screen w-full">
      <OpsCommandBar
        meta={{
          ...(plantId ? { plantHref: `${prefix}/plant/${plantId}`, plantId } : {}),
          ...commandBarRest,
          dataQualityPct: realDq ?? undefined,
          helpKey: activeNavKey,
        }}
      />
      <div className="flex">
        <OpsNavRail
          plantId={plantId}
          activeKey={activeNavKey}
          items={resolvedNav}
          statusOverrides={navStatus}
        />
        <div className="min-w-0 flex-1 p-3.5">{children}</div>
      </div>
      <CommandPalette plantId={plantId} navItems={resolvedNav} />
    </div>
  );
}
