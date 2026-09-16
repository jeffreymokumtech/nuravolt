'use client';

import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const CurtailmentStory = dynamic(() => import('../../../_components/CurtailmentStory'), {
  loading: () => <SectionSkeleton title="Loading curtailment story…" />,
  ssr: false,
});

export default function CurtailmentPage() {
  const params = useParams();
  const plantId = params.plantId as string;

  return (
    <OpsLegacyWrapper
      activeNavKey="financials"
      section="CURTAILMENT"
      sectionTone="warn"
      panelLabel="CURTAILMENT.story"
      panelMeta="grid-curtailment recovery + revenue impact"
    >
      <CurtailmentStory plantSlug={plantId} />
    </OpsLegacyWrapper>
  );
}
