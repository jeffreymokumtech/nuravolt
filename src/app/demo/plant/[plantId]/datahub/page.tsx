'use client';

import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const DataHubSection = dynamic(
  () => import('@/app/demo/_components/DataHubSection'),
  { loading: () => <SectionSkeleton title="Loading Data Hub..." />, ssr: false },
);

export default function DataHubPage() {
  return (
    <OpsLegacyWrapper
      activeNavKey="datahub"
      section="DATA HUB"
      panelLabel="DATA_HUB.connections"
      panelMeta="SCADA · InfluxDB · Modbus · CSV · SunSpec"
    >
      <DataHubSection />
    </OpsLegacyWrapper>
  );
}
