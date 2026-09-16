'use client';

import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const BessRevenueCockpit = dynamic(() => import('../../../_components/BessRevenueCockpit'), {
  loading: () => <SectionSkeleton title="Loading revenue cockpit…" />,
  ssr: false,
});

export default function RevenuePage() {
  const params = useParams();
  const plantId = params.plantId as string;

  return (
    <OpsLegacyWrapper
      activeNavKey="financials"
      section="REVENUE COCKPIT"
      sectionTone="ok"
      panelLabel="BESS.revenue · cockpit"
      panelMeta="arbitrage · frequency regulation · capacity payments"
    >
      <BessRevenueCockpit plantSlug={plantId} />
    </OpsLegacyWrapper>
  );
}
