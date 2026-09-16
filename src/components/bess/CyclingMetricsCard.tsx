'use client';

import type { CyclingMetricsSummary } from '@/types/bess';
import { formatEnergy } from '@/types/bess';

interface CyclingMetricsCardProps {
  metrics: CyclingMetricsSummary | null;
  loading?: boolean;
}

export default function CyclingMetricsCard({ metrics, loading }: CyclingMetricsCardProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 bg-gray-200 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <p className="text-gray-500 text-center">No cycling data available</p>
      </div>
    );
  }

  const kpis = [
    {
      label: 'Equivalent Cycles',
      value: metrics.totals.equivalentFullCycles.toFixed(0),
      unit: 'EFC',
      color: '#3B82F6',
    },
    {
      label: 'Total Throughput',
      value: metrics.totals.throughputMwh.toFixed(1),
      unit: 'MWh',
      color: '#8B5CF6',
    },
    {
      label: 'Avg. DoD',
      value: (metrics.averages.dod * 100).toFixed(0),
      unit: '%',
      color: '#10B981',
    },
    {
      label: 'Avg. RTE',
      value: (metrics.averages.roundTripEfficiency * 100).toFixed(1),
      unit: '%',
      color: '#F59E0B',
    },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Cycling Metrics</h3>
        <span className="text-xs text-gray-500">
          {metrics.period.days} days ({metrics.period.start} - {metrics.period.end})
        </span>
      </div>

      {/* Main KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="p-4 rounded-lg border border-gray-100"
            style={{ backgroundColor: `${kpi.color}10` }}
          >
            <p className="text-sm text-gray-600">{kpi.label}</p>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold" style={{ color: kpi.color }}>
                {kpi.value}
              </span>
              <span className="text-sm text-gray-500">{kpi.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Stats */}
      <div className="border-t border-gray-200 pt-4">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Operating Conditions</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Daily Cycles:</span>
            <span className="ml-2 font-medium">{metrics.averages.dailyCycles.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-gray-500">Avg C-Rate:</span>
            <span className="ml-2 font-medium">{metrics.averages.cRate.toFixed(2)}C</span>
          </div>
          <div>
            <span className="text-gray-500">Avg Temp:</span>
            <span className="ml-2 font-medium">{metrics.averages.temperature.toFixed(1)}°C</span>
          </div>
          <div>
            <span className="text-gray-500">Max DoD:</span>
            <span className="ml-2 font-medium">{(metrics.limits.maxDod * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {/* Stress Metrics */}
      <div className="border-t border-gray-200 pt-4 mt-4">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Stress Metrics</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-gray-500">High SoC Hours:</span>
            <span className="ml-2 font-medium text-amber-600">
              {metrics.stressMetrics.highSocHoursTotal.toFixed(1)}h
            </span>
          </div>
          <div>
            <span className="text-gray-500">High Temp Hours:</span>
            <span className="ml-2 font-medium text-red-600">
              {metrics.stressMetrics.highTempHoursTotal.toFixed(1)}h
            </span>
          </div>
          <div>
            <span className="text-gray-500">Stress-Weighted Cycles:</span>
            <span className="ml-2 font-medium">
              {metrics.stressMetrics.stressWeightedCycles.toFixed(0)}
            </span>
          </div>
        </div>
      </div>

      {/* Temperature Range */}
      <div className="border-t border-gray-200 pt-4 mt-4">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Temperature Range</h4>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">Min: {metrics.limits.minTemp.toFixed(1)}°C</span>
          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-400 via-green-400 to-red-400 rounded-full"
              style={{
                marginLeft: `${((metrics.limits.minTemp - 10) / 40) * 100}%`,
                width: `${((metrics.limits.maxTemp - metrics.limits.minTemp) / 40) * 100}%`,
              }}
            />
          </div>
          <span className="text-sm text-gray-500">Max: {metrics.limits.maxTemp.toFixed(1)}°C</span>
        </div>
      </div>
    </div>
  );
}
