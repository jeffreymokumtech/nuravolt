'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Activity,
  Database,
  GitBranch,
  LayoutDashboard,
  Link2,
  Map,
  RefreshCw,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import type {
  SpatialUniformityData,
  IrradianceComparisonData,
  DataSourceCorrelationData,
} from '@/types/soiling';

import { OverviewTab, IrradianceTab, QUALITY_COLORS, QUALITY_TONES, QUALITY_MONO } from './quality';
import TodayTab from './quality/TodayTab';
import QualitySkeleton from './quality/QualitySkeleton';
import SpatialUniformityChart from './SpatialUniformityChart';
import DataSourceCorrelationCard from './DataSourceCorrelationCard';
import { useQualityToday } from '@/hooks/useQualityToday';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

// Provenance + connections are folded into the hub as tabs (one data-quality
// menu). Both are heavyweight, self-contained panels — load them on demand.
const DataLineagePanel = dynamic(() => import('@/components/data-hub/DataLineagePanel'), {
  loading: () => <QualitySkeleton title="Loading data lineage…" />,
  ssr: false,
});
const ConnectionsManager = dynamic(() => import('@/components/data-hub/ConnectionsManager'), {
  loading: () => <QualitySkeleton title="Loading connections…" />,
  ssr: false,
});

interface DataQualitySectionProps {
  plantId: string;
}

const SOURCE_LABELS: Record<string, string> = {
  auto: 'Auto',
  onsite: 'On-site sensor',
  open_meteo: 'Open-Meteo satellite',
  dustiq: 'DustIQ sensor',
  inferred: 'Inferred per-inverter',
};

/**
 * Read-only strip showing the plant's chosen irradiance source and soiling
 * reference, deep-linking to the picker (plant Settings → Data sources).
 * Dashboard-only: demo/showcase have no settings surface.
 */
function SourceChoiceChip({ plantId }: { plantId: string }) {
  const [selected, setSelected] = useState<{
    irradianceSource: string;
    soilingReference: string;
  } | null>(null);

  useEffect(() => {
    fetch(`/api/plants/${plantId}/source-candidates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.selected && setSelected(d.selected))
      .catch(() => {});
  }, [plantId]);

  if (!selected) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{
        background: QUALITY_TONES.info.bg,
        borderColor: QUALITY_TONES.info.border,
        color: QUALITY_TONES.info.fg,
      }}
    >
      <span>
        Irradiance source: <strong>{SOURCE_LABELS[selected.irradianceSource] ?? selected.irradianceSource}</strong>
        {' · '}
        Soiling reference: <strong>{SOURCE_LABELS[selected.soilingReference] ?? selected.soilingReference}</strong>
      </span>
      <Link
        href={`/dashboard/plant/${plantId}/settings?tab=data-sources`}
        className="font-medium hover:underline"
      >
        Configure →
      </Link>
    </div>
  );
}

/**
 * The Data Quality hub: one tab strip over every data-quality surface.
 * Summary (executive roll-up) lands first; Today is the operator's daily
 * snapshot; Spatial / Irradiance / Correlation are the sensor-analytics
 * views; Provenance and Connections complete the single data menu.
 */
type QualityTab =
  | 'summary'
  | 'today'
  | 'spatial'
  | 'irradiance'
  | 'correlation'
  | 'provenance'
  | 'connections';

const TABS: Array<{ id: QualityTab; label: string; icon: LucideIcon }> = [
  { id: 'summary', label: 'Summary', icon: LayoutDashboard },
  { id: 'today', label: 'Today', icon: Activity },
  { id: 'spatial', label: 'Spatial', icon: Map },
  { id: 'irradiance', label: 'Irradiance', icon: Sun },
  { id: 'correlation', label: 'Correlation', icon: Link2 },
  { id: 'provenance', label: 'Provenance', icon: GitBranch },
  { id: 'connections', label: 'Connections', icon: Database },
];

/** Allowed ?qualityTab= values. `overview` is the legacy deep-link name for
 *  the summary view — kept as an alias so old links keep resolving. */
const TAB_ALIASES: Record<string, QualityTab> = {
  overview: 'summary',
};
const ALLOWED_TAB_PARAMS: ReadonlyArray<string> = [
  ...TABS.map((t) => t.id),
  ...Object.keys(TAB_ALIASES),
];

function formatSnapshotAge(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMin = Math.floor((Date.now() - t) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function DataQualitySection({ plantId }: DataQualitySectionProps) {
  const searchParams = useSearchParams();
  const prefix = usePlantRoutePrefix();

  const [activeTab, setActiveTab] = useState<QualityTab>('summary');

  // Sync activeTab from URL params on mount and when searchParams change
  useEffect(() => {
    const tabParam = searchParams.get('qualityTab');
    if (tabParam && ALLOWED_TAB_PARAMS.includes(tabParam)) {
      setActiveTab(TAB_ALIASES[tabParam] ?? (tabParam as QualityTab));
    }
  }, [searchParams]);

  // Snapshot provenance for the hub header (shared fetch with the tabs and
  // the command-bar DQ chip — one request for the whole page).
  const { data: today, isLoading: todayLoading, refresh } = useQualityToday(plantId);
  const [refreshing, setRefreshing] = useState(false);

  // Data states
  const [spatialData, setSpatialData] = useState<SpatialUniformityData | null>(null);
  const [irradianceData, setIrradianceData] = useState<IrradianceComparisonData | null>(null);
  const [correlationData, setCorrelationData] = useState<DataSourceCorrelationData | null>(null);

  // Loading states
  const [isLoadingSpatial, setIsLoadingSpatial] = useState(true);
  const [isLoadingIrradiance, setIsLoadingIrradiance] = useState(true);
  const [isLoadingCorrelation, setIsLoadingCorrelation] = useState(true);

  // Fetch the three analytics payloads on mount
  useEffect(() => {
    const fetchData = async () => {
      // Fetch Spatial Uniformity
      try {
        setIsLoadingSpatial(true);
        const res = await fetch(`/api/soiling/plants/${plantId}/quality/spatial`);
        if (res.ok) {
          const data = await res.json();
          setSpatialData(data);
        }
      } catch (err) {
        console.error('Error loading spatial data:', err);
      } finally {
        setIsLoadingSpatial(false);
      }

      // Fetch Irradiance Comparison
      try {
        setIsLoadingIrradiance(true);
        const res = await fetch(`/api/soiling/plants/${plantId}/quality/irradiance`);
        if (res.ok) {
          const data = await res.json();
          setIrradianceData(data);
        }
      } catch (err) {
        console.error('Error loading irradiance data:', err);
      } finally {
        setIsLoadingIrradiance(false);
      }

      // Fetch Correlation Analysis
      try {
        setIsLoadingCorrelation(true);
        const res = await fetch(`/api/soiling/plants/${plantId}/quality/correlation`);
        if (res.ok) {
          const data = await res.json();
          setCorrelationData(data);
        }
      } catch (err) {
        console.error('Error loading correlation data:', err);
      } finally {
        setIsLoadingCorrelation(false);
      }
    };

    fetchData();
  }, [plantId]);

  const isLoading = isLoadingSpatial || isLoadingIrradiance || isLoadingCorrelation;

  // Handle tab change and update URL
  const handleTabChange = (tab: QualityTab) => {
    setActiveTab(tab);

    // Update URL with new tab parameter while preserving hash
    const currentHash = window.location.hash;
    const params = new URLSearchParams(searchParams.toString());
    params.set('qualityTab', tab);

    // Use window.history to update URL without triggering navigation
    const newUrl = `${window.location.pathname}${currentHash}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const snapshotAge = formatSnapshotAge(today?.generated_at);
  const isFixture = today?._source === 'fixture';

  return (
    <div className="space-y-5">
      {/* Hub header: tab strip left, snapshot provenance + refresh right */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap gap-1 rounded-lg p-1"
          style={{ backgroundColor: QUALITY_COLORS.background.section }}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;

            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`
                  flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium
                  transition-all duration-200
                  ${isActive ? 'shadow-sm' : 'hover:bg-white/50'}
                `}
                style={{
                  backgroundColor: isActive ? 'white' : 'transparent',
                  color: isActive ? QUALITY_COLORS.primary.DEFAULT : QUALITY_COLORS.text.secondary,
                }}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {isFixture && (
            <span
              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: QUALITY_TONES.warn.fg,
                background: QUALITY_TONES.warn.bg,
                borderColor: QUALITY_TONES.warn.border,
              }}
            >
              demo fixture
            </span>
          )}
          {snapshotAge && (
            <span
              className="text-[11px]"
              style={{ fontFamily: QUALITY_MONO, color: QUALITY_COLORS.text.secondary }}
              title={today?.generated_at ? `Snapshot generated ${today.generated_at} (UTC)` : undefined}
            >
              snapshot {snapshotAge}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing || todayLoading}
            className="inline-flex items-center gap-1.5 rounded-md border bg-white px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-gray-50 disabled:opacity-50"
            style={{
              borderColor: QUALITY_COLORS.border.DEFAULT,
              color: QUALITY_COLORS.text.primary,
            }}
            title="Refresh the data-quality snapshot"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="min-h-[400px]">
        {activeTab === 'summary' && (
          <OverviewTab
            plantId={plantId}
            spatialData={spatialData}
            irradianceData={irradianceData}
            correlationData={correlationData}
            isLoading={isLoading}
          />
        )}

        {activeTab === 'today' && <TodayTab plantId={plantId} />}

        {activeTab === 'spatial' && (
          <SpatialUniformityChart data={spatialData} isLoading={isLoadingSpatial} />
        )}

        {activeTab === 'irradiance' && (
          <IrradianceTab data={irradianceData} isLoading={isLoadingIrradiance} />
        )}

        {activeTab === 'correlation' && (
          <DataSourceCorrelationCard data={correlationData} isLoading={isLoadingCorrelation} />
        )}

        {activeTab === 'provenance' && (
          <div className="space-y-3">
            {prefix === '/dashboard' && <SourceChoiceChip plantId={plantId} />}
            <DataLineagePanel plantId={plantId} />
          </div>
        )}

        {activeTab === 'connections' && (
          <div className="space-y-3">
            {prefix === '/dashboard' && (
              <div className="flex justify-end">
                <Link
                  href="/dashboard/settings/connections"
                  className="text-[11px] font-medium hover:underline"
                  style={{ color: QUALITY_COLORS.primary.DEFAULT }}
                >
                  Manage all connections →
                </Link>
              </div>
            )}
            <ConnectionsManager hideHeader plantSlug={plantId} />
          </div>
        )}
      </div>
    </div>
  );
}
