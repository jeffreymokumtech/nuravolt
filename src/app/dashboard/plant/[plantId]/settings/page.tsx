'use client';

/**
 * Real, persisted plant settings (general / alerts / notifications / access).
 * The demo + showcase surfaces keep their read-only SettingsSection mock;
 * this page is /dashboard-only and writes through /api/plants/[id]/settings.
 */

import { useParams } from 'next/navigation';
import { useDemoPlants, assetTypeChip, getPlantTelemetry } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import PlantSettingsPanel from '@/components/settings/PlantSettingsPanel';

export default function DashboardPlantSettingsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const telemetry = getPlantTelemetry(plantId);

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="settings"
      commandBar={{
        section: 'SETTINGS',
        sectionTone: 'info',
        plantLabel: (apiPlant?.name ?? plantId).toUpperCase(),
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : null,
        conn: telemetry.conn,
        pollSeconds: telemetry.poll_seconds,
        userInitials: 'AM',
      }}
    >
      <PlantSettingsPanel plantId={plantId} />
    </OpsShell>
  );
}
