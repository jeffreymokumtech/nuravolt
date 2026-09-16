/**
 * Spanish electricity tariff configuration.
 * Based on PVPC (Precio Voluntario para el Pequeño Consumidor) average rates.
 */

export interface ElectricityTariff {
  name: string;
  country: string;
  currency: string;
  baseRate: number; // EUR/kWh
  description: string;
}

// Spanish PVPC average rate (2024-2025)
export const SPANISH_PVPC_TARIFF: ElectricityTariff = {
  name: 'Spanish PVPC',
  country: 'ES',
  currency: 'EUR',
  baseRate: 0.12, // EUR/kWh - average wholesale + grid fees
  description: 'Spanish regulated electricity price (PVPC average)',
};

// Plant metadata including installation dates for degradation calculation
export interface PlantMetadata {
  installationYear: number;
  capacityMW: number;
  country: string;
  degradationRatePerYear: number; // Typical: 0.5-0.8% per year
}

export const PLANT_METADATA: Record<string, PlantMetadata> = {
  alpha: {
    installationYear: 2019,
    capacityMW: 2.5,
    country: 'ES',
    degradationRatePerYear: 0.7, // 0.7% per year (industry standard)
  },
  eta: {
    installationYear: 2020,
    capacityMW: 3.2,
    country: 'ES',
    degradationRatePerYear: 0.65,
  },
  ribera: {
    installationYear: 2018,
    capacityMW: 4.8,
    country: 'ES',
    degradationRatePerYear: 0.75,
  },
};

// Get plant metadata with defaults for unknown plants
export function getPlantMetadata(plantId: string): PlantMetadata {
  const normalizedId = plantId.toLowerCase();
  return PLANT_METADATA[normalizedId] || {
    installationYear: 2020,
    capacityMW: 1.0,
    country: 'ES',
    degradationRatePerYear: 0.7,
  };
}

// Calculate cumulative degradation based on plant age
export function calculatePlantDegradation(plantId: string, referenceYear?: number): number {
  const metadata = getPlantMetadata(plantId);
  const currentYear = referenceYear || new Date().getFullYear();
  const plantAge = Math.max(0, currentYear - metadata.installationYear);
  // Cumulative degradation: age × rate per year
  return plantAge * metadata.degradationRatePerYear;
}

// Default tariff for the application
export const DEFAULT_TARIFF = SPANISH_PVPC_TARIFF;

// Helper to get electricity price by plant region
export function getElectricityPrice(plantId: string): number {
  // All current demo plants are in Spain
  const spanishPlants = ['alpha', 'eta', 'ribera'];

  if (spanishPlants.includes(plantId.toLowerCase())) {
    return SPANISH_PVPC_TARIFF.baseRate;
  }

  // Default to Spanish rate for unknown plants
  return DEFAULT_TARIFF.baseRate;
}

// Helper to calculate loss value in EUR
export function calculateLossValue(energyLoss_kWh: number, plantId?: string): number {
  const price = plantId ? getElectricityPrice(plantId) : DEFAULT_TARIFF.baseRate;
  return energyLoss_kWh * price;
}

// Format currency value
export function formatCurrency(value: number, currency: string = 'EUR'): string {
  return new Intl.NumberFormat('en-EU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}
