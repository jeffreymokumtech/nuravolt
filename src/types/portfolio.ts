/**
 * Portfolio Financial Management Types
 * Types for portfolio-level financial visibility, risk scoring, and budget tracking.
 */

export interface PlantFinancials {
  ppa_price_per_MWh: number;
  budget_generation_MWh: number;
  actual_generation_MWh: number;
  budget_deviation_pct: number;
  annual_opex_eur: number;
  soiling_loss_eur: number;
  fault_loss_eur: number;
  degradation_loss_eur: number;
  curtailment_loss_eur: number;
  total_loss_eur: number;
  availability_pct: number;
  performance_ratio: number;
  revenue_at_risk_eur: number;
  annual_revenue_eur: number;
  ytd_revenue_eur: number;
}

export interface PlantRiskScore {
  overall: number;
  components: {
    health: number;
    soiling: number;
    fault_frequency: number;
    budget_deviation: number;
    availability: number;
  };
  trend: 'improving' | 'stable' | 'degrading';
  level: 'low' | 'medium' | 'high' | 'critical';
}

export interface PortfolioFinancialSummary {
  total_capacity_MW: number;
  total_budget_generation_MWh: number;
  total_actual_generation_MWh: number;
  overall_budget_deviation_pct: number;
  total_annual_revenue_eur: number;
  total_ytd_revenue_eur: number;
  total_revenue_at_risk_eur: number;
  total_soiling_loss_eur: number;
  total_fault_loss_eur: number;
  total_degradation_loss_eur: number;
  total_curtailment_loss_eur: number;
  total_opex_eur: number;
  portfolio_risk_score: number;
  portfolio_risk_level: 'low' | 'medium' | 'high' | 'critical';
}

export interface MonthlyGeneration {
  month: string;
  budget_MWh: number;
  actual_MWh: number;
  deviation_pct: number;
}

export interface FinancialPlantData {
  plantId: string;
  plantName: string;
  assetType: 'SOLAR' | 'WIND' | 'BESS' | 'HYDROGEN';
  location: string;
  capacity_MW: number;
  totalInverters: number;
  inverterGroups?: string[];
  turbineCount?: number;
  turbineModel?: string;
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
  dataRange: { start: string; end: string } | null;
  lastUpdated: string | null;
  financials: PlantFinancials;
  riskScore: PlantRiskScore;
  monthlyGeneration: MonthlyGeneration[];
}

export interface EnhancedPortfolioData {
  generatedAt: string;
  plants: FinancialPlantData[];
  summary: {
    totalPlants: number;
    operationalPlants: number;
    totalCapacity_MW: number;
    byAssetType: Record<string, number>;
    totalInverters: number;
    totalTurbines?: number;
    criticalIssues: number;
    majorIssues: number;
    topPerformers: string[];
    needsAttention: string[];
    financials: PortfolioFinancialSummary;
  };
}
