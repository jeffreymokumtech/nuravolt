'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants , assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsFinancials from '@/app/demo/_components/OpsFinancials';

export default function FinancialsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="financials"
      commandBar={{
        section: 'FINANCIALS',
        sectionTone: 'info',
        plantLabel,
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV+BESS',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      <OpsFinancials plantId={plantId} />
    </OpsShell>
  );
}
