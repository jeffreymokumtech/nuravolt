'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import GuidedTour, { TourTrigger, PLANT_TOUR_STEPS } from '@/components/demo/GuidedTour';
import { useDemoPlants, getPlantTelemetry } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import { usePlantRoutePrefix, homeHrefFor } from '@/utils/routePrefix';

// The overview is the only section this page renders, every other section
// has its own route (/financials, /faults, /soiling, …) since the route
// migration. Old #hash deep links are redirected below.
import OverviewSection from '../../_components/OverviewSection';
import OpsShell from '@/components/ops/OpsShell';
import OpsOverview from '../../_components/OpsOverview';

const BessSection = dynamic(() => import('../../_components/BessSection'), {
  loading: () => <SectionSkeleton title="Loading Battery Storage..." />,
  ssr: false,
});
const WindSection = dynamic(() => import('@/components/wind/WindSection'), {
  loading: () => <SectionSkeleton title="Loading Wind Dashboard..." />,
  ssr: false,
});
const HydrogenSection = dynamic(() => import('@/components/hydrogen/HydrogenSection'), {
  loading: () => <SectionSkeleton title="Loading Electrolyzer Console..." />,
  ssr: false,
});

type AssetType = 'SOLAR' | 'WIND' | 'BESS' | 'HYDROGEN';

/**
 * Hash → route map for legacy deep links (/demo/plant/x#soiling etc.).
 * `heatmap` lands on the faults route where the heatmap now lives.
 */
const HASH_ROUTE: Record<string, string> = {
  financials: '/financials',
  faults: '/faults',
  heatmap: '/faults#heatmap',
  soiling: '/soiling',
  tickets: '/tickets',
  quality: '/quality',
  datahub: '/datahub',
  settings: '/settings',
  bess: '/bess',
  hybrid: '/hybrid',
  sandbox: '/sandbox',
  curtailment: '/curtailment',
  revenue: '/revenue',
};

export default function PlantPage() {
  const params = useParams();
  const router = useRouter();
  const plantId = params.plantId as string;
  const [showTour, setShowTour] = useState(false);
  const { plants, loading } = useDemoPlants();
  const prefix = usePlantRoutePrefix();

  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const assetType: AssetType =
    apiPlant?.asset_type === 'PV' ? 'SOLAR' : ((apiPlant?.asset_type as AssetType) ?? 'SOLAR');
  const isCustomPlant = apiPlant?.status === 'ONBOARDING' || apiPlant?.status === 'CONFIGURING';

  // Redirect legacy hash deep links to the new section routes.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash && HASH_ROUTE[hash]) {
      router.replace(`${prefix}/plant/${plantId}${HASH_ROUTE[hash]}`);
    }
  }, [plantId, prefix, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
          <p className="mt-4 text-ink-2">Loading plant data...</p>
        </div>
      </div>
    );
  }

  // Newly onboarded plants get a confirmation card until data flows.
  if (isCustomPlant) {
    return (
      <div className="space-y-4 md:space-y-6">
        <div className="rounded-xl border border-divider bg-white p-8 text-center shadow-sm md:p-12">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
            <svg className="h-8 w-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mb-2 text-2xl font-bold text-ink">Plant Onboarded Successfully</h2>
          <p className="mx-auto mb-6 max-w-md text-ink-2">
            <strong>{apiPlant?.name}</strong> has been onboarded and is awaiting its first data
            sync. Analytics will become available once data starts flowing from your monitoring
            system.
          </p>
          <div className="mx-auto mb-8 grid max-w-lg grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-paper p-3">
              <div className="text-xs text-ink-3">Status</div>
              <div className="text-sm font-semibold text-blue-600">Syncing</div>
            </div>
            <div className="rounded-lg bg-paper p-3">
              <div className="text-xs text-ink-3">Connection</div>
              <div className="text-sm font-semibold text-signal-positive">Active</div>
            </div>
            <div className="rounded-lg bg-paper p-3">
              <div className="text-xs text-ink-3">Data Points</div>
              <div className="text-sm font-semibold text-ink-3">Pending</div>
            </div>
          </div>
          <a
            href={homeHrefFor(prefix)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Portfolio
          </a>
        </div>
      </div>
    );
  }

  // Hydrogen plants: electrolyzer console inside the ops shell (H2 rail).
  if (assetType === 'HYDROGEN') {
    const t = getPlantTelemetry(plantId);
    return (
      <OpsShell
        plantId={plantId}
        activeNavKey="overview"
        commandBar={{
          section: 'OVERVIEW',
          sectionTone: 'info',
          plantLabel: (apiPlant?.name ?? plantId).toUpperCase(),
          assetChip: 'H2',
          conn: t.conn,
          pollSeconds: t.poll_seconds,
          userInitials: 'AM',
        }}
      >
        <div className="ops-legacy">
          <HydrogenSection plantId={plantId} />
        </div>
      </OpsShell>
    );
  }

  // Wind plants get the same ops chrome as every other asset: command bar
  // with the WIND chip + the asset-aware nav rail (OpsShell resolves it from
  // asset_type), with the wind console retoned inside the shell.
  if (assetType === 'WIND') {
    const t = getPlantTelemetry(plantId);
    return (
      <OpsShell
        plantId={plantId}
        activeNavKey="overview"
        commandBar={{
          section: 'OVERVIEW',
          sectionTone: 'info',
          plantLabel: (apiPlant?.name ?? plantId).toUpperCase(),
          assetChip: 'WIND',
          conn: t.conn,
          pollSeconds: t.poll_seconds,
          userInitials: 'AM',
        }}
      >
        <div className="ops-legacy">
          <WindSection plantId={plantId} />
        </div>
        <GuidedTour steps={PLANT_TOUR_STEPS} isOpen={showTour} onClose={() => setShowTour(false)} />
      </OpsShell>
    );
  }

  // PV, BESS and PV+BESS all land on the ops-console overview. The BESS
  // module hides itself for pure-PV plants. For the demo every solar plant
  // is treated as PV+BESS so the dispatch + BESS.live blocks render, real
  // production data would gate this on `apiPlant.has_bess` or similar.
  const assetChip: 'PV' | 'BESS' | 'PV+BESS' =
    assetType === 'BESS' ? 'BESS' : 'PV+BESS';
  const opsAsset: 'PV' | 'BESS' | 'PV+BESS' | 'WIND' = assetChip;
  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();
  const capacityMW = apiPlant?.capacity_mw ? Number(apiPlant.capacity_mw) : 30;

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="overview"
      commandBar={(() => {
        const t = getPlantTelemetry(plantId);
        return {
          section: 'OVERVIEW',
          sectionTone: 'info',
          plantLabel,
          assetChip,
          conn: t.conn,
          pollSeconds: t.poll_seconds,
          userInitials: 'AM',
        };
      })()}
    >
      <OpsOverview
        plantId={plantId}
        plantName={apiPlant?.name ?? plantId}
        assetType={opsAsset}
        capacityMW={capacityMW}
      />
      <GuidedTour steps={PLANT_TOUR_STEPS} isOpen={showTour} onClose={() => setShowTour(false)} />
    </OpsShell>
  );
}
