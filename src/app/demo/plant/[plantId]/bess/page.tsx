'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants , assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsBattery from '@/app/demo/_components/OpsBattery';

/**
 * Battery analytics page, depth view for a single BESS asset (SoH
 * projection, warranty tracker, cycle-depth rainflow, module thermal map).
 * Uses the ops shell and design language, with violet BESS section accent.
 */
export default function BessAnalyticsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="battery"
      navStatus={{ battery: 'bess' }}
      commandBar={{
        section: 'BATTERY',
        sectionTone: 'bess',
        plantLabel,
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'BESS',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
        // No `extras`. This slot carried the literals "Samsung SDI · SBB 3.2
        // C&I" and "COD 2023-11-15", rendered for every BESS plant whatever
        // hardware it actually held, so Ribera's Sungrow PowerTitan showed a
        // competitor's model number and a commissioning date belonging to
        // nothing. The manufacturer, chemistry, capacity and real commissioning
        // date are read from the asset and rendered by OpsBattery's own header
        // immediately below, which is the one that has the data.
      }}
    >
      <OpsBattery plantId={plantId} />
    </OpsShell>
  );
}
