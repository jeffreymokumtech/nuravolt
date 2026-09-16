/**
 * Plant-level settings stored on Plant.metadata.settings — shared between
 * the settings API route (read/write) and the alert evaluator (read).
 * The dataSources section is also read by the Python analytics pipeline
 * (scripts/generate_per_inverter_soiling.py) to honor the operator's source
 * choices in soiling analytics runs.
 */

export const IRRADIANCE_SOURCES = ['auto', 'onsite', 'open_meteo'] as const;
export const SOILING_REFERENCES = ['auto', 'dustiq', 'inferred'] as const;

export type IrradianceSource = (typeof IRRADIANCE_SOURCES)[number];
export type SoilingReference = (typeof SOILING_REFERENCES)[number];

export const DEFAULT_SETTINGS = {
  alerts: {
    soilingLossPct: 5,
    performanceRatioPct: 75,
  },
  notifications: {
    emailCritical: true,
    emailWarning: true,
    dailySummary: true,
    weeklyCleaning: false,
  },
  dataSources: {
    irradianceSource: 'auto' as IrradianceSource,
    soilingReference: 'auto' as SoilingReference,
  },
};

export type PlantSettings = typeof DEFAULT_SETTINGS;

/** Merge whatever is stored (possibly partial/absent) over the defaults. */
export function mergeSettings(stored: unknown): PlantSettings {
  const s = (stored ?? {}) as Partial<PlantSettings>;
  const ds = { ...DEFAULT_SETTINGS.dataSources, ...(s.dataSources ?? {}) };
  // Unknown enum values (hand-edited metadata, older writers) fall back to auto.
  if (!IRRADIANCE_SOURCES.includes(ds.irradianceSource)) ds.irradianceSource = 'auto';
  if (!SOILING_REFERENCES.includes(ds.soilingReference)) ds.soilingReference = 'auto';
  return {
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(s.alerts ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications ?? {}) },
    dataSources: ds,
  };
}

/** Settings for a plant row (metadata JSON in hand). */
export function settingsFromMetadata(metadata: unknown): PlantSettings {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return mergeSettings(meta.settings);
}
