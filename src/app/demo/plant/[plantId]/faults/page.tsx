'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsFaults from '@/app/demo/_components/OpsFaults';
import WindFaults from '@/app/demo/_components/WindFaults';

export default function FaultsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();
  const chip = apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV+BESS';
  const isWind = chip === 'WIND';

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="faults"
      navStatus={{ faults: 'alarm' }}
      commandBar={{
        section: 'FAULTS',
        sectionTone: 'alarm',
        plantLabel,
        assetChip: chip,
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      {/* Wind plants have their own fault domain (turbine components, labeled
          CARE events, RUL) — the PV fault queue doesn't apply. */}
      {isWind ? <WindFaults plantId={plantId} /> : <OpsFaults plantId={plantId} />}
    </OpsShell>
  );
}
