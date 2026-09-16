/**
 * Pure anonymization functions for demo mode.
 * Strips geographic identifiers from plant names and locations.
 */

const PLANT_NAME_MAP: Record<string, string> = {
  'Nordic Wind': 'Wind Farm 1',
  'CARE Wind Portugal': 'Wind Farm 2',
};

const FULL_LOCATION_MAP: Record<string, string> = {
  'Jutland, Denmark': 'Region F',
  'Portugal': 'Region G',
};

export function anonymizePlantName(name: string): string {
  return PLANT_NAME_MAP[name] ?? name;
}

export function anonymizeLocation(location: string): string {
  if (FULL_LOCATION_MAP[location]) {
    return FULL_LOCATION_MAP[location];
  }
  const commaIndex = location.indexOf(',');
  if (commaIndex > 0) {
    return location.substring(0, commaIndex).trim();
  }
  return location;
}
