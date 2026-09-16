'use client';

import SimpleKpiCard from '@/components/ui/SimpleKpiCard';
import { formatCurrency, getRiskLevel } from '@/utils/riskScoring';
import type { PortfolioFinancialSummary } from '@/types/portfolio';

interface FinancialKpiRowProps {
  summary: PortfolioFinancialSummary;
}

export default function FinancialKpiRow({ summary }: FinancialKpiRowProps) {
  const budgetDeviation = summary.overall_budget_deviation_pct;
  const budgetColor = budgetDeviation >= 0 ? 'green' : 'amber';
  const budgetSign = budgetDeviation >= 0 ? '+' : '';

  const riskLevel = getRiskLevel(summary.portfolio_risk_score);
  const riskColor: 'emerald' | 'amber' | 'red' =
    riskLevel === 'low' ? 'emerald' :
    riskLevel === 'medium' ? 'amber' : 'red';

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      <SimpleKpiCard
        title="Revenue at Risk"
        value={formatCurrency(summary.total_revenue_at_risk_eur)}
        subtitle="Total portfolio exposure"
        color="red"
        index={0}
      />
      <SimpleKpiCard
        title="Budget vs Actual"
        value={`${budgetSign}${budgetDeviation.toFixed(1)}%`}
        subtitle={`${formatCurrency(summary.total_actual_generation_MWh * (summary.total_annual_revenue_eur / Math.max(summary.total_budget_generation_MWh, 1)))} actual`}
        color={budgetColor}
        index={1}
      />
      <SimpleKpiCard
        title="Portfolio Risk Score"
        value={`${summary.portfolio_risk_score}/100`}
        subtitle={`${riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1)} risk`}
        color={riskColor}
        index={2}
      />
      <SimpleKpiCard
        title="Total Soiling Loss"
        value={formatCurrency(summary.total_soiling_loss_eur)}
        subtitle="Estimated annual impact"
        color="amber"
        index={3}
      />
      <SimpleKpiCard
        title="Total Fault Loss"
        value={formatCurrency(summary.total_fault_loss_eur)}
        subtitle="From equipment issues"
        color="red"
        index={4}
      />
    </div>
  );
}
