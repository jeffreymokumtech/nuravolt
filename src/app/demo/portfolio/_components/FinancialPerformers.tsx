'use client';

import Link from 'next/link';
import { Trophy, ChevronRight } from 'lucide-react';
import { formatCurrency, formatPercentage } from '@/utils/riskScoring';
import type { FinancialPlantData } from '@/types/portfolio';

interface FinancialPerformersProps {
  plants: FinancialPlantData[];
}

const rankStyles = [
  { bg: 'bg-yellow-100', text: 'text-yellow-700' },  // gold
  { bg: 'bg-paper-2', text: 'text-ink-2' },       // silver
  { bg: 'bg-orange-100', text: 'text-orange-700' },   // bronze
];

export default function FinancialPerformers({ plants }: FinancialPerformersProps) {
  const topPlants = [...plants]
    .sort(
      (a, b) =>
        Math.abs(a.financials.budget_deviation_pct) -
        Math.abs(b.financials.budget_deviation_pct)
    )
    .slice(0, 3);

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-divider bg-paper">
        <div className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-emerald-500" />
          <h3 className="font-semibold text-ink">Top Financial Performers</h3>
        </div>
        <p className="text-xs text-ink-3 mt-1">
          Plants closest to budget targets
        </p>
      </div>

      {/* Performers List */}
      <div className="divide-y divide-gray-100">
        {topPlants.map((plant, index) => {
          const style = rankStyles[index] || rankStyles[2];
          const budgetDev = plant.financials.budget_deviation_pct;
          const budgetSign = budgetDev >= 0 ? '+' : '';
          const budgetColor = budgetDev >= 0 ? 'text-signal-positive' : 'text-signal-critical';

          return (
            <Link
              key={plant.plantId}
              href={`/demo/plant/${plant.plantId}`}
              className="block px-5 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${style.bg} ${style.text}`}
                  >
                    {index + 1}
                  </div>
                  <div>
                    <div className="font-medium text-ink">
                      {plant.plantName}
                    </div>
                    <div className="text-xs text-ink-3">
                      {plant.capacity_MW} MW
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <div className={`text-sm font-bold ${budgetColor}`}>
                      {budgetSign}{formatPercentage(budgetDev)}
                    </div>
                    <div className="text-xs text-ink-3">
                      {formatCurrency(plant.financials.ytd_revenue_eur)} YTD
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-ink-3 ml-2" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
