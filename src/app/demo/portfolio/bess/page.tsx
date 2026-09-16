'use client';

import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import { usePageContext } from '@/components/copilot/usePageContext';

const BessFleetHeatmap = dynamic(() => import('../../_components/BessFleetHeatmap'), {
  loading: () => <SectionSkeleton title="Loading fleet heatmap…" />,
  ssr: false,
});

export default function PortfolioBessPage() {
  usePageContext({ plantName: 'Portfolio fleet (BESS)' });
  return (
    <div className="space-y-4 md:space-y-6">
      <BessFleetHeatmap />
    </div>
  );
}
