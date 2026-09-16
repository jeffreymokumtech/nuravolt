'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import { assetTypeChip, getPlantTelemetry } from '@/contexts/DemoPlantContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import DataLineagePanel from '@/components/data-hub/DataLineagePanel';
import ConnectionsManager from '@/components/data-hub/ConnectionsManager';

/**
 * Per-plant Data Hub, embedded in the ops chrome (nav rail + command bar) like
 * every other plant section. Shows the data-lineage provenance panel (where
 * each stream comes from) first, then the connections manager scoped to THIS
 * plant's sources — the fleet-wide list lives at /dashboard/settings/connections.
 */
export default function PlantDataHubPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const telemetry = getPlantTelemetry(plantId);

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="datahub"
      commandBar={{
        section: 'DATA HUB',
        sectionTone: 'info',
        plantLabel: (apiPlant?.name ?? plantId).toUpperCase(),
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV+BESS',
        conn: telemetry.conn,
        pollSeconds: telemetry.poll_seconds,
        userInitials: 'AM',
      }}
    >
      <div className="flex flex-col gap-4">
        <DataLineagePanel plantId={plantId} />
        <OpsPanel
          label="Data hub · connections"
          subtitle="Data sources feeding this plant"
          meta={
            <Link
              href="/dashboard/settings/connections"
              className="hover:underline"
              style={{ color: 'var(--ops-info)' }}
            >
              Manage all connections →
            </Link>
          }
          bodyClassName="ops-legacy"
        >
          <ConnectionsManager hideHeader plantSlug={apiPlant?.slug ?? plantId} />
        </OpsPanel>
      </div>
    </OpsShell>
  );
}
