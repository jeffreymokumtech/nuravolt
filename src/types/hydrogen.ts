/**
 * Green hydrogen (electrolyzer) types — shapes returned by
 * GET /api/hydrogen/plants/[plantId].
 */

export interface H2Asset {
  id: string;
  name: string | null;
  technology: string;
  ratedPowerKw: number;
  stackCount: number | null;
  ratedKgPerH: number;
  secBolKwhPerKg: number;
  currentSecKwhPerKg: number | null;
  stackHours: number | null;
  manufacturer: string | null;
  model: string | null;
}

export interface H2ProductionDay {
  date: string; // ISO date
  energyInKwh: number;
  h2OutKg: number;
  hoursRun: number;
  avgLoadPct: number | null;
  secKwhPerKg: number;
  h2PriceEurPerKg: number | null;
  revenueEur: number | null;
  powerCostEur: number | null;
  netMarginEur: number | null;
}

export interface H2StackHealthPoint {
  date: string; // ISO date
  stackHours: number;
  secKwhPerKg: number;
  efficiencyHhvPct: number;
  estRulHours: number;
  healthPct: number;
}

export interface HydrogenPlantResponse {
  asset: H2Asset | null;
  production: H2ProductionDay[];
  stackHealth: H2StackHealthPoint[];
  _source: 'database' | 'empty';
}
