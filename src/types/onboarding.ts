export type OnboardingConnectionType =
  | 'influxdb'
  | 'sql_scada'
  | 'modbus_tcp'
  | 'sunspec'
  | 'csv_upload'
  | 'huawei_api'
  | 'sungrow_api'
  | 'sma_api'
  | 'fronius_api'
  | 'solaredge_api'
  | 'goodwe_api'
  | 'sample_api';

// Extended connection config with Sungrow/Huawei fields
export interface OnboardingConnectionConfig {
  // InfluxDB
  url?: string;
  token?: string;
  org?: string;
  bucket?: string;
  // SQL SCADA / Modbus / SunSpec
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  unit_id?: number;
  // SunSpec
  base_register?: number;
  sunspec_models?: number[];
  // Sungrow iSolarCloud
  appkey?: string;
  appsecret?: string;
  sungrow_username?: string;
  sungrow_password?: string;
  sungrow_gateway?: string;
  sungrow_plant_id?: string;
  // Huawei FusionSolar
  huawei_username?: string;
  huawei_password?: string;
  huawei_endpoint?: string;
  // CSV
  file_path?: string;
}

/**
 * Storage nameplate collected on the plant step. Structurally identical to
 * BessStorageConfig in src/components/data-hub/PlantConfigStep.tsx, which owns
 * the form; duplicated here so PlantConfig can carry the value without this
 * module importing a client component (and so the wizard's state stays typed).
 * Keep the two in sync. ConnectionWizard maps this onto BessAssetInput
 * (src/lib/plants/create.ts) when it posts to /api/plants.
 *
 * Empty string and null mean "not declared" and are dropped before the POST,
 * never sent as a value.
 */
export interface PlantStorageConfig {
  energy_capacity_mwh: number | null;
  chemistry: '' | 'LFP' | 'NMC' | 'NCA' | 'LTO';
  rack_count: number | null;
  module_count: number | null;
  manufacturer: string;
  model: string;
  installation_date: string;
  max_continuous_c_rate: number | null;
  gb: { bmu_id: string; cmu_id: string };
}

// Plant configuration from wizard Step 4
export interface PlantConfig {
  plantName: string;
  location: string;
  country: string;              // ISO 3166-1 alpha-2, e.g. 'ES'
  latitude: number;
  longitude: number;
  altitude: number;
  capacity_MW: number;
  installed_MW: number | null;
  timezone: string;
  // HYBRID is accepted by the server (AssetType in prisma/schema.prisma) even
  // though the picker only offers three options today.
  assetType: 'SOLAR' | 'WIND' | 'BESS' | 'HYBRID';
  /**
   * Battery nameplate. Only set for storage asset types. Its MWh is required
   * before a storage plant can be created: POST /api/plants rejects a
   * BESS/HYBRID plant without one, and the plant's BessAsset row is written
   * from it.
   */
  storage?: PlantStorageConfig;
}

// Inverter group from wizard Step 5
export interface InverterGroupConfig {
  groupId: string;
  name: string;
  tilt: number;
  azimuth: number;
  inverterIds: string[];
  inverterModel: string;
  inverterNominalPower_kW: number;
  mpptCount: number;
  stringsPerMppt: number;
  gammaPdc: number;
}

// Weather station and irradiance sensor configuration
export interface WeatherStationConfig {
  hasOnSiteWeatherStation: boolean;
  irradianceSensorType: 'pyranometer' | 'reference_cell' | 'none';
  sensorMountedAtTilt: boolean;
  hasDustIQSensor: boolean;
  notes: string;
}

// Data source purpose (mirrors Prisma DataSourcePurpose enum)
export type DataSourcePurpose =
  | 'INVERTER_DATA'
  | 'WEATHER_DATA'
  | 'IRRADIANCE_DATA'
  | 'SOILING_MEASUREMENT'
  | 'GRID_METERING'
  | 'SUPPLEMENTARY';

// Field mapping entry for a data source
export interface FieldMappingEntry {
  originalField: string;
  mappedType: string;
  confidence: number;
  unit?: string;
  confirmed?: boolean;
}

// A data source being configured in the wizard (multi-source support)
export interface DataSourceEntry {
  id: string;                        // client-side temp ID
  type: OnboardingConnectionType;
  name: string;
  config: OnboardingConnectionConfig;
  connectionId: string | null;
  discovery: EnhancedDiscoveryResult | null;
  purpose: DataSourcePurpose;
  provides_metrics: string[];
  fieldMappings: FieldMappingEntry[];
  /** True when this entry reuses an already-tested DataConnection — the
   *  wizard skips Configure/Test/Discover for it. */
  existing?: boolean;
  /** Set once this source's connection test succeeded (gates step advance). */
  testSuccess?: boolean;
}

// Discovered inverter from Step 3
export interface DiscoveredInverter {
  id: string;
  name?: string;              // device_name from API (e.g., "INV-A01")
  model: string;
  nominalPower_kW: number;
  mpptCount: number;
  stringsPerMppt: number;
  deviceType?: 'inverter' | 'hybrid_inverter' | 'battery' | 'logger' | 'weather_station' | 'meter';
  groupHint?: string;         // pre-configured group from monitoring platform
}

// Enhanced discovery result with MPPT/string structure
export interface EnhancedDiscoveryResult {
  status: 'completed' | 'in_progress' | 'failed';
  plants?: Array<{
    id: string;
    name: string;
    capacity_mw?: number;
    inverters?: DiscoveredInverter[];
  }>;
  fieldMappings?: Array<{
    originalField: string;
    mappedType: string;
    confidence: number;
    unit?: string;
  }>;
  recommendations?: string[];
  error?: string;
}

// Full onboarding result persisted to localStorage
export interface OnboardedPlant {
  plantId: string;
  plantName: string;
  assetType: 'SOLAR' | 'WIND' | 'BESS';
  location: string;
  latitude: number;
  longitude: number;
  altitude: number;
  capacity_MW: number;
  installed_MW: number | null;
  timezone: string;
  totalInverters: number;
  inverterGroups: string[];
  inverterGroupDetails: InverterGroupConfig[];
  connectionType: OnboardingConnectionType;
  connectionName: string;
  weatherStation: WeatherStationConfig;
  status: 'operational';
  createdAt: string;
  healthDistribution: {
    normal: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
  metrics: {
    avgR2: number | null;
    avgMAE_kW: number | null;
    soilingRatio: number | null;
    healthScore: number | null;
  };
  dataRange: { start: string; end: string } | null;
  lastUpdated: string;
}
