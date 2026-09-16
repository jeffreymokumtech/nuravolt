'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Battery, Wind, ArrowLeft } from 'lucide-react';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import PlantPageChrome from '@/components/demo/PlantPageChrome';

type AssetType = 'SOLAR' | 'WIND' | 'BESS';

interface Props {
  children: React.ReactNode;
  /**
   * Asset types this section applies to. When the current plant's type isn't
   * in the list, a graceful "not applicable" card renders instead of the
   * section (same pattern as HybridCockpit's no_pv fallback).
   */
  allowed?: AssetType[];
  /** Human label used in the not-applicable message, e.g. "Soiling intelligence". */
  sectionLabel?: string;
}

/**
 * Shared wrapper for the route-based plant section pages. Owns the loading
 * state, the plant lookup, the Copilot page-context publication, and the
 * asset-type guard, so each section route stays a 10-line thin wrapper.
 */
export default function SectionPageShell({
  children,
  allowed = ['SOLAR', 'WIND', 'BESS'],
  sectionLabel = 'This section',
}: Props) {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants, loading } = useDemoPlants();
  const prefix = usePlantRoutePrefix();

  usePageContext({ plantId });

  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const assetType: AssetType =
    apiPlant?.asset_type === 'PV' ? 'SOLAR' : ((apiPlant?.asset_type as AssetType) ?? 'SOLAR');

  // SectionPageShell still owns the legacy PlantPageChrome since the layout
  // moved out of the wrapping business when ops chrome landed. Migrated
  // section pages (overview, bess, soiling, etc.) skip SectionPageShell
  // entirely and provide their own <OpsShell>.
  const inner = (() => {
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

    if (apiPlant && !allowed.includes(assetType)) {
      const Icon = assetType === 'BESS' ? Battery : Wind;
      const assetLabel = assetType === 'BESS' ? 'battery storage' : 'wind';
      return (
        <div className="mx-auto max-w-2xl py-12">
          <div className="rounded-xl border border-divider bg-white p-8 text-center shadow-sm">
            <div
              className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
                assetType === 'BESS' ? 'bg-violet-50' : 'bg-cyan-50'
              }`}
            >
              <Icon className={`h-7 w-7 ${assetType === 'BESS' ? 'text-violet-600' : 'text-cyan-600'}`} />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-ink">
              {sectionLabel} is not applicable here
            </h2>
            <p className="mx-auto mb-6 max-w-md text-ink-2">
              {apiPlant.name} is a {assetLabel} plant, head back to the plant
              overview for the {assetType === 'BESS' ? 'warranty, cycling and dispatch' : 'turbine'} dashboard.
            </p>
            <Link
              href={`${prefix}/plant/${plantId}`}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to {apiPlant.name}
            </Link>
          </div>
        </div>
      );
    }

    return <div className="space-y-4 md:space-y-6">{children}</div>;
  })();

  // Surface-aware chrome: the showcase root layout already renders a top
  // header (ShowcaseHeader), so skip PlantPageChrome's own header there.
  if (prefix === '/showcase') {
    return (
      <PlantPageChrome routePrefix="/showcase" modeLabel="Showcase" renderHeader={false}>
        {inner}
      </PlantPageChrome>
    );
  }

  return (
    <PlantPageChrome routePrefix="/demo" modeLabel="Demo Mode">
      {inner}
    </PlantPageChrome>
  );
}
