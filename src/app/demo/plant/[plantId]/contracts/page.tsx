'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import ContractsSection from '@/components/contracts/ContractsSection';

/**
 * Contracts page: PPAs, warranties and O&M SLAs on file for the plant, each
 * term with extraction provenance and a live obligation status.
 */
export default function ContractsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="contracts"
      commandBar={{
        section: 'CONTRACTS',
        plantLabel,
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      <ContractsSection plantId={plantId} />
    </OpsShell>
  );
}
