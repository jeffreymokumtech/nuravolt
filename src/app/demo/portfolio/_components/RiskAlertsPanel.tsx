'use client';

import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { getRiskBadgeColor, formatCurrency, getPrimaryRiskFactor } from '@/utils/riskScoring';
import type { FinancialPlantData } from '@/types/portfolio';

interface RiskAlertsPanelProps {
  plants: FinancialPlantData[];
}

function getBorderColor(level: string): string {
  switch (level) {
    case 'critical':
    case 'high':
      return 'border-l-red-500';
    case 'medium':
      return 'border-l-orange-400';
    default:
      return 'border-l-transparent';
  }
}

export default function RiskAlertsPanel({ plants }: RiskAlertsPanelProps) {
  const sortedPlants = [...plants].sort(
    (a, b) => b.riskScore.overall - a.riskScore.overall
  );

  const highRiskCount = plants.filter(
    (p) => p.riskScore.level === 'high' || p.riskScore.level === 'critical'
  ).length;

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-divider bg-paper">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <h3 className="font-semibold text-ink">Risk Alerts</h3>
        </div>
        <div className="flex gap-4 mt-2 text-sm">
          {highRiskCount > 0 && (
            <span className="flex items-center gap-1 text-signal-critical font-medium">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              {highRiskCount} high risk
            </span>
          )}
          <span className="text-ink-3">
            {plants.length} plants monitored
          </span>
        </div>
      </div>

      {/* Risk List */}
      <div className="divide-y divide-gray-100">
        {sortedPlants.map((plant) => {
          const riskBadge = getRiskBadgeColor(plant.riskScore.level);
          const borderColor = getBorderColor(plant.riskScore.level);
          const primaryFactor = getPrimaryRiskFactor(plant);

          return (
            <Link
              key={plant.plantId}
              href={`/demo/plant/${plant.plantId}`}
              className={`block px-5 py-3 hover:bg-gray-50 transition-colors border-l-4 ${borderColor}`}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink truncate">
                    {plant.plantName}
                  </div>
                  <div className="text-xs text-ink-3">{plant.location}</div>
                  <div className="text-xs text-ink-3 mt-0.5">{primaryFactor}</div>
                </div>
                <div className="flex items-center gap-2 ml-3 shrink-0">
                  <div className="text-right">
                    <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${riskBadge}`}>
                      {plant.riskScore.level}
                    </span>
                    <div className="text-xs text-signal-critical font-medium mt-1">
                      {formatCurrency(plant.financials.revenue_at_risk_eur)}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-ink-3" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
