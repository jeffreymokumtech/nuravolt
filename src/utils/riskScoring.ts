/**
 * Risk Scoring Utilities
 * Pure functions for computing portfolio and plant-level risk scores.
 */

import type { FinancialPlantData, PlantRiskScore } from '@/types/portfolio';

export function calculatePlantRiskScore(plant: FinancialPlantData): PlantRiskScore {
  const { healthDistribution, financials, metrics } = plant;
  const total = healthDistribution.normal + healthDistribution.minorIssues +
    healthDistribution.majorIssues + healthDistribution.critical;

  // Health risk: inverted health score (100 = worst)
  const healthScore = metrics.healthScore ?? 90;
  const healthRisk = Math.max(0, 100 - healthScore);

  // Soiling risk: deviation from 1.0 (only for solar)
  const sr = metrics.soilingRatio ?? 1.0;
  const soilingRisk = plant.assetType === 'SOLAR'
    ? Math.min(100, Math.max(0, (1 - sr) * 500))
    : 0;

  // Fault frequency risk: weighted by severity
  const faultRisk = total > 0
    ? Math.min(100, (healthDistribution.majorIssues * 15 + healthDistribution.critical * 30))
    : 0;

  // Budget deviation risk
  const budgetRisk = Math.min(100, Math.abs(financials.budget_deviation_pct) * 2);

  // Availability risk
  const availRisk = Math.min(100, Math.max(0, (100 - financials.availability_pct) * 2));

  const overall = Math.round(
    0.25 * healthRisk +
    0.20 * soilingRisk +
    0.25 * faultRisk +
    0.15 * budgetRisk +
    0.15 * availRisk
  );

  return {
    overall,
    components: {
      health: Math.round(healthRisk),
      soiling: Math.round(soilingRisk),
      fault_frequency: Math.round(faultRisk),
      budget_deviation: Math.round(budgetRisk),
      availability: Math.round(availRisk),
    },
    trend: overall < 30 ? 'improving' : overall < 60 ? 'stable' : 'degrading',
    level: getRiskLevel(overall),
  };
}

export function calculatePortfolioRiskScore(plants: FinancialPlantData[]): number {
  const totalCapacity = plants.reduce((sum, p) => sum + p.capacity_MW, 0);
  if (totalCapacity === 0) return 0;
  const weightedSum = plants.reduce(
    (sum, p) => sum + p.riskScore.overall * p.capacity_MW,
    0
  );
  return Math.round(weightedSum / totalCapacity);
}

export function getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score < 25) return 'low';
  if (score < 50) return 'medium';
  if (score < 75) return 'high';
  return 'critical';
}

export function getRiskColor(level: string): string {
  switch (level) {
    case 'low': return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    case 'medium': return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'high': return 'text-orange-600 bg-orange-50 border-orange-200';
    case 'critical': return 'text-red-600 bg-red-50 border-red-200';
    default: return 'text-gray-600 bg-gray-50 border-gray-200';
  }
}

export function getRiskBadgeColor(level: string): string {
  switch (level) {
    case 'low': return 'bg-emerald-100 text-emerald-700';
    case 'medium': return 'bg-amber-100 text-amber-700';
    case 'high': return 'bg-orange-100 text-orange-700';
    case 'critical': return 'bg-red-100 text-red-700';
    default: return 'bg-gray-100 text-gray-700';
  }
}

export function formatCurrency(value: number, decimals = 0): string {
  if (Math.abs(value) >= 1_000_000) {
    return `€${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `€${(value / 1_000).toFixed(decimals > 0 ? decimals : 0)}K`;
  }
  return `€${value.toFixed(decimals)}`;
}

export function formatCurrencyFull(value: number): string {
  return `€${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function formatPercentage(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function getPrimaryRiskFactor(plant: FinancialPlantData): string {
  const { components } = plant.riskScore;
  const factors: [string, number][] = [
    ['Health issues', components.health],
    ['Soiling losses', components.soiling],
    ['Fault frequency', components.fault_frequency],
    ['Budget deviation', components.budget_deviation],
    ['Low availability', components.availability],
  ];
  factors.sort((a, b) => b[1] - a[1]);
  return factors[0][0];
}
