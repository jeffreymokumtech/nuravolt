'use client';

import Link from 'next/link';
import { MapPin, TrendingDown, TrendingUp } from 'lucide-react';
import { formatCurrency, getRiskBadgeColor } from '@/utils/riskScoring';


interface PlantData {
  plantId: string;
  plantName: string;
  location: string;
  capacity_MW: number;
  totalInverters: number;
  inverterGroups?: string[];
  turbineCount?: number;
  assetType?: 'SOLAR' | 'WIND' | 'BESS';
  status: 'operational' | 'demo' | 'offline';
  healthDistribution: {
    normal: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
  metrics: {
    avgR2?: number | null;
    avgMAE_kW?: number | null;
    soilingRatio?: number | null;
    healthScore: number | null;
    availability?: number;
    capacityFactor?: number;
  };
  dataRange: {
    start: string;
    end: string;
  } | null;
  lastUpdated: string | null;
  financials?: {
    revenue_at_risk_eur: number;
    budget_deviation_pct: number;
    availability_pct: number;
  };
  riskScore?: {
    overall: number;
    level: string;
  };
}

interface PlantCardProps {
  plant: PlantData;
  index?: number;
}

export default function PlantCard({ plant, index = 0 }: PlantCardProps) {
  const { healthDistribution } = plant;
  const totalInverters = healthDistribution.normal + healthDistribution.minorIssues +
                         healthDistribution.majorIssues + healthDistribution.critical;

  const healthPercentage = totalInverters > 0
    ? Math.round((healthDistribution.normal / totalInverters) * 100)
    : 0;

  const hasIssues = healthDistribution.critical > 0 || healthDistribution.majorIssues > 0;
  const isDemo = plant.status === 'demo';

  // Status badge colors
  const statusColors = {
    operational: 'bg-green-100 text-green-800 border-green-200',
    demo: 'bg-paper-2 text-ink-2 border-divider',
    offline: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  };

  // Calculate health bar segments
  const segments = [
    { count: healthDistribution.normal, color: 'bg-emerald-500', label: 'Normal' },
    { count: healthDistribution.minorIssues, color: 'bg-yellow-400', label: 'Minor' },
    { count: healthDistribution.majorIssues, color: 'bg-orange-500', label: 'Major' },
    { count: healthDistribution.critical, color: 'bg-red-500', label: 'Critical' },
  ];

  const CardContent = () => (
    <>
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-semibold text-ink text-lg">{plant.plantName}</h3>
          <p className="text-sm text-ink-3 flex items-center gap-1">
            <MapPin className="w-4 h-4" />
            {plant.location}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {plant.riskScore && (
            <span className={`px-2 py-1 text-xs font-medium rounded-full ${getRiskBadgeColor(plant.riskScore.level)}`}>
              Risk: {plant.riskScore.overall}
            </span>
          )}
          <span className={`px-2 py-1 text-xs font-medium rounded-full border ${statusColors[plant.status]}`}>
            {plant.status === 'operational' ? 'Live' : plant.status === 'demo' ? 'Demo' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Capacity & Inverters */}
      <div className="flex gap-4 mb-4">
        <div>
          <div className="text-2xl font-bold text-ink">{plant.capacity_MW} MW</div>
          <div className="text-xs text-ink-3">Capacity</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-ink">{plant.totalInverters}</div>
          <div className="text-xs text-ink-3">Inverters</div>
        </div>
        {plant.metrics.avgR2 !== null && (
          <div>
            <div className="text-2xl font-bold text-blue-600">{(plant.metrics.avgR2 * 100).toFixed(1)}%</div>
            <div className="text-xs text-ink-3">Model R2</div>
          </div>
        )}
      </div>

      {/* Health Bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-ink-2 mb-1">
          <span>Inverter Health</span>
          <span className={healthPercentage >= 90 ? 'text-signal-positive font-medium' : healthPercentage >= 70 ? 'text-signal-warning font-medium' : 'text-signal-critical font-medium'}>
            {healthPercentage}% healthy
          </span>
        </div>
        <div className="h-2 bg-paper-2 rounded-full overflow-hidden flex">
          {segments.map((segment, idx) => {
            const width = totalInverters > 0 ? (segment.count / totalInverters) * 100 : 0;
            return width > 0 ? (
              <div
                key={idx}
                className={`${segment.color} transition-all`}
                style={{ width: `${width}%` }}
                title={`${segment.label}: ${segment.count}`}
              />
            ) : null;
          })}
        </div>
      </div>

      {/* Health Distribution */}
      <div className="flex gap-2 text-xs">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
          {healthDistribution.normal}
        </span>
        {healthDistribution.minorIssues > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
            {healthDistribution.minorIssues}
          </span>
        )}
        {healthDistribution.majorIssues > 0 && (
          <span className="flex items-center gap-1 text-orange-600 font-medium">
            <span className="w-2 h-2 rounded-full bg-orange-500"></span>
            {healthDistribution.majorIssues}
          </span>
        )}
        {healthDistribution.critical > 0 && (
          <span className="flex items-center gap-1 text-signal-critical font-medium">
            <span className="w-2 h-2 rounded-full bg-red-500"></span>
            {healthDistribution.critical}
          </span>
        )}
      </div>

      {/* Financial Compact View */}
      {plant.financials && (
        <div className="mt-3 pt-3 border-t border-divider flex items-center justify-between text-xs">
          <div className="flex items-center gap-1 text-signal-critical font-medium">
            <span className="text-ink-3 font-normal">At Risk:</span>
            {formatCurrency(plant.financials.revenue_at_risk_eur)}
          </div>
          <div className={`flex items-center gap-1 font-medium ${
            plant.financials.budget_deviation_pct >= 0 ? 'text-signal-positive' : 'text-signal-warning'
          }`}>
            {plant.financials.budget_deviation_pct >= 0 ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {plant.financials.budget_deviation_pct > 0 ? '+' : ''}{plant.financials.budget_deviation_pct.toFixed(1)}%
            <span className="text-ink-3 font-normal">budget</span>
          </div>
        </div>
      )}

      {/* Demo badge: honest label, no overlay hiding the card */}
      {isDemo && (
        <div className="absolute top-3 right-3 rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-medium text-ink-3">
          Demo data
        </div>
      )}

      {/* Click indicator for operational plants */}
      {!isDemo && (
        <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      )}
    </>
  );

  // Wrap in Link only for operational plants
  if (!isDemo) {
    return (
      <Link
        href={`/demo/plant/${plant.plantId}`}
        className={`relative block bg-white rounded-xl border p-5 shadow-sm transition-all group cursor-pointer hover:shadow-md ${
          hasIssues ? 'border-orange-200 hover:border-orange-300' : 'border-divider hover:border-blue-300'
        }`}
      >
        <CardContent />
      </Link>
    );
  }

  return (
    <div
      className={`relative bg-white rounded-xl border p-5 shadow-sm ${
        hasIssues ? 'border-orange-200' : 'border-divider'
      }`}
    >
      <CardContent />
    </div>
  );
}
