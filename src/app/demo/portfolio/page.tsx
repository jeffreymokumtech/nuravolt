'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import KpiCard from '@/components/ui/KpiCard';
import OpsDemoStrip from '@/components/demo/OpsDemoStrip';
import GuidedTour, { TourTrigger, DEMO_TOUR_STEPS } from '@/components/demo/GuidedTour';
import { formatCurrency, getRiskLevel, getRiskBadgeColor } from '@/utils/riskScoring';
import { useAnonymization } from '@/contexts/AnonymizationContext';
import AnonymizationToggle from '@/components/demo/AnonymizationToggle';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { useDataRoot } from '@/contexts/DataSourceContext';
import type { EnhancedPortfolioData, FinancialPlantData } from '@/types/portfolio';
import type { OnboardedPlant } from '@/types/onboarding';
import { Plus, CalendarClock, TrendingDown, Activity, ShieldAlert, Zap, ChevronRight, ArrowUpRight, Search, Sun, Wind, BatteryCharging, Gauge, Atom } from 'lucide-react';
import FleetCard from './_components/FleetCard';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/contexts/LanguageContext';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import ScheduledReportModal from '@/components/reports/ScheduledReportModal';
import ScheduledReportsList from '@/components/reports/ScheduledReportsList';
import ReportsCard from './_components/ReportsCard';

// Lazy load heavy components
const ConnectionWizard = dynamic(() => import('@/components/data-hub/ConnectionWizard'), {
  ssr: false,
});
const PortfolioLossChart = dynamic(() => import('./_components/PortfolioLossChart'), {
  loading: () => <div className="h-[380px] bg-paper-2 animate-pulse rounded-xl" />,
  ssr: false,
});

type TabId = 'ranking' | 'losses';

export default function PortfolioPage() {
  const router = useRouter();
  const [portfolio, setPortfolio] = useState<EnhancedPortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTour, setShowTour] = useState(false);
  const [onboardSuccess, setOnboardSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('ranking');
  const [sortColumn, setSortColumn] = useState<string>('risk');
  const [sortAsc, setSortAsc] = useState(false);
  const { anonName, anonLocation } = useAnonymization();
  const { customPlants, addPlant } = useDemoPlants();
  const { t } = useLanguage();
  const dataRoot = useDataRoot();
  const [showWizard, setShowWizard] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [editingReport, setEditingReport] = useState<any>(null);
  const [reportListKey, setReportListKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    async function loadPortfolio() {
      try {
        // Try financial data first, fallback to basic
        const response = await fetch(`${dataRoot}/portfolio_financial.json`);
        if (!response.ok) throw new Error('Failed to load portfolio data');
        const data = await response.json();
        setPortfolio(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    loadPortfolio();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-ink-2">Loading portfolio...</p>
        </div>
      </div>
    );
  }

  if (error || !portfolio) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <div className="text-center text-signal-critical">
          <p>Error loading portfolio: {error}</p>
        </div>
      </div>
    );
  }

  const { financials } = portfolio.summary;

  // Sort plants for ranking table
  const sortedPlants = [...portfolio.plants].sort((a, b) => {
    let aVal = 0, bVal = 0;
    switch (sortColumn) {
      case 'name': return sortAsc ? anonName(a.plantName).localeCompare(anonName(b.plantName)) : anonName(b.plantName).localeCompare(anonName(a.plantName));
      case 'capacity': aVal = a.capacity_MW; bVal = b.capacity_MW; break;
      case 'revenue_at_risk': aVal = a.financials.revenue_at_risk_eur; bVal = b.financials.revenue_at_risk_eur; break;
      case 'health': aVal = a.metrics.healthScore ?? 0; bVal = b.metrics.healthScore ?? 0; break;
      case 'budget_dev': aVal = Math.abs(a.financials.budget_deviation_pct); bVal = Math.abs(b.financials.budget_deviation_pct); break;
      case 'risk': aVal = a.riskScore.overall; bVal = b.riskScore.overall; break;
      default: aVal = a.riskScore.overall; bVal = b.riskScore.overall;
    }
    return sortAsc ? aVal - bVal : bVal - aVal;
  });

  // Plants sorted by risk (highest first) for sidebar
  const riskSortedPlants = [...portfolio.plants].sort((a, b) => b.riskScore.overall - a.riskScore.overall);

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortAsc(!sortAsc);
    } else {
      setSortColumn(column);
      setSortAsc(false);
    }
  };

  const SortIcon = ({ column }: { column: string }) => {
    if (sortColumn !== column) return <span className="text-gray-300 ml-1">↕</span>;
    return <span className="text-blue-600 ml-1">{sortAsc ? '↑' : '↓'}</span>;
  };

  const filteredPlants = sortedPlants.filter(p => 
    anonName(p.plantName).toLowerCase().includes(searchTerm.toLowerCase()) ||
    anonLocation(p.location).toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-paper">
      <OpsDemoStrip totalCapacityMw={45} plantCount={10} />

      {/* Header */}
      <header className="bg-white border-b border-divider sticky top-0 z-50 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
                <NuraVoltLogo width={140} height={35} showTagline={false} />
              </Link>
              <div className="h-6 w-px bg-divider" />
              <h1 className="text-ink font-semibold text-lg tracking-tight">{t('portfolio.title')}</h1>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setEditingReport(null); setShowReportModal(true); }}
                className="hidden md:flex items-center gap-2 px-4 py-2 text-sm font-medium text-ink-2 bg-white border border-divider hover:bg-slate-50 hover:border-slate-300 rounded-lg transition-all shadow-sm"
              >
                <CalendarClock className="h-4 w-4 text-ink-3" />
                {t('portfolio.scheduleReport')}
              </button>
              <button
                onClick={() => setShowWizard(true)}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-all shadow-md shadow-blue-200 active:scale-95"
              >
                <Plus className="h-4 w-4" />
                {t('portfolio.onboardPlant')}
              </button>
              <div className="h-6 w-px bg-divider mx-1" />
              <LanguageSwitcher variant="compact" />
              <AnonymizationToggle variant="compact" />
              <TourTrigger onClick={() => setShowTour(true)} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Ops KPI Row */}
        <div data-tour="portfolio-kpis" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-5 mb-8">
          <KpiCard
            title="Fleet capacity"
            value={`${portfolio.summary.totalCapacity_MW.toLocaleString()} MW`}
            subtitle={`${portfolio.summary.totalPlants + customPlants.length} plants · ${portfolio.summary.operationalPlants} operational`}
            tone="brand"
            icon={Gauge}
            index={0}
          />
          <KpiCard
            title="Production vs budget"
            value={`${financials.overall_budget_deviation_pct > 0 ? '+' : ''}${financials.overall_budget_deviation_pct.toFixed(1)}%`}
            subtitle={`${Math.round(financials.total_actual_generation_MWh).toLocaleString()} MWh actual`}
            tone={financials.overall_budget_deviation_pct >= -3 ? 'positive' : 'warning'}
            icon={Activity}
            index={1}
          />
          <KpiCard
            title="Open issues"
            value={portfolio.summary.criticalIssues + portfolio.summary.majorIssues}
            subtitle={`${portfolio.summary.criticalIssues} critical · ${portfolio.summary.majorIssues} major`}
            tone={portfolio.summary.criticalIssues > 0 ? 'critical' : portfolio.summary.majorIssues > 0 ? 'warning' : 'positive'}
            icon={Zap}
            index={2}
          />
          <KpiCard
            title={t('portfolio.kpi.revenueAtRisk')}
            value={formatCurrency(financials.total_revenue_at_risk_eur)}
            subtitle={t('portfolio.kpi.revenueAtRisk.sub')}
            tone="critical"
            icon={TrendingDown}
            index={3}
          />
          <KpiCard
            title={t('portfolio.kpi.portfolioRisk')}
            value={`${financials.portfolio_risk_score}/100`}
            subtitle={financials.portfolio_risk_level.toUpperCase()}
            tone={financials.portfolio_risk_level === 'low' ? 'positive' : financials.portfolio_risk_level === 'medium' ? 'warning' : 'critical'}
            icon={ShieldAlert}
            index={4}
          />
        </div>

        {/* Needs attention now */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Needs attention</h2>
            <span className="text-xs text-ink-3">ranked by risk score</span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {riskSortedPlants.slice(0, 3).map((plant) => {
              const worstComponent = Object.entries(plant.riskScore.components ?? {}).sort(
                (a, b) => (b[1] as number) - (a[1] as number),
              )[0];
              return (
                <Link
                  key={plant.plantId}
                  href={`/demo/plant/${plant.plantId}`}
                  className="group flex items-center justify-between rounded-xl border border-divider bg-white p-4 shadow-sm transition-all hover:border-blue-300 hover:shadow-md"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-ink group-hover:text-blue-600">
                        {anonName(plant.plantName)}
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${getRiskBadgeColor(plant.riskScore.level)}`}>
                        {plant.riskScore.overall}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-ink-3">
                      {worstComponent
                        ? `Driver: ${worstComponent[0].replace('_', ' ')} · `
                        : ''}
                      {formatCurrency(plant.financials.revenue_at_risk_eur)} at risk
                    </div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-blue-500" />
                </Link>
              );
            })}
          </div>
        </section>

        {/* Fleet grid grouped by asset type */}
        <section className="mb-8">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-ink">Fleet</h2>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" />
              <input
                type="text"
                placeholder="Search plants..."
                className="pl-9 pr-4 py-2 bg-white border border-divider rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-full sm:w-64 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          {(['SOLAR', 'WIND', 'HYDROGEN'] as const).map((assetType) => {
            const group = filteredPlants.filter((p) => p.assetType === assetType);
            if (group.length === 0) return null;
            const Icon = assetType === 'SOLAR' ? Sun : assetType === 'WIND' ? Wind : Atom;
            return (
              <div key={assetType} className="mb-6">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-3">
                  <Icon
                    className={`h-4 w-4 ${
                      assetType === 'SOLAR'
                        ? 'text-asset-solar'
                        : assetType === 'WIND'
                          ? 'text-asset-wind'
                          : 'text-emerald-600'
                    }`}
                  />
                  {assetType === 'SOLAR' ? 'Solar' : assetType === 'WIND' ? 'Wind' : 'Hydrogen'}
                  <span className="font-normal normal-case text-ink-3">
                    {group.length} plants ·{' '}
                    {group.reduce((acc, p) => acc + p.capacity_MW, 0).toFixed(1)} MW
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {group.map((plant) => (
                    <FleetCard
                      key={plant.plantId}
                      plant={plant}
                      name={anonName(plant.plantName)}
                      location={anonLocation(plant.location)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Storage fleet entry (BESS cockpit has its own fleet page) */}
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-3">
            <BatteryCharging className="h-4 w-4 text-asset-bess" />
            Storage
          </div>
          <Link
            href="/demo/portfolio/bess"
            className="group flex items-center justify-between rounded-xl border border-divider border-t-2 border-t-asset-bess bg-white p-4 shadow-sm transition-all hover:border-violet-300 hover:shadow-md sm:max-w-md"
          >
            <div>
              <div className="font-semibold text-ink group-hover:text-violet-700">
                Battery storage fleet
              </div>
              <div className="mt-0.5 text-xs text-ink-3">
                Dispatch, warranty and revenue cockpit for the BESS assets
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 transition-all group-hover:translate-x-1 group-hover:text-violet-500" />
          </Link>
        </section>

        {/* Financial detail */}
        <section className="mb-8">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Financial detail</h2>
              {/* Tab Bar */}
              <div className="flex bg-slate-200/50 p-1 rounded-xl w-fit">
                <button
                  onClick={() => setActiveTab('ranking')}
                  className={`px-5 py-2 text-sm font-semibold rounded-lg transition-all ${
                    activeTab === 'ranking'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-ink-2 hover:text-slate-900'
                  }`}
                >
                  {t('portfolio.tab.ranking')}
                </button>
                <button
                  onClick={() => setActiveTab('losses')}
                  className={`px-5 py-2 text-sm font-semibold rounded-lg transition-all ${
                    activeTab === 'losses'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-ink-2 hover:text-slate-900'
                  }`}
                >
                  {t('portfolio.tab.losses')}
                </button>
              </div>
            </div>

            {/* Tab Content */}
            {activeTab === 'ranking' && (
              <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-paper border-b border-divider">
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('name')}>
                          <div className="flex items-center gap-1">Plant <SortIcon column="name" /></div>
                        </th>
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider text-right cursor-pointer hover:bg-slate-100 transition-colors hidden sm:table-cell" onClick={() => handleSort('capacity')}>
                          <div className="flex items-center justify-end gap-1">Capacity <SortIcon column="capacity" /></div>
                        </th>
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider text-right cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('revenue_at_risk')}>
                          <div className="flex items-center justify-end gap-1">Rev. at Risk <SortIcon column="revenue_at_risk" /></div>
                        </th>
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider text-right cursor-pointer hover:bg-slate-100 transition-colors hidden md:table-cell" onClick={() => handleSort('health')}>
                          <div className="flex items-center justify-end gap-1">Health <SortIcon column="health" /></div>
                        </th>
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider text-right cursor-pointer hover:bg-slate-100 transition-colors hidden md:table-cell" onClick={() => handleSort('budget_dev')}>
                          <div className="flex items-center justify-end gap-1">Budget Dev <SortIcon column="budget_dev" /></div>
                        </th>
                        <th className="px-6 py-4 text-xs font-bold text-ink-3 uppercase tracking-wider text-right cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('risk')}>
                          <div className="flex items-center justify-end gap-1">Risk <SortIcon column="risk" /></div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredPlants.map((plant) => (
                        <tr
                          key={plant.plantId}
                          onClick={() => router.push(`/demo/plant/${plant.plantId}`)}
                          className="group hover:bg-blue-50/30 transition-all cursor-pointer"
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div>
                                <div className="font-bold text-ink group-hover:text-blue-600 transition-colors">{anonName(plant.plantName)}</div>
                                <div className="text-xs text-ink-3 font-medium">{anonLocation(plant.location)}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right text-sm font-medium text-ink-2 hidden sm:table-cell">
                            {plant.capacity_MW} MW
                          </td>
                          <td className="px-6 py-4 text-right text-sm">
                            <span className="font-bold text-signal-critical">{formatCurrency(plant.financials.revenue_at_risk_eur)}</span>
                          </td>
                          <td className="px-6 py-4 text-right hidden md:table-cell">
                            <div className="flex flex-col items-end">
                              <span className={`text-sm font-bold ${
                                (plant.metrics.healthScore ?? 0) >= 90 ? 'text-signal-positive' :
                                (plant.metrics.healthScore ?? 0) >= 80 ? 'text-signal-warning' : 'text-signal-critical'
                              }`}>
                                {plant.metrics.healthScore ?? 'N/A'}%
                              </span>
                              <div className="w-16 h-1 bg-paper-2 rounded-full mt-1 overflow-hidden">
                                <div 
                                  className={`h-full rounded-full ${
                                    (plant.metrics.healthScore ?? 0) >= 90 ? 'bg-emerald-500' :
                                    (plant.metrics.healthScore ?? 0) >= 80 ? 'bg-amber-500' : 'bg-red-500'
                                  }`}
                                  style={{ width: `${plant.metrics.healthScore ?? 0}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right hidden md:table-cell">
                            <span className={`text-sm font-bold ${
                              Math.abs(plant.financials.budget_deviation_pct) <= 5 ? 'text-signal-positive' : 'text-signal-warning'
                            }`}>
                              {plant.financials.budget_deviation_pct > 0 ? '+' : ''}{plant.financials.budget_deviation_pct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className={`inline-flex px-2.5 py-0.5 text-xs font-bold rounded-full border ${getRiskBadgeColor(plant.riskScore.level)}`}>
                                {plant.riskScore.overall}
                              </span>
                              <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-blue-400 group-hover:translate-x-1 transition-all" />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'losses' && financials && (
              <div className="bg-white rounded-xl border border-divider shadow-sm p-6">
                <PortfolioLossChart summary={financials} />
              </div>
            )}
          </div>
        </section>

        {/* Reports row */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
            <ReportsCard />
          </div>
          <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
            <ScheduledReportsList
              key={reportListKey}
              onEdit={(report) => { setEditingReport(report); setShowReportModal(true); }}
              onNewReport={() => { setEditingReport(null); setShowReportModal(true); }}
            />
          </div>
        </section>
      </main>

      {showWizard && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <ConnectionWizard
              mode="full-onboarding"
              allowDemoFallback
              onClose={() => setShowWizard(false)}
              onComplete={(plant?: OnboardedPlant) => {
                if (plant) addPlant(plant);
                setShowWizard(false);
                setOnboardSuccess(true);
                setTimeout(() => setOnboardSuccess(false), 4000);
              }}
            />
          </div>
        </div>
      )}

      <ScheduledReportModal
        open={showReportModal}
        onOpenChange={setShowReportModal}
        existingReport={editingReport}
        plants={portfolio.plants.map(p => ({ plantId: p.plantId, plantName: p.plantName }))}
        onSaved={() => { setShowReportModal(false); setEditingReport(null); setReportListKey(k => k + 1); }}
      />

      <GuidedTour
        steps={DEMO_TOUR_STEPS}
        isOpen={showTour}
        onClose={() => setShowTour(false)}
      />

      {onboardSuccess && (
        <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="font-medium">Plant onboarded successfully</span>
        </div>
      )}
    </div>
  );
}
