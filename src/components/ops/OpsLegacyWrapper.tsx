'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  useDemoPlants,
  getPlantTelemetry,
  assetTypeChip,
} from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from './OpsShell';
import OpsPanel from './OpsPanel';
import type { NavItem } from './OpsNavRail';
import type { CommandBarMeta } from './OpsCommandBar';

/**
 * Convenience wrapper for routes that are getting an ops-chrome re-skin but
 * keep their existing inner component intact (phase 8). Renders the ops
 * shell + nav + command bar, then drops the legacy section inside an
 * OpsPanel so it picks up the surrounding chrome without needing a full
 * rewrite. Real ops-native treatment is a follow-up per screen.
 */

interface OpsLegacyWrapperProps {
  activeNavKey: string;
  section: string;
  sectionTone?: CommandBarMeta['sectionTone'];
  panelLabel: string;
  panelMeta?: ReactNode;
  assetChip?: CommandBarMeta['assetChip'];
  navItems?: NavItem[];
  children: ReactNode;
}

export default function OpsLegacyWrapper({
  activeNavKey,
  section,
  sectionTone = 'info',
  panelLabel,
  panelMeta,
  assetChip,
  navItems,
  children,
}: OpsLegacyWrapperProps) {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  // Derive per-plant telemetry from the shared override map. Falls back to
  // the sensible defaults defined in DemoPlantContext when a plant has no
  // override entry, so the chrome stays consistent across all routes.
  const telemetry = getPlantTelemetry(plantId);

  // Derive the asset chip from the plant payload when not explicitly
  // overridden by a caller. `apiPlant.asset_type === 'hybrid'` becomes
  // `PV+BESS`; pure-PV → `PV`; BESS → `BESS`; wind → `WIND`. Falls back to
  // `PV+BESS` if we have no plant data yet (matches the previous default).
  const resolvedAssetChip: CommandBarMeta['assetChip'] =
    assetChip ?? (apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV+BESS');

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey={activeNavKey}
      navItems={navItems}
      commandBar={{
        section,
        sectionTone,
        plantLabel,
        assetChip: resolvedAssetChip,
        conn: telemetry.conn,
        latencyMs: telemetry.latency_ms,
        pollSeconds: telemetry.poll_seconds,
        dataQualityPct: telemetry.data_quality_pct,
        userInitials: 'AM',
      }}
    >
      <OpsPanel label={panelLabel} meta={panelMeta} bodyClassName="ops-legacy">
        {children}
      </OpsPanel>
    </OpsShell>
  );
}
