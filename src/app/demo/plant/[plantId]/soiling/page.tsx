'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants , assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsSoiling from '@/app/demo/_components/OpsSoiling';

/**
 * Soiling intelligence page, SR forecast, zone heatmap, cleaning ROI
 * optimiser. Uses the ops design system with a warm ochre section accent.
 */
export default function SoilingPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="soiling"
      navStatus={{ soiling: 'warn' }}
      commandBar={{
        section: 'SOILING',
        sectionTone: 'warn',
        plantLabel,
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      <OpsSoiling plantId={plantId} />
    </OpsShell>
  );
}
