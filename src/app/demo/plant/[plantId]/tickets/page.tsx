'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useDemoPlants , assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import SectionSkeleton from '@/components/SectionSkeleton';

const TicketsSection = dynamic(
  () => import('@/app/demo/_components/TicketsSection'),
  { loading: () => <SectionSkeleton title="Loading Tickets..." />, ssr: false },
);

/**
 * Tickets page, re-skinned shell only for phase 7. The TicketsSection
 * Kanban + validation modal + AIAnalysisCard (phase 1) are wrapped in the
 * ops chrome. A full ops-table treatment of the ticket board is a future
 * follow-up; the AIAnalysisCard's LLM narration flow keeps working as-is.
 */
export default function TicketsPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="tickets"
      commandBar={{
        section: 'TICKETS',
        sectionTone: 'info',
        plantLabel,
        assetChip: apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV+BESS',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      <OpsPanel
        label="O&M TICKETS · workflow"
        meta={
          <span>
            Kanban · drag to transition · AI Analysis card on{' '}
            <span style={{ color: 'var(--ops-bess)' }}>PERFORMANCE_ANOMALY</span> triggers
          </span>
        }
        bodyClassName="ops-legacy"
      >
        <TicketsSection />
      </OpsPanel>
    </OpsShell>
  );
}
