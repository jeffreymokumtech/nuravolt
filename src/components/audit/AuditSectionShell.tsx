'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Battery } from 'lucide-react';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import PlantPageChrome from '@/components/demo/PlantPageChrome';
import OpsShell from '@/components/ops/OpsShell';

/**
 * Shared wrapper for the Audit product pages (`/plant/[plantId]/audit/*`).
 *
 * Chrome ownership: the plant layouts are chrome-free (each page provides
 * its own shell), so this shell mounts it. On /demo and /dashboard the
 * audit surface lives in the ops console (rail entry "Audit" on battery
 * assets). /showcase keeps PlantPageChrome — it is the sales-specimen
 * surface with its own header (Book a call, Anonymize) and stays visually
 * separate on purpose.
 *
 * The Audit surface exists for BESS and hybrid (PV+BESS) assets; any other
 * asset type gets a graceful "not applicable" card.
 */
export default function AuditSectionShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants, loading } = useDemoPlants();
  const prefix = usePlantRoutePrefix();

  usePageContext({ plantId });

  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const chip = apiPlant ? assetTypeChip(apiPlant.asset_type) : null;
  const supportsAudit = chip === 'BESS' || chip === 'PV+BESS';

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

    if (apiPlant && !supportsAudit) {
      return (
        <div className="mx-auto max-w-2xl py-12">
          <div className="rounded-xl border border-divider bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-violet-50">
              <Battery className="h-7 w-7 text-violet-600" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-ink">
              Audit is available for BESS assets
            </h2>
            <p className="mx-auto mb-6 max-w-md text-ink-2">
              The NuraVolt Audit surface covers battery storage and hybrid PV+BESS assets:
              optimizer performance, warranty and degradation evidence, and grid code
              compliance packs. {apiPlant.name} has no battery asset attached.
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

  if (prefix === '/showcase') {
    return (
      <PlantPageChrome routePrefix="/showcase" modeLabel="Showcase" renderHeader={false}>
        {inner}
      </PlantPageChrome>
    );
  }

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="audit"
      commandBar={{
        section: 'AUDIT',
        sectionTone: 'bess',
        plantLabel: (apiPlant?.name ?? plantId).toUpperCase(),
        assetChip: chip ?? 'PV+BESS',
        conn: 'ok',
        latencyMs: 42,
        pollSeconds: 2,
        dataQualityPct: 99.1,
        userInitials: 'AM',
      }}
    >
      <div className="ops-legacy">{inner}</div>
    </OpsShell>
  );
}
