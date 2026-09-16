'use client';

import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const WarrantySandbox = dynamic(() => import('../../../_components/WarrantySandbox'), {
  loading: () => <SectionSkeleton title="Loading warranty sandbox…" />,
  ssr: false,
});

export default function SandboxPage() {
  const params = useParams();
  const plantId = params.plantId as string;

  return (
    <OpsLegacyWrapper
      activeNavKey="settings"
      section="WARRANTY SANDBOX"
      sectionTone="bess"
      assetChip="BESS"
      panelLabel="WARRANTY.sandbox"
      panelMeta="what-if dispatch · degradation projections"
    >
      <WarrantySandbox plantSlug={plantId} />
    </OpsLegacyWrapper>
  );
}
