'use client';

import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const HybridCockpit = dynamic(() => import('../../../_components/HybridCockpit'), {
  loading: () => <SectionSkeleton title="Loading hybrid cockpit…" />,
  ssr: false,
});

export default function HybridCockpitPage() {
  const params = useParams();
  const plantId = params.plantId as string;

  return (
    <OpsLegacyWrapper
      activeNavKey="overview"
      section="HYBRID COCKPIT"
      sectionTone="info"
      panelLabel="HYBRID.cockpit"
      panelMeta="PV + BESS + genset co-located orchestration"
    >
      <HybridCockpit plantSlug={plantId} />
    </OpsLegacyWrapper>
  );
}
