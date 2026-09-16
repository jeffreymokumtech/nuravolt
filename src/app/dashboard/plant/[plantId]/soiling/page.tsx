'use client';

/**
 * Soiling intelligence for the authenticated app — the full 4-tab console
 * (Overview / Data explorer / Zone analysis / Cleaning optimiser), matching the
 * demo, but every tab on live/DB data. Overview reads the org-scoped soiling
 * APIs; Zone analysis + Cleaning optimiser reuse the demo sub-components (which
 * call live routes; digital-twin/zones are DB-first). Data explorer's
 * multi-source history is synthesized per plant (AnalysisArtifact) and shows a
 * "connect a source" state until those streams land.
 */

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import OpsTabs from '@/components/ops/OpsTabs';
import SrForecastChart, { type SrForecastPoint } from '@/components/ops/charts/SrForecastChart';
import OpsSparkline from '@/components/ops/charts/OpsSparkline';
import KPIReadout from '@/components/ui/KPIReadout';
import Abbr from '@/components/ui/AbbrTooltip';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import type { CommandBarMeta } from '@/components/ops/OpsCommandBar';
import UpgradeGate from '@/components/billing/UpgradeGate';

const ZoneAnalysisTab = dynamic(
  () => import('@/components/soiling/ZoneAnalysisTab').then((m) => m.ZoneAnalysisTab),
  { ssr: false, loading: () => <TabLoading /> },
);
const CleaningOptimizerTab = dynamic(() => import('@/components/soiling/CleaningOptimizerTab'), {
  ssr: false,
  loading: () => <TabLoading />,
});
const DataExplorerChart = dynamic(
  () => import('@/components/soiling/DataExplorerChart').then((m) => m.DataExplorerChart),
  { ssr: false, loading: () => <TabLoading /> },
);

function TabLoading() {
  return (
    <div className="flex h-40 items-center justify-center font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
      loading…
    </div>
  );
}

interface InverterRank {
  externalId: string;
  currentSR: number | null;
  trend30d: number[];
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type TabKey = 'overview' | 'explorer' | 'zones' | 'cleaning';

export default function DashboardSoilingPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [summary, setSummary] = useState<any>(null);
  const [forecast, setForecast] = useState<SrForecastPoint[]>([]);
  // Stream exclusions the operator registered but which this precomputed
  // rollup cannot apply — surfaced honestly rather than silently ignored.
  const [exclusionsRegistered, setExclusionsRegistered] = useState(0);
  const [ranking, setRanking] = useState<InverterRank[]>([]);
  const [loadingRanks, setLoadingRanks] = useState(true);
  // Whether the ranking covers the whole fleet (sr-estimate available) or
  // only a registry sample — the panel label must not overclaim.
  const [rankedFleetWide, setRankedFleetWide] = useState(false);
  const [streamsAvailable, setStreamsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!plantId) return;
    getJSON<any>(`/api/soiling/plants/${plantId}/summary`).then(setSummary);
    getJSON<any>(`/api/soiling/plants/${plantId}/forecast?days=90`).then((d) => {
      const pts = (d?.forecasts ?? [])
        .map((f: any) => ({ date: f.date, predicted: f.soilingRatio, lower: f.lowerBound, upper: f.upperBound }))
        .filter((p: SrForecastPoint) => typeof p.predicted === 'number');
      setForecast(pts);
      setExclusionsRegistered(
        typeof d?.excluded_streams_registered === 'number' ? d.excluded_streams_registered : 0
      );
    });
    // Multi-source history artifact presence drives the Data explorer tab.
    getJSON<any>(`/api/soiling/plants/${plantId}/streams`).then((d) => setStreamsAvailable(!!d?.available));

    (async () => {
      setLoadingRanks(true);
      // Rank the WHOLE fleet via the per-inverter SR estimate endpoint, then
      // pull 30-day trends for only the bottom 16 — "dirtiest first" must
      // mean dirtiest of the fleet, not of an arbitrary first-16 sample.
      const est = await getJSON<any>(`/api/soiling/plants/${plantId}/inverters/sr-estimate`);
      const estimated: Array<{ id: string; sr: number }> = est?.inverters
        ? Object.entries(est.inverters as Record<string, any>)
            .map(([id, v]) => ({ id, sr: v?.currentSR ?? v?.current_sr }))
            .filter((r) => typeof r.sr === 'number')
        : [];

      let candidateIds: string[];
      let rankedFullFleet = false;
      if (estimated.length > 0) {
        rankedFullFleet = true;
        candidateIds = estimated
          .sort((a, b) => a.sr - b.sr)
          .slice(0, 16)
          .map((r) => r.id);
      } else {
        // No per-inverter estimate for this plant: fall back to a SAMPLE of
        // the registry (labelled as such in the panel).
        const plant = await getJSON<any>(`/api/plants/${plantId}`);
        candidateIds = ((plant?.data?.inverter_groups ?? plant?.inverter_groups ?? []) as any[])
          .flatMap((g: any) => g.inverters ?? [])
          .slice(0, 16)
          .map((inv: any) => inv.external_id);
      }
      setRankedFleetWide(rankedFullFleet);

      const ranks: InverterRank[] = await Promise.all(
        candidateIds.map(async (externalId) => {
          const h = await getJSON<any>(
            `/api/soiling/plants/${plantId}/history?inverterId=${encodeURIComponent(externalId)}&days=30`,
          );
          const series: number[] = (h?.history ?? h?.data ?? [])
            .map((r: any) => r.soiling_ratio ?? r.soilingRatio ?? r.value)
            .filter((v: any) => typeof v === 'number');
          const estimateSr = estimated.find((e) => e.id === externalId)?.sr ?? null;
          return {
            externalId,
            currentSR: series.length ? series[series.length - 1] : estimateSr,
            trend30d: series,
          };
        }),
      );
      setRanking(ranks.filter((r) => r.currentSR != null).sort((a, b) => (a.currentSR ?? 1) - (b.currentSR ?? 1)));
      setLoadingRanks(false);
    })();
  }, [plantId]);

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();
  const chip: CommandBarMeta['assetChip'] = apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV';
  const status = summary?.currentStatus;
  const econ = summary?.economicImpact;

  const cleaningIndex = useMemo(() => {
    if (!econ?.nextCleaningRecommended || !forecast.length) return null;
    const idx = forecast.findIndex((p) => p.date >= econ.nextCleaningRecommended);
    return idx >= 0 ? idx : null;
  }, [econ, forecast]);

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="soiling"
      commandBar={{ section: 'SOILING', sectionTone: 'warn', plantLabel, assetChip: chip, conn: 'ok', pollSeconds: 900, userInitials: 'OP' }}
    >
      <div className="space-y-3">
        {/* Always-visible headline KPIs */}
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <OpsPanel>
            <KPIReadout
              label={<>Fleet <Abbr term="SR">soiling ratio</Abbr></>}
              value={status?.avgSoilingRatio != null ? status.avgSoilingRatio.toFixed(3) : '–'}
              signal={status?.avgSoilingRatio < 0.93 ? 'warning' : undefined}
            />
          </OpsPanel>
          <OpsPanel>
            <KPIReadout label="Estimated loss" value={status?.estimatedLossPct != null ? `${status.estimatedLossPct.toFixed(1)}%` : '–'} signal={status?.estimatedLossPct > 6 ? 'warning' : undefined} />
          </OpsPanel>
          <OpsPanel>
            <KPIReadout label="Next cleaning" value={econ?.nextCleaningRecommended ?? '–'} />
          </OpsPanel>
          <OpsPanel>
            <KPIReadout label="Cleaning net benefit" value={econ?.expectedNetBenefit_EUR ? `€${Math.round(econ.expectedNetBenefit_EUR).toLocaleString()}` : '–'} signal={econ?.expectedNetBenefit_EUR > 0 ? 'positive' : undefined} />
          </OpsPanel>
        </div>

        <OpsTabs
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'explorer', label: 'Data explorer' },
            { key: 'zones', label: 'Zone analysis' },
            { key: 'cleaning', label: 'Cleaning optimiser', statusTone: 'info' },
          ]}
          value={activeTab}
          onChange={(k) => setActiveTab(k as TabKey)}
          syncToUrl
        />

        {activeTab === 'overview' && (
          <>
            <OpsPanel
              label="Soiling forecast · next 90 days"
              subtitle="Predicted soiling ratio with confidence bounds. Provisional (climate transfer) until plant-trained models take over."
              meta={
                <span className="flex items-center gap-3">
                  {exclusionsRegistered > 0 && (
                    <span
                      style={{ color: 'var(--ops-warn)' }}
                      title="This forecast aggregates per-date precomputed SR, not per-stream raw data — registered stream exclusions cannot be applied to it yet."
                    >
                      {exclusionsRegistered} exclusion{exclusionsRegistered > 1 ? 's' : ''} registered · not applied to this rollup
                    </span>
                  )}
                  {summary?._source === 'database' && <span style={{ color: 'var(--ops-muted)' }}>live</span>}
                </span>
              }
            >
              {forecast.length ? (
                <SrForecastChart
                  points={forecast}
                  cleaningWindowIndex={cleaningIndex}
                  cleaningWindowLabel={econ?.nextCleaningRecommended ? `clean rec · ${econ.nextCleaningRecommended}` : undefined}
                  yRange={[Math.min(0.9, ...forecast.map((p) => p.lower)) - 0.01, 1.0]}
                  height={240}
                />
              ) : (
                <p className="py-8 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>Forecast appears after onboarding analytics complete.</p>
              )}
            </OpsPanel>

            <OpsPanel
              label="Per-inverter soiling · latest classification"
              subtitle={
                rankedFleetWide
                  ? 'Bottom 16 of the fleet by current SR, dirtiest first, 30-day trend'
                  : `Sample of ${ranking.length || 16} registered inverters (fleet-wide ranking needs per-inverter SR estimates), 30-day trend`
              }
              flush
            >
              {loadingRanks ? (
                <p className="py-8 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>Loading inverters…</p>
              ) : ranking.length ? (
                <table className="w-full font-mono text-[12px]">
                  <thead>
                    <tr style={{ color: 'var(--ops-label)' }}>
                      <th className="px-4 py-2 text-left font-normal">INVERTER</th>
                      <th className="px-4 py-2 text-left font-normal">SR</th>
                      <th className="px-4 py-2 text-left font-normal">LOSS</th>
                      <th className="px-4 py-2 text-left font-normal">30D TREND</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((r) => {
                      const sr = r.currentSR ?? 1;
                      const tone = sr < 0.9 ? 'var(--ops-bad)' : sr < 0.95 ? 'var(--ops-warn)' : 'var(--ops-ok)';
                      return (
                        <tr key={r.externalId} className="border-t" style={{ borderColor: 'var(--ops-hair)', color: 'var(--ops-txt)' }}>
                          <td className="px-4 py-2">{r.externalId}</td>
                          <td className="px-4 py-2" style={{ color: tone }}>{sr.toFixed(3)}</td>
                          <td className="px-4 py-2">{((1 - sr) * 100).toFixed(1)}%</td>
                          <td className="px-4 py-2"><OpsSparkline values={r.trend30d} height={26} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="py-8 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>Per-inverter history appears once telemetry accrues.</p>
              )}
            </OpsPanel>
          </>
        )}

        {activeTab === 'explorer' && (
          <OpsPanel label="Data explorer · history" meta={<span>precipitation · dust · SR · soiling rate · PR</span>} bodyClassName="ops-legacy">
            {streamsAvailable ? (
              <DataExplorerChart plantId={plantId} />
            ) : (
              <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
                <span style={{ color: 'var(--ops-txt)' }}>Multi-source history is not connected for this plant yet.</span>
                <span>
                  Precipitation and soiling-ratio series come from the plant&apos;s own data; dust, aerosol (AOD) and DustIQ
                  reference streams populate once a reference sensor or aerosol feed is connected. Provisional synthesized
                  streams are generated for onboarded demo plants.
                </span>
              </div>
            )}
          </OpsPanel>
        )}

        {activeTab === 'zones' && (
          <OpsPanel label="Zone analysis" bodyClassName="ops-legacy">
            <UpgradeGate
              feature="analytics:per_inverter_soiling"
              title="Per-inverter soiling is a Business feature"
              blurb="Zone analysis ranks every inverter's soiling ratio so cleaning crews go where the loss is."
            >
              <ZoneAnalysisTab plantId={plantId} />
            </UpgradeGate>
          </OpsPanel>
        )}

        {activeTab === 'cleaning' && (
          <OpsPanel label="Cleaning optimiser" meta={<span style={{ color: 'var(--ops-info)' }}>click trajectory to schedule · run optimiser</span>} bodyClassName="ops-legacy">
            <UpgradeGate
              feature="analytics:cleaning_optimizer"
              title="The cleaning optimizer is a Business feature"
              blurb="ROI-optimized cleaning schedules from your soiling forecast, tariffs and cleaning costs."
            >
              <CleaningOptimizerTab plantId={plantId} />
            </UpgradeGate>
          </OpsPanel>
        )}
      </div>
    </OpsShell>
  );
}
