'use client';

import type { WarrantyHealthScore } from '@/types/bess';
import { getRiskLevelColor, getHealthScoreCategory } from '@/types/bess';

interface WarrantyHealthCardProps {
  healthScore: WarrantyHealthScore | null;
  loading?: boolean;
}

export default function WarrantyHealthCard({ healthScore, loading }: WarrantyHealthCardProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="h-32 bg-gray-200 rounded-full w-32 mx-auto mb-4" />
          <div className="h-4 bg-gray-200 rounded w-full mb-2" />
          <div className="h-4 bg-gray-200 rounded w-3/4" />
        </div>
      </div>
    );
  }

  if (!healthScore) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <p className="text-gray-500 text-center">No warranty data available</p>
      </div>
    );
  }

  const { label: scoreLabel, color: scoreColor } = getHealthScoreCategory(healthScore.score);
  const riskColor = getRiskLevelColor(healthScore.riskLevel);

  // Calculate gauge angles (0 = poor, 180 = excellent)
  const gaugeAngle = (healthScore.score / 100) * 180;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Warranty Health Score</h3>

      {/* Gauge visualization */}
      <div className="flex justify-center mb-6">
        <div className="relative w-48 h-24 overflow-hidden">
          {/* Background arc */}
          <div className="absolute inset-0">
            <svg viewBox="0 0 100 50" className="w-full h-full">
              {/* Background track */}
              <path
                d="M 5 50 A 45 45 0 0 1 95 50"
                fill="none"
                stroke="#E5E7EB"
                strokeWidth="10"
                strokeLinecap="round"
              />
              {/* Progress arc */}
              <path
                d="M 5 50 A 45 45 0 0 1 95 50"
                fill="none"
                stroke={scoreColor}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={`${(gaugeAngle / 180) * 141.37} 141.37`}
              />
            </svg>
          </div>
          {/* Score display */}
          <div className="absolute inset-x-0 bottom-0 text-center">
            <span className="text-4xl font-bold" style={{ color: scoreColor }}>
              {healthScore.score}
            </span>
            <span className="text-lg text-gray-500">/100</span>
          </div>
        </div>
      </div>

      {/* Risk level badge */}
      <div className="flex justify-center mb-4">
        <span
          className="px-3 py-1 rounded-full text-sm font-medium text-white"
          style={{ backgroundColor: riskColor }}
        >
          {healthScore.riskLevel} Risk
        </span>
      </div>

      {/* Component scores */}
      <div className="space-y-2 mb-4">
        <ScoreBar label="SoH" value={healthScore.components.sohScore} />
        <ScoreBar label="Cycles" value={healthScore.components.cycleScore} />
        <ScoreBar label="Time" value={healthScore.components.timeScore} />
        <ScoreBar label="Efficiency" value={healthScore.components.efficiencyScore} />
        <ScoreBar label="Violations" value={healthScore.components.violationsScore} />
      </div>

      {/* Key metrics */}
      <div className="border-t border-gray-200 pt-4 mt-4">
        <h4 className="text-sm font-medium text-gray-700 mb-2">Key Metrics</h4>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Current SoH:</span>
            <span className="ml-2 font-medium">{(healthScore.metrics.currentSoh * 100).toFixed(1)}%</span>
          </div>
          <div>
            <span className="text-gray-500">Margin:</span>
            <span className="ml-2 font-medium">{(healthScore.metrics.sohMargin * 100).toFixed(1)}%</span>
          </div>
          <div>
            <span className="text-gray-500">Cycles Used:</span>
            <span className="ml-2 font-medium">{Math.round(healthScore.metrics.cyclesUsed)}</span>
          </div>
          <div>
            <span className="text-gray-500">Years Left:</span>
            <span className="ml-2 font-medium">{healthScore.metrics.yearsRemaining.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {/* Risk factors */}
      {healthScore.riskFactors.length > 0 && (
        <div className="border-t border-gray-200 pt-4 mt-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Risk Factors</h4>
          <ul className="space-y-1 text-sm text-gray-600">
            {healthScore.riskFactors.map((factor, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">&#9888;</span>
                {factor}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendation */}
      <div className="border-t border-gray-200 pt-4 mt-4">
        <div className="flex items-start gap-2 text-sm">
          <span className="text-blue-500 mt-0.5">&#9432;</span>
          <span className="text-gray-700">{healthScore.recommendation}</span>
        </div>
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 80 ? '#10B981' : value >= 60 ? '#F59E0B' : value >= 40 ? '#F97316' : '#EF4444';

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-600 w-20">{label}</span>
      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{value}</span>
    </div>
  );
}
