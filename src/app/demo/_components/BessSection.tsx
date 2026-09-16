'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import useBESSData from '@/hooks/useBESSData';
import WarrantyHealthCard from '@/components/bess/WarrantyHealthCard';
import WarrantyTermsCard from '@/components/bess/WarrantyTermsCard';
import WarrantyViolationsTable from '@/components/bess/WarrantyViolationsTable';
import SoHHistoryChart from '@/components/bess/SoHHistoryChart';
import CyclingMetricsCard from '@/components/bess/CyclingMetricsCard';
import DispatchScheduleChart from '@/components/bess/DispatchScheduleChart';
import RteTrendChart from '@/components/bess/RteTrendChart';
import DispatchPnlCard from '@/components/bess/DispatchPnlCard';
import {
  LayoutDashboard,
  ShieldCheck,
  Repeat,
  Calendar,
  AlertTriangle,
  Battery,
  ChevronRight
} from 'lucide-react';
import {
  CHEMISTRY_NAMES,
  formatSoH,
  formatSoC,
  formatPower,
  formatEnergy,
  getRiskLevelColor,
} from '@/types/bess';

type BessTab = 'overview' | 'warranty' | 'cycling' | 'dispatch';

export default function BessSection() {
  const params = useParams();
  const plantId = params.plantId as string;
  const [activeTab, setActiveTab] = useState<BessTab>('overview');

  const {
    assets,
    selectedAsset,
    assetOverview,
    warrantyStatus,
    cyclingMetrics,
    dispatchSchedule,
    violations,
    isLoading,
    error,
  } = useBESSData(plantId);

  const tabs = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'warranty', label: 'Warranty', icon: ShieldCheck },
    { id: 'cycling', label: 'Cycling', icon: Repeat },
    { id: 'dispatch', label: 'Dispatch', icon: Calendar },
  ] as const;

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-divider p-8">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-ink mb-2">BESS Data Unavailable</h2>
          <p className="text-ink-2 mb-4">
            {error.message || 'Failed to load BESS data for this plant.'}
          </p>
          <p className="text-sm text-ink-3">
            This plant may not have BESS assets configured, or the data is still being processed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
              <Battery className="w-7 h-7 text-blue-600" />
              Battery Energy Storage
            </h1>
            <p className="text-sm text-ink-2 mt-1">
              Warranty tracking, cycling analysis, and dispatch optimization
            </p>
          </div>

          {/* Asset selector (if multiple assets) */}
          {assets && assets.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">Asset:</span>
              <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all">
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name || asset.id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Asset Info Card */}
        {selectedAsset && (
          <div className="mt-6 p-4 bg-paper rounded-lg border border-divider">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-9 gap-6">
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Chemistry</p>
                <p className="text-sm font-semibold text-ink">
                  {CHEMISTRY_NAMES[selectedAsset.chemistry] || selectedAsset.chemistry}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Capacity</p>
                <p className="text-sm font-semibold text-ink">
                  {formatEnergy(selectedAsset.nominalCapacityKwh)}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Power</p>
                <p className="text-sm font-semibold text-ink">
                  {formatPower(selectedAsset.nominalPowerKw)}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Manufacturer</p>
                <p className="text-sm font-semibold text-ink">
                  {selectedAsset.manufacturer || '-'}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Model</p>
                <p className="text-sm font-semibold text-ink">
                  {selectedAsset.model || '-'}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Installed</p>
                <p className="text-sm font-semibold text-ink">
                  {selectedAsset.installationDate || '-'}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Current SoH</p>
                <p className="text-sm font-bold text-blue-600">
                  {selectedAsset.currentSoh
                    ? formatSoH(selectedAsset.currentSoh)
                    : '-'}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-ink-3 uppercase tracking-widest mb-1">Current SoC</p>
                <p className="text-sm font-bold text-green-600">
                  {selectedAsset.currentSoc
                    ? formatSoC(selectedAsset.currentSoc)
                    : '-'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-divider p-1">
        <div className="flex flex-wrap gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 min-w-[120px] flex items-center justify-center px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-ink-2 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4 mr-2" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard
              label="SoH"
              value={assetOverview?.warrantyStatus?.currentSoh}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              color="#3B82F6"
              loading={isLoading}
            />
            <KPICard
              label="Cycle Count"
              value={assetOverview?.warrantyStatus?.equivalentFullCycles}
              format={(v) => v.toFixed(0)}
              color="#8B5CF6"
              loading={isLoading}
            />
            <KPICard
              label="Throughput"
              value={assetOverview?.warrantyStatus?.totalThroughputMwh}
              format={(v) => `${v.toFixed(1)} MWh`}
              color="#10B981"
              loading={isLoading}
            />
            <KPICard
              label="Warranty Health"
              value={assetOverview?.warrantyStatus?.warrantyHealthScore}
              format={(v) => `${v.toFixed(0)}/100`}
              color={
                assetOverview?.warrantyStatus?.riskLevel
                  ? getRiskLevelColor(assetOverview.warrantyStatus.riskLevel)
                  : '#6B7280'
              }
              loading={isLoading}
            />
          </div>

          {/* SoH Chart */}
          <SoHHistoryChart
            data={cyclingMetrics?.sohHistory || []}
            capacityTests={cyclingMetrics?.capacityTests}
            warrantyThreshold={warrantyStatus?.status?.warrantyThreshold}
            installationDate={selectedAsset?.installationDate}
            warrantyYears={warrantyStatus?.terms?.warrantyYears}
            capacityGuaranteePct={warrantyStatus?.terms?.capacityGuaranteePct}
            loading={isLoading}
            height={350}
          />

          {/* Recent Violations */}
          {assetOverview?.recentViolations && assetOverview.recentViolations.length > 0 && (
            <WarrantyViolationsTable
              violations={assetOverview.recentViolations}
              loading={isLoading}
            />
          )}
        </div>
      )}

      {activeTab === 'warranty' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <WarrantyHealthCard
              healthScore={warrantyStatus?.healthScore || null}
              loading={isLoading}
            />
            <WarrantyTermsCard
              terms={warrantyStatus?.terms || null}
              loading={isLoading}
            />
          </div>
          <WarrantyViolationsTable
            violations={violations?.violations || []}
            loading={isLoading}
          />
        </div>
      )}

      {activeTab === 'cycling' && (
        <div className="space-y-6">
          <CyclingMetricsCard metrics={cyclingMetrics?.metrics || null} loading={isLoading} />

          {/* DoD Distribution */}
          {cyclingMetrics?.rainflowAnalysis && (
            <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
              <h3 className="text-lg font-semibold text-ink mb-4">
                Depth of Discharge Distribution
              </h3>
              <div className="grid grid-cols-5 gap-2">
                {cyclingMetrics.rainflowAnalysis.dodDistribution.map((bucket) => (
                  <div
                    key={bucket.dodRange}
                    className="text-center p-3 rounded-lg bg-paper border border-divider"
                  >
                    <p className="text-xs text-ink-3 mb-1">{bucket.dodRange}</p>
                    <p className="text-lg font-bold text-ink">{bucket.percentage}%</p>
                    <p className="text-xs text-ink-3">{bucket.count.toFixed(1)} cycles</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <SoHHistoryChart
            data={cyclingMetrics?.sohHistory || []}
            capacityTests={cyclingMetrics?.capacityTests}
            warrantyThreshold={warrantyStatus?.status?.warrantyThreshold}
            installationDate={selectedAsset?.installationDate}
            warrantyYears={warrantyStatus?.terms?.warrantyYears}
            capacityGuaranteePct={warrantyStatus?.terms?.capacityGuaranteePct}
            loading={isLoading}
            height={300}
          />

          {/* RTE trend — early-warning signal recorded per cycle but never charted */}
          {((cyclingMetrics as any)?.metrics?.dailyRecords?.length ?? 0) > 0 && (
            <RteTrendChart
              records={(cyclingMetrics as any).metrics.dailyRecords}
              minRte={warrantyStatus?.terms?.minRte}
            />
          )}
        </div>
      )}

      {activeTab === 'dispatch' && (
        <div className="space-y-6">
          {/* Revenue − wear = net: the optimizer's core tradeoff, now visible */}
          {dispatchSchedule?.summary && <DispatchPnlCard summary={dispatchSchedule.summary} />}

          <DispatchScheduleChart
            schedule={dispatchSchedule?.schedule || null}
            slots={dispatchSchedule?.slots || []}
            nominalCapacityKwh={selectedAsset?.nominalCapacityKwh}
            maxWarrantyCycles={warrantyStatus?.terms?.maxCycles}
            loading={isLoading}
            height={450}
          />

          {/* Arbitrage Opportunities */}
          {dispatchSchedule?.arbitrageOpportunities &&
            dispatchSchedule.arbitrageOpportunities.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
                <h3 className="text-lg font-semibold text-ink mb-4">
                  Arbitrage Opportunities
                </h3>
                <div className="space-y-3">
                  {dispatchSchedule.arbitrageOpportunities.map((opp, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-lg border border-green-200 bg-green-50"
                    >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <p className="font-medium text-ink">
                            Spread: {opp.spread} EUR/MWh
                          </p>
                          <p className="text-sm text-ink-2">
                            Charge @ {opp.chargeWindow.avgPriceEurMwh} EUR/MWh |{' '}
                            Discharge @ {opp.dischargeWindow.avgPriceEurMwh} EUR/MWh
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xl font-bold text-green-600">
                            +{opp.netRevenueEur.toFixed(2)} EUR
                          </p>
                          <p className="text-xs text-ink-3">
                            {opp.requiredCycles.toFixed(2)} cycles
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function KPICard({
  label,
  value,
  format,
  color,
  loading,
}: {
  label: string;
  value: number | null | undefined;
  format: (v: number) => string;
  color: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-divider p-4">
        <div className="animate-pulse">
          <div className="h-4 bg-divider rounded w-20 mb-2" />
          <div className="h-8 bg-divider rounded w-24" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-divider p-4">
      <p className="text-sm text-ink-3 mb-1">{label}</p>
      <p className="text-2xl font-bold" style={{ color }}>
        {value !== null && value !== undefined ? format(value) : '-'}
      </p>
    </div>
  );
}
