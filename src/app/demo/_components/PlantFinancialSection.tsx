'use client';

import { useEffect, useState, useMemo } from 'react';
import SimpleKpiCard from '@/components/ui/SimpleKpiCard';
import BudgetActualChart from './charts/BudgetActualChart';
import LossAttributionChart from './charts/LossAttributionChart';
import RevenueTimelineChart from './charts/RevenueTimelineChart';
import { formatCurrency } from '@/utils/riskScoring';
import { useDataRoot } from '@/contexts/DataSourceContext';
import type {
  EnhancedPortfolioData,
  FinancialPlantData,
} from '@/types/portfolio';
import { DollarSign, Activity, TrendingDown, ShieldAlert } from 'lucide-react';

interface PlantFinancialSectionProps {
  plantId: string;
}

export default function PlantFinancialSection({ plantId }: PlantFinancialSectionProps) {
  const [portfolioData, setPortfolioData] = useState<EnhancedPortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const dataRoot = useDataRoot();

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const res = await fetch(`${dataRoot}/portfolio_financial.json`);
        if (!res.ok) throw new Error('Failed to load financial data');
        const data: EnhancedPortfolioData = await res.json();
        if (!cancelled) {
          setPortfolioData(data);
        }
      } catch (err) {
        console.error('Error loading portfolio financial data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, []);

  const plant: FinancialPlantData | undefined = useMemo(() => {
    if (!portfolioData) return undefined;
    return portfolioData.plants.find((p) => p.plantId === plantId);
  }, [portfolioData, plantId]);

  // Loading state
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-paper border border-divider rounded-lg p-4 animate-pulse"
            >
              <div className="h-3 w-24 bg-divider rounded mb-3" />
              <div className="h-8 w-32 bg-divider rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="bg-white border border-divider rounded-xl p-5 animate-pulse"
            >
              <div className="h-3 w-40 bg-divider rounded mb-4" />
              <div className="h-[300px] bg-paper-2 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // No data state
  if (!plant) {
    return (
      <div className="bg-signal-warning/10 border border-signal-warning/20 rounded-xl p-8 text-center">
        <p className="text-signal-warning font-medium">No financial data available for this plant.</p>
        <p className="text-signal-warning text-sm mt-1">
          Financial metrics will appear here once data is ingested.
        </p>
      </div>
    );
  }

  const { financials, riskScore, monthlyGeneration, assetType } = plant;

  const budgetDeviationColor: 'amber' | 'emerald' =
    financials.budget_deviation_pct >= 0 ? 'emerald' : 'amber';

  const deviationPrefix = financials.budget_deviation_pct >= 0 ? '+' : '';

  const riskKpiColor: 'emerald' | 'amber' | 'red' | 'purple' =
    riskScore.level === 'low'
      ? 'emerald'
      : riskScore.level === 'medium'
        ? 'amber'
        : riskScore.level === 'high'
          ? 'red'
          : 'purple';

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SimpleKpiCard
          title="Annual Revenue"
          value={formatCurrency(financials.annual_revenue_eur)}
          subtitle={`PPA: ${financials.ppa_price_per_MWh.toFixed(0)} EUR/MWh`}
          color="blue"
          icon={DollarSign}
          index={0}
        />
        <SimpleKpiCard
          title="Budget vs Actual"
          value={`${deviationPrefix}${financials.budget_deviation_pct.toFixed(1)}%`}
          subtitle={`${financials.actual_generation_MWh.toLocaleString()} / ${financials.budget_generation_MWh.toLocaleString()} MWh`}
          color={budgetDeviationColor}
          icon={Activity}
          index={1}
        />
        <SimpleKpiCard
          title="Total Losses"
          value={formatCurrency(financials.total_loss_eur)}
          subtitle={`Revenue at risk: ${formatCurrency(financials.revenue_at_risk_eur)}`}
          color="red"
          icon={TrendingDown}
          index={2}
        />
        <SimpleKpiCard
          title="Risk Score"
          value={`${riskScore.overall}/100`}
          subtitle={`Level: ${riskScore.level.charAt(0).toUpperCase() + riskScore.level.slice(1)} | Trend: ${riskScore.trend}`}
          color={riskKpiColor}
          icon={ShieldAlert}
          index={3}
        />
      </div>

      {/* Charts row: Budget vs Actual + Loss Attribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BudgetActualChart monthlyData={monthlyGeneration} />
        <LossAttributionChart financials={financials} assetType={assetType} />
      </div>

      {/* Full width: Revenue Timeline */}
      <RevenueTimelineChart
        monthlyData={monthlyGeneration}
        ppaPrice={financials.ppa_price_per_MWh}
      />
    </div>
  );
}
