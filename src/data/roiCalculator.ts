/**
 * ROI Calculator Data
 * Regional parameters and constants for NuraVolt ROI calculations
 * All values are conservative and research-backed
 * See docs/technical/ROI_ASSUMPTIONS.md for complete documentation and sources
 */

export type Region = 'uae' | 'gcc' | 'netherlands' | 'spain' | 'europe' | 'africa';

export interface RegionalParameters {
  name: string;
  solarHours: number; // annual kWh/kW
  soilingRate: number; // % daily loss rate
  degradation: number; // % annual degradation
  avgPeakTemp: number; // °C typical peak temperature
  cleaningCostPerMW: number; // $/MW per cleaning
  defaultElectricityRate: number; // $/MWh
  soilingOptimizationFactor: number; // $/MW/year baseline savings
}

/**
 * Regional default parameters
 * Sources: NREL, IEA PVPS Task 13, Sandia Labs
 */
export const REGIONAL_DEFAULTS: Record<Region, RegionalParameters> = {
  uae: {
    name: 'United Arab Emirates',
    solarHours: 2200, // NREL Solar Resource Database
    soilingRate: 0.4, // % daily (high desert dust)
    degradation: 1.2, // % annual (heat stress)
    avgPeakTemp: 85, // °C module temp
    cleaningCostPerMW: 1200, // $/MW per cleaning
    defaultElectricityRate: 45, // $/MWh (UAE feed-in tariff)
    soilingOptimizationFactor: 850 // Conservative baseline
  },
  gcc: {
    name: 'GCC Region (Saudi, Qatar, Oman, etc.)',
    solarHours: 2100, // Slightly lower than UAE
    soilingRate: 0.35, // % daily (coastal dust + sand)
    degradation: 1.1, // % annual
    avgPeakTemp: 80, // °C
    cleaningCostPerMW: 1100,
    defaultElectricityRate: 42,
    soilingOptimizationFactor: 780
  },
  netherlands: {
    name: 'Netherlands',
    solarHours: 1050, // Northern Europe baseline
    soilingRate: 0.08, // % daily (low, rain cleaning)
    degradation: 0.6, // % annual (mild climate)
    avgPeakTemp: 50, // °C
    cleaningCostPerMW: 600,
    defaultElectricityRate: 65, // $/MWh (higher European rates)
    soilingOptimizationFactor: 240
  },
  spain: {
    name: 'Spain',
    solarHours: 1800, // Mediterranean climate
    soilingRate: 0.18, // % daily (moderate, regional variation)
    degradation: 0.8, // % annual
    avgPeakTemp: 65, // °C
    cleaningCostPerMW: 800,
    defaultElectricityRate: 58,
    soilingOptimizationFactor: 520
  },
  europe: {
    name: 'Central Europe',
    solarHours: 1200, // Average across Germany, France, etc.
    soilingRate: 0.10, // % daily
    degradation: 0.7, // % annual
    avgPeakTemp: 55, // °C
    cleaningCostPerMW: 650,
    defaultElectricityRate: 62,
    soilingOptimizationFactor: 320
  },
  africa: {
    name: 'Sub-Saharan Africa',
    solarHours: 2000, // High solar resource
    soilingRate: 0.30, // % daily (varies widely by location)
    degradation: 1.0, // % annual
    avgPeakTemp: 75, // °C
    cleaningCostPerMW: 900,
    defaultElectricityRate: 38, // Lower average rates
    soilingOptimizationFactor: 680
  }
};

/**
 * Global constants for ROI calculations
 * Conservative estimates with research backing
 */
export const ROI_CONSTANTS = {
  // Power Recovery Parameters
  POWER_RECOVERY_RATE: 0.15, // 15% of detected losses (conservative, can be 20-30%)
  DEFAULT_PLANT_EFFICIENCY: 0.85, // 85% (PR - Performance Ratio)
  LOSS_DETECTION_ACCURACY: 0.92, // 92% accuracy in fault detection

  // O&M Savings Parameters
  DIAGNOSTIC_TIME_REDUCTION: 0.50, // 50% reduction in manual diagnostic time
  DIAGNOSTIC_HOURLY_COST: 85, // $/hour for engineering time
  SITE_VISIT_REDUCTION: 0.40, // 40% reduction in truck rolls
  AVG_SITE_VISIT_COST: 600, // $ per site visit (travel + labor)
  BASELINE_DIAGNOSTIC_HOURS_PER_MW: 3.2, // hours/MW/year

  // Soiling Parameters
  SOILING_DETECTION_IMPROVEMENT: 0.25, // 25% improvement in detection
  CLEANING_FREQUENCY_REDUCTION: 0.20, // 20% fewer cleanings (optimized schedule)
  WATER_SAVINGS_LITERS_PER_MW: 48000, // liters/MW/year saved

  // Setup & Subscription (not shown in calculator, but used for internal ROI)
  SETUP_COST_BASE: 0, // $ no setup cost - cloud deployment
  SETUP_COST_PER_MW: 0, // $ no setup cost
  SUBSCRIPTION_TIERS: {
    small: { maxMW: 25, monthly: 2000 },    // 1-25 MW: $2K/month
    medium: { maxMW: 100, monthly: 4000 },  // 26-100 MW: $4K/month
    large: { maxMW: 250, monthly: 7000 },   // 101-250 MW: $7K/month
    enterprise: { maxMW: Infinity, monthly: 'custom' } // 250+ MW: Custom pricing
  },

  // Deployment type multipliers (not shown in calculator)
  DEPLOYMENT_MULTIPLIERS: {
    cloud: 1.0,      // Base price (cloud deployment)
    onpremise: 1.5,  // +50% for on-premise complexity
    hybrid: 1.3      // +30% for hybrid setup
  },

  // Calculation Assumptions
  DAYS_PER_YEAR: 365,
  HOURS_PER_YEAR: 8760,
  KW_PER_MW: 1000
};

/**
 * Get regional parameters for a specific region
 */
export function getRegionalParameters(region: Region): RegionalParameters {
  return REGIONAL_DEFAULTS[region];
}

/**
 * Get all available regions
 */
export function getAllRegions(): Region[] {
  return Object.keys(REGIONAL_DEFAULTS) as Region[];
}

/**
 * Get region display name
 */
export function getRegionDisplayName(region: Region): string {
  return REGIONAL_DEFAULTS[region].name;
}

/**
 * Calculate subscription cost (not shown in calculator, used internally)
 * Cloud deployment pricing (base rate)
 */
export function calculateSubscriptionCost(capacityMW: number, deploymentType: 'cloud' | 'onpremise' | 'hybrid' = 'cloud'): number {
  const { SUBSCRIPTION_TIERS, DEPLOYMENT_MULTIPLIERS } = ROI_CONSTANTS;

  let monthlyBase: number;

  if (capacityMW <= SUBSCRIPTION_TIERS.small.maxMW) {
    monthlyBase = SUBSCRIPTION_TIERS.small.monthly;
  } else if (capacityMW <= SUBSCRIPTION_TIERS.medium.maxMW) {
    monthlyBase = SUBSCRIPTION_TIERS.medium.monthly;
  } else if (capacityMW <= SUBSCRIPTION_TIERS.large.maxMW) {
    monthlyBase = SUBSCRIPTION_TIERS.large.monthly;
  } else {
    // Enterprise tier (250+ MW) - use large tier rate as baseline
    monthlyBase = SUBSCRIPTION_TIERS.large.monthly;
  }

  // Apply deployment multiplier
  const deploymentMultiplier = DEPLOYMENT_MULTIPLIERS[deploymentType] || 1.0;
  const monthlyTotal = monthlyBase * deploymentMultiplier;

  return monthlyTotal * 12; // Annual cost
}

/**
 * Calculate setup cost (used internally)
 * No setup cost for cloud deployment
 */
export function calculateSetupCost(capacityMW: number): number {
  // No setup cost for cloud deployment
  return 0;
}

/**
 * Get default inputs for simple mode
 */
export function getDefaultInputs(region: Region) {
  const regional = getRegionalParameters(region);
  return {
    plantCapacity: 50, // MW
    region,
    currentEfficiency: ROI_CONSTANTS.DEFAULT_PLANT_EFFICIENCY * 100, // 85%
    soilingFrequency: calculateDefaultCleaningFrequency(region),
    omCosts: calculateDefaultOMCosts(region),
    electricityRate: regional.defaultElectricityRate
  };
}

/**
 * Calculate default cleaning frequency based on region
 */
function calculateDefaultCleaningFrequency(region: Region): number {
  const regional = getRegionalParameters(region);
  // Higher soiling rate = more frequent cleaning
  // Conservative formula: cleanings per year = soilingRate * 100
  return Math.round(regional.soilingRate * 100);
}

/**
 * Calculate default O&M costs based on region
 */
function calculateDefaultOMCosts(region: Region): number {
  const regional = getRegionalParameters(region);
  // Simple baseline: cleaning costs + basic maintenance
  // $10K/MW/year baseline for low-soiling regions
  // Up to $25K/MW/year for high-soiling desert regions
  const baseCost = 10000; // $/MW/year
  const soilingMultiplier = 1 + (regional.soilingRate * 5);
  return Math.round(baseCost * soilingMultiplier);
}
