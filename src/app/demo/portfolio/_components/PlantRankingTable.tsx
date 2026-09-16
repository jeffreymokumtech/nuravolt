'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
import { getRiskBadgeColor, formatCurrency, formatPercentage } from '@/utils/riskScoring';
import type { FinancialPlantData } from '@/types/portfolio';

interface PlantRankingTableProps {
  plants: FinancialPlantData[];
}

type SortColumn = 'plantName' | 'capacity_MW' | 'revenue_at_risk' | 'healthScore' | 'budget_deviation' | 'riskScore';
type SortDirection = 'asc' | 'desc';

function getSortValue(plant: FinancialPlantData, column: SortColumn): number | string {
  switch (column) {
    case 'plantName':
      return plant.plantName.toLowerCase();
    case 'capacity_MW':
      return plant.capacity_MW;
    case 'revenue_at_risk':
      return plant.financials.revenue_at_risk_eur;
    case 'healthScore':
      return plant.metrics.healthScore ?? 0;
    case 'budget_deviation':
      return plant.financials.budget_deviation_pct;
    case 'riskScore':
      return plant.riskScore.overall;
  }
}

const assetTypeBadge: Record<string, { bg: string; text: string; label: string }> = {
  SOLAR: { bg: 'bg-signal-warning/10', text: 'text-signal-warning', label: 'Solar' },
  WIND: { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Wind' },
  BESS: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'BESS' },
};

export default function PlantRankingTable({ plants }: PlantRankingTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('riskScore');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const sortedPlants = [...plants].sort((a, b) => {
    const aVal = getSortValue(a, sortColumn);
    const bVal = getSortValue(b, sortColumn);
    const modifier = sortDirection === 'asc' ? 1 : -1;
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return aVal.localeCompare(bVal) * modifier;
    }
    return ((aVal as number) - (bVal as number)) * modifier;
  });

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="w-3.5 h-3.5 text-ink-3" />;
    }
    return sortDirection === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-blue-600" />
      : <ChevronDown className="w-3.5 h-3.5 text-blue-600" />;
  };

  const headerClass = 'px-4 py-3 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors select-none';

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead className="bg-paper border-b border-divider">
            <tr>
              <th className={headerClass} onClick={() => handleSort('plantName')}>
                <div className="flex items-center gap-1">
                  Plant Name
                  <SortIcon column="plantName" />
                </div>
              </th>
              <th className={headerClass} onClick={() => handleSort('capacity_MW')}>
                <div className="flex items-center gap-1">
                  Capacity
                  <SortIcon column="capacity_MW" />
                </div>
              </th>
              <th className={headerClass} onClick={() => handleSort('revenue_at_risk')}>
                <div className="flex items-center gap-1">
                  Revenue at Risk
                  <SortIcon column="revenue_at_risk" />
                </div>
              </th>
              <th className={headerClass} onClick={() => handleSort('healthScore')}>
                <div className="flex items-center gap-1">
                  Health Score
                  <SortIcon column="healthScore" />
                </div>
              </th>
              <th className={headerClass} onClick={() => handleSort('budget_deviation')}>
                <div className="flex items-center gap-1">
                  Budget Dev
                  <SortIcon column="budget_deviation" />
                </div>
              </th>
              <th className={headerClass} onClick={() => handleSort('riskScore')}>
                <div className="flex items-center gap-1">
                  Risk Score
                  <SortIcon column="riskScore" />
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sortedPlants.map((plant) => {
              const badge = assetTypeBadge[plant.assetType] || assetTypeBadge.SOLAR;
              const riskBadge = getRiskBadgeColor(plant.riskScore.level);
              const budgetDev = plant.financials.budget_deviation_pct;
              const budgetColor = budgetDev >= 0 ? 'text-signal-positive' : 'text-signal-critical';
              const budgetSign = budgetDev >= 0 ? '+' : '';
              const healthScore = plant.metrics.healthScore;

              return (
                <Link
                  key={plant.plantId}
                  href={`/demo/plant/${plant.plantId}/financials`}
                  className="table-row hover:bg-gray-50 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{plant.plantName}</span>
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${badge.bg} ${badge.text}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="text-xs text-ink-3">{plant.location}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-2">
                    {plant.capacity_MW} MW
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-signal-critical">
                    {formatCurrency(plant.financials.revenue_at_risk_eur)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${
                      (healthScore ?? 0) >= 90 ? 'text-signal-positive' :
                      (healthScore ?? 0) >= 70 ? 'text-signal-warning' : 'text-signal-critical'
                    }`}>
                      {healthScore !== null ? formatPercentage(healthScore, 0) : '--'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${budgetColor}`}>
                      {budgetSign}{formatPercentage(budgetDev)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${riskBadge}`}>
                      {plant.riskScore.overall} - {plant.riskScore.level}
                    </span>
                  </td>
                </Link>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
