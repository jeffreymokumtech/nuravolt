/**
 * ROI Calculator Engine
 * Conservative, research-backed ROI calculations for solar PV monitoring
 * See docs/technical/ROI_ASSUMPTIONS.md for complete documentation
 */

import {
  type Region,
  getRegionalParameters,
  ROI_CONSTANTS,
  calculateSetupCost,
  calculateSubscriptionCost
} from '@/data/roiCalculator';

export interface ROIInputs {
  plantCapacity: number; // MW
  region: Region;
  currentEfficiency?: number; // % (optional, advanced mode)
  soilingFrequency?: number; // cleanings/year (optional, advanced mode)
  omCosts?: number; // $/MW/year (optional, advanced mode)
  electricityRate?: number; // $/MWh (optional, advanced mode)
}

export interface ROIResults {
  totalBenefits: number; // $ annual
  setupCost: number; // $ one-time (not shown, internal)
  annualSubscription: number; // $ annual (not shown, internal)
  totalInvestment: number; // $ (setup + first year subscription)
  roiRatio: number; // benefits / investment
  paybackMonths: number; // months to recover setup cost
  breakdown: {
    powerRecovery: number; // $ annual
    omSavings: number; // $ annual
    soilingOptimization: number; // $ annual
  };
  assumptions: Assumption[];
}

export interface Assumption {
  category: 'Regional' | 'Power Recovery' | 'O&M Savings' | 'Soiling' | 'Investment';
  parameter: string;
  value: string;
  source: string;
}

/**
 * Calculate ROI for given inputs
 * Mode: 'simple' uses defaults, 'advanced' uses all custom inputs
 */
export function calculateROI(
  inputs: ROIInputs,
  mode: 'simple' | 'advanced' = 'simple'
): ROIResults {
  const regional = getRegionalParameters(inputs.region);

  // Use defaults for simple mode, custom values for advanced
  const efficiency = mode === 'advanced' && inputs.currentEfficiency
    ? inputs.currentEfficiency / 100
    : ROI_CONSTANTS.DEFAULT_PLANT_EFFICIENCY;

  const cleaningsPerYear = mode === 'advanced' && inputs.soilingFrequency
    ? inputs.soilingFrequency
    : calculateDefaultCleaningFrequency(regional.soilingRate);

  const omCostsPerMW = mode === 'advanced' && inputs.omCosts
    ? inputs.omCosts
    : calculateDefaultOMCosts(regional);

  const electricityRate = mode === 'advanced' && inputs.electricityRate
    ? inputs.electricityRate
    : regional.defaultElectricityRate;

  // Calculate Power Recovery
  const powerRecovery = calculatePowerRecovery(
    inputs.plantCapacity,
    regional.solarHours,
    efficiency,
    electricityRate
  );

  // Calculate O&M Savings
  const omSavings = calculateOMSavings(
    inputs.plantCapacity,
    omCostsPerMW
  );

  // Calculate Soiling Optimization
  const soilingOptimization = calculateSoilingOptimization(
    inputs.plantCapacity,
    regional,
    cleaningsPerYear
  );

  // Total Benefits
  const totalBenefits = powerRecovery + omSavings + soilingOptimization;

  // Investment (not shown in calculator, but used for ROI calculation)
  const setupCost = calculateSetupCost(inputs.plantCapacity);
  const annualSubscription = calculateSubscriptionCost(inputs.plantCapacity, 'cloud'); // Cloud deployment
  const totalInvestment = annualSubscription; // No setup cost

  // ROI Metrics (Annual ROI only - no setup cost means immediate return)
  const roiRatio = totalBenefits / totalInvestment;
  const paybackMonths = 0; // No setup cost = immediate return

  // Generate assumptions
  const assumptions = generateAssumptions(
    inputs,
    regional,
    efficiency,
    cleaningsPerYear,
    omCostsPerMW,
    electricityRate,
    mode
  );

  return {
    totalBenefits,
    setupCost,
    annualSubscription,
    totalInvestment,
    roiRatio,
    paybackMonths,
    breakdown: {
      powerRecovery,
      omSavings,
      soilingOptimization
    },
    assumptions
  };
}

/**
 * Calculate annual power recovery value
 * Formula: (Plant Capacity × 1000 × Solar Hours × (1 - Efficiency) × Recovery Rate) × Electricity Rate
 */
function calculatePowerRecovery(
  capacityMW: number,
  solarHours: number,
  efficiency: number,
  electricityRate: number
): number {
  const annualGeneration = capacityMW * ROI_CONSTANTS.KW_PER_MW * solarHours; // kWh/year
  const potentialLoss = annualGeneration * (1 - efficiency); // kWh/year lost
  const recoveredEnergy = potentialLoss * ROI_CONSTANTS.POWER_RECOVERY_RATE; // kWh/year recovered
  const recoveredValue = (recoveredEnergy / ROI_CONSTANTS.KW_PER_MW) * electricityRate; // $ value

  return Math.round(recoveredValue);
}

/**
 * Calculate annual O&M savings
 * Components: Diagnostic time reduction + Site visit reduction
 */
function calculateOMSavings(
  capacityMW: number,
  omCostsPerMW: number
): number {
  // Diagnostic time savings
  const baselineDiagnosticHours = capacityMW * ROI_CONSTANTS.BASELINE_DIAGNOSTIC_HOURS_PER_MW;
  const timeSaved = baselineDiagnosticHours * ROI_CONSTANTS.DIAGNOSTIC_TIME_REDUCTION;
  const diagnosticSavings = timeSaved * ROI_CONSTANTS.DIAGNOSTIC_HOURLY_COST;

  // Site visit savings
  const baselineSiteVisits = Math.ceil(capacityMW / 10); // Assume 1 visit per 10 MW
  const visitsSaved = baselineSiteVisits * ROI_CONSTANTS.SITE_VISIT_REDUCTION;
  const siteVisitSavings = visitsSaved * ROI_CONSTANTS.AVG_SITE_VISIT_COST;

  // Total O&M savings (conservative estimate)
  const totalSavings = diagnosticSavings + siteVisitSavings;

  return Math.round(totalSavings);
}

/**
 * Calculate annual soiling optimization savings
 * Components: Optimized cleaning schedule + Water savings
 */
function calculateSoilingOptimization(
  capacityMW: number,
  regional: ReturnType<typeof getRegionalParameters>,
  cleaningsPerYear: number
): number {
  // Baseline cleaning costs
  const baselineCost = cleaningsPerYear * regional.cleaningCostPerMW * capacityMW;

  // Optimized cleaning (20% reduction in frequency, same or better output)
  const optimizedCleanings = cleaningsPerYear * (1 - ROI_CONSTANTS.CLEANING_FREQUENCY_REDUCTION);
  const optimizedCost = optimizedCleanings * regional.cleaningCostPerMW * capacityMW;

  // Cleaning cost savings
  const cleaningSavings = baselineCost - optimizedCost;

  // Additional savings from better soiling detection (avoids over-cleaning)
  const detectionImprovement = capacityMW * regional.soilingOptimizationFactor * 0.15;

  const totalSavings = cleaningSavings + detectionImprovement;

  return Math.round(totalSavings);
}

/**
 * Calculate default cleaning frequency based on soiling rate
 */
function calculateDefaultCleaningFrequency(soilingRate: number): number {
  // Higher soiling rate = more frequent cleaning
  // Conservative formula: cleanings per year = soilingRate * 100
  // E.g., 0.4% daily = 40 cleanings/year in UAE
  return Math.round(soilingRate * 100);
}

/**
 * Calculate default O&M costs based on regional parameters
 */
function calculateDefaultOMCosts(
  regional: ReturnType<typeof getRegionalParameters>
): number {
  // Baseline O&M cost varies with soiling conditions
  const baseCost = 10000; // $/MW/year
  const soilingMultiplier = 1 + (regional.soilingRate * 5);
  return Math.round(baseCost * soilingMultiplier);
}

/**
 * Generate transparent assumptions list
 */
function generateAssumptions(
  inputs: ROIInputs,
  regional: ReturnType<typeof getRegionalParameters>,
  efficiency: number,
  cleaningsPerYear: number,
  omCostsPerMW: number,
  electricityRate: number,
  mode: 'simple' | 'advanced'
): Assumption[] {
  const assumptions: Assumption[] = [];

  // Regional Parameters
  assumptions.push(
    {
      category: 'Regional',
      parameter: 'Region',
      value: regional.name,
      source: 'User selected'
    },
    {
      category: 'Regional',
      parameter: 'Annual Solar Hours',
      value: `${regional.solarHours.toLocaleString()} kWh/kW`,
      source: 'NREL Solar Resource Database'
    },
    {
      category: 'Regional',
      parameter: 'Daily Soiling Rate',
      value: `${(regional.soilingRate * 100).toFixed(2)}%`,
      source: 'IEA PVPS Task 13 (regional averages)'
    },
    {
      category: 'Regional',
      parameter: 'Electricity Rate',
      value: `$${electricityRate}/MWh`,
      source: mode === 'advanced' && inputs.electricityRate ? 'User specified' : 'Regional average (2024)'
    }
  );

  // Power Recovery Parameters
  assumptions.push(
    {
      category: 'Power Recovery',
      parameter: 'Plant Capacity',
      value: `${inputs.plantCapacity} MW`,
      source: 'User specified'
    },
    {
      category: 'Power Recovery',
      parameter: 'Current Efficiency (PR)',
      value: `${(efficiency * 100).toFixed(1)}%`,
      source: mode === 'advanced' && inputs.currentEfficiency ? 'User specified' : 'Industry average'
    },
    {
      category: 'Power Recovery',
      parameter: 'Recovery Rate',
      value: '15%',
      source: 'Conservative estimate (actual: 20-30%)'
    },
    {
      category: 'Power Recovery',
      parameter: 'Detection Accuracy',
      value: '92%',
      source: 'Internal validation data (2024)'
    }
  );

  // O&M Savings Parameters
  assumptions.push(
    {
      category: 'O&M Savings',
      parameter: 'Diagnostic Time Reduction',
      value: '50%',
      source: 'Case study average (Dutch 85MW: 65%)'
    },
    {
      category: 'O&M Savings',
      parameter: 'Site Visit Reduction',
      value: '40%',
      source: 'Case study average (remote diagnostics)'
    },
    {
      category: 'O&M Savings',
      parameter: 'Engineering Hourly Rate',
      value: '$85/hour',
      source: 'Industry average (Europe/GCC)'
    },
    {
      category: 'O&M Savings',
      parameter: 'Site Visit Cost',
      value: '$600',
      source: 'Average (travel + 4 hours labor)'
    }
  );

  // Soiling Optimization Parameters
  assumptions.push(
    {
      category: 'Soiling',
      parameter: 'Cleaning Frequency',
      value: `${cleaningsPerYear} times/year`,
      source: mode === 'advanced' && inputs.soilingFrequency ? 'User specified' : `Regional baseline (${(regional.soilingRate * 100).toFixed(1)}% daily rate)`
    },
    {
      category: 'Soiling',
      parameter: 'Cleaning Cost',
      value: `$${regional.cleaningCostPerMW}/MW per cleaning`,
      source: 'Regional market rates (2024)'
    },
    {
      category: 'Soiling',
      parameter: 'Frequency Reduction',
      value: '20%',
      source: 'Optimized scheduling (Spain case study: 32%)'
    },
    {
      category: 'Soiling',
      parameter: 'Detection Improvement',
      value: '25%',
      source: 'Physics-based soiling detection vs. manual'
    }
  );

  // Investment Parameters (not shown publicly, but documented)
  if (mode === 'advanced') {
    const setupCost = calculateSetupCost(inputs.plantCapacity);
    const subscription = calculateSubscriptionCost(inputs.plantCapacity, 'cloud');

    assumptions.push(
      {
        category: 'Investment',
        parameter: 'Setup Cost',
        value: `$${setupCost.toLocaleString()}`,
        source: 'No setup cost for cloud deployment'
      },
      {
        category: 'Investment',
        parameter: 'Annual Subscription',
        value: `$${subscription.toLocaleString()}`,
        source: 'Tiered pricing: 1-25MW: $24K, 26-100MW: $48K, 101-250MW: $84K (cloud)'
      }
    );
  }

  return assumptions;
}

/**
 * Validate inputs
 */
export function validateInputs(inputs: Partial<ROIInputs>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!inputs.plantCapacity || inputs.plantCapacity < 1) {
    errors.push('Plant capacity must be at least 1 MW');
  }
  if (inputs.plantCapacity && inputs.plantCapacity > 1000) {
    errors.push('Plant capacity must be less than 1000 MW (contact us for larger systems)');
  }
  if (!inputs.region) {
    errors.push('Region is required');
  }
  if (inputs.currentEfficiency !== undefined && (inputs.currentEfficiency < 50 || inputs.currentEfficiency > 100)) {
    errors.push('Current efficiency must be between 50% and 100%');
  }
  if (inputs.soilingFrequency !== undefined && (inputs.soilingFrequency < 0 || inputs.soilingFrequency > 365)) {
    errors.push('Soiling frequency must be between 0 and 365 cleanings per year');
  }
  if (inputs.omCosts !== undefined && inputs.omCosts < 0) {
    errors.push('O&M costs cannot be negative');
  }
  if (inputs.electricityRate !== undefined && (inputs.electricityRate < 0 || inputs.electricityRate > 500)) {
    errors.push('Electricity rate must be between $0 and $500/MWh');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
