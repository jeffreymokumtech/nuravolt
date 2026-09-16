'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import {
  useDemoPlants,
  getPlantTelemetry,
  assetTypeChip,
} from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import type { CommandBarMeta } from '@/components/ops/OpsCommandBar';

const DataQualitySection = dynamic(
  () => import('@/components/soiling/DataQualitySection'),
  { loading: () => <SectionSkeleton title="Loading Data Quality Hub..." />, ssr: false },
);

export default function QualityPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();
  const telemetry = getPlantTelemetry(plantId);
  const resolvedAssetChip: CommandBarMeta['assetChip'] = apiPlant
    ? assetTypeChip(apiPlant.asset_type)
    : 'PV+BESS';

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="quality"
      commandBar={{
        section: 'QUALITY',
        sectionTone: 'info',
        plantLabel,
        assetChip: resolvedAssetChip,
        conn: telemetry.conn,
        pollSeconds: telemetry.poll_seconds,
        userInitials: 'AM',
      }}
    >
      <OpsPanel
        label="Data quality · hub"
        subtitle="Data Quality Hub"
        meta="SLA · freshness · sensors · provenance · connections"
        bodyClassName="ops-legacy"
      >
        <DataQualitySection plantId={plantId} />
      </OpsPanel>
    </OpsShell>
  );
}
