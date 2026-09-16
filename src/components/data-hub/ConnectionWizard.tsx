'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  X,
  Database,
  Server,
  Upload,
  Cloud,
  Cpu,
  Sun,
  Zap,
  ChevronRight,
  ChevronLeft,
  Check,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Settings2,
  FlaskConical,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import FieldMapper from './FieldMapper';
import RegisterMapUploader from './RegisterMapUploader';
import PlantConfigStep from './PlantConfigStep';
import InverterGroupStep from './InverterGroupStep';
import DataSourceSelector from './DataSourceSelector';
import { vendorAvailability, AVAILABILITY_BADGE } from './vendor-availability';
import type { OnboardingConnectionType } from '@/types/onboarding';
import DeviceMatchStep, { type DeviceMatch } from './DeviceMatchStep';
import {
  PlantConfig,
  PlantStorageConfig,
  InverterGroupConfig,
  DiscoveredInverter,
  OnboardedPlant,
  WeatherStationConfig,
  DataSourceEntry,
} from '@/types/onboarding';
import { autoGroupInverters, type AutoGroupSuggestion } from '@/utils/autoGroupInverters';
import {
  FULL_ONBOARDING_STEPS,
  CONNECTION_ONLY_STEPS,
  prevStep,
  stepDescription,
  type WizardSnapshot,
} from './wizard-steps';
import WizardStepIndicator from './WizardStepIndicator';
import { useWizardDraft, type WizardDraft } from './useWizardDraft';

interface Props {
  onClose: () => void;
  onComplete: (plant?: OnboardedPlant) => void;
  mode?: 'full-onboarding' | 'connection-only';
  /**
   * Demo surfaces set this to fabricate success when the API is unavailable.
   * Real customers (default) must see honest errors, never fake completions.
   */
  allowDemoFallback?: boolean;
  /**
   * Pre-select an existing DataConnection as a reused data source
   * (deep-linked from ConnectionsManager's "Onboard plant" action).
   */
  initialConnectionId?: string;
}

type ConnectionType =
  | 'influxdb' | 'sql_scada' | 'modbus_tcp' | 'sunspec' | 'csv_upload'
  | 'huawei_api' | 'sungrow_api' | 'sma_api' | 'fronius_api'
  | 'solaredge_api' | 'goodwe_api';

interface ConnectionConfig {
  url?: string;
  token?: string;
  org?: string;
  bucket?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  unit_id?: number;
  // SunSpec
  base_register?: number;
  // Huawei / Sungrow
  appkey?: string;
  appsecret?: string;
  sungrow_username?: string;
  sungrow_password?: string;
  sungrow_gateway?: string;
  sungrow_plant_id?: string;
  huawei_username?: string;
  huawei_password?: string;
  huawei_endpoint?: string;
  // SMA / Fronius / SolarEdge / GoodWe cloud APIs
  api_key?: string;
  client_id?: string;
  client_secret?: string;
  account_email?: string;
  account_password?: string;
  site_id?: string;
  // Modbus manufacturer register-map preset
  manufacturer_preset?: string;
  // CSV
  file_path?: string;
}

// Manufacturer register-map presets for direct Modbus TCP. Selecting one
// pre-fills port/unit-id and tells the poller which register map to use, so
// users never have to type raw register addresses for known inverter brands.
const MODBUS_PRESETS: Array<{
  id: string;
  label: string;
  port: number;
  unitId: number;
  registers: string[];
  note: string;
}> = [
  {
    id: 'generic',
    label: 'Generic / custom map',
    port: 502,
    unitId: 1,
    registers: [],
    note: 'Registers are configured during field mapping.',
  },
  {
    id: 'sma',
    label: 'SMA (Sunny Tripower / Core)',
    port: 502,
    unitId: 3,
    registers: ['P_AC @30775', 'E_total @30529', 'V_DC @30771', 'I_DC @30769', 'Temp @30953'],
    note: 'SMA Modbus profile, 32-bit big-endian. Enable Modbus TCP in the device webUI first.',
  },
  {
    id: 'fronius',
    label: 'Fronius (Symo / Tauro)',
    port: 502,
    unitId: 1,
    registers: ['SunSpec 40070+', 'P_AC @40092', 'E_total @40094', 'MPPT 160 @40254'],
    note: 'Fronius exposes the SunSpec map, float mode assumed (set in Datamanager).',
  },
  {
    id: 'solaredge',
    label: 'SolarEdge (SE series)',
    port: 1502,
    unitId: 1,
    registers: ['SunSpec 40000+', 'P_AC @40083', 'E_total @40093', 'DC power @40100'],
    note: 'SolarEdge uses port 1502; enable Modbus TCP via the SetApp interface.',
  },
  {
    id: 'huawei',
    label: 'Huawei (SUN2000)',
    port: 502,
    unitId: 1,
    registers: ['P_AC @32080', 'E_total @32106', 'PV strings @32016+', 'Temp @32087'],
    note: 'SUN2000 register map; connect via the SDongle or plant-level SmartLogger.',
  },
  {
    id: 'sungrow',
    label: 'Sungrow (SG series)',
    port: 502,
    unitId: 1,
    registers: ['P_AC @5031', 'E_total @5004', 'MPPT V/I @5011+', 'Temp @5008'],
    note: 'Sungrow string-inverter map (read input registers, function code 04).',
  },
  {
    id: 'goodwe',
    label: 'GoodWe (GW series)',
    port: 502,
    unitId: 247,
    registers: ['P_AC @35105', 'E_total @35191', 'V_DC @35103', 'Temp @35174'],
    note: 'GoodWe ET/MT map; default unit id 247 on the Ezlogger.',
  },
];

const SUNGROW_GATEWAYS = [
  { label: 'International', value: 'https://gateway.isolarcloud.com' },
  { label: 'Europe', value: 'https://gateway.isolarcloud.eu' },
  { label: 'Australia', value: 'https://augateway.isolarcloud.com' },
  { label: 'China', value: 'https://gateway.isolarcloud.com.cn' },
  { label: 'India', value: 'https://ingateway.isolarcloud.com' },
];

const HUAWEI_ENDPOINTS = [
  { label: 'Europe (Germany)', value: 'https://eu5.fusionsolar.huawei.com' },
  { label: 'Europe (Netherlands)', value: 'https://region01eu5.fusionsolar.huawei.com' },
  { label: 'Asia-Pacific', value: 'https://sg5.fusionsolar.huawei.com' },
  { label: 'Middle East & Africa', value: 'https://me5.fusionsolar.huawei.com' },
  { label: 'Latin America', value: 'https://la5.fusionsolar.huawei.com' },
];

interface DiscoveryResult {
  status: 'completed' | 'in_progress' | 'failed';
  plants?: Array<{ id: string; name: string; capacity_mw?: number }>;
  fieldMappings?: Array<{
    originalField: string;
    mappedType: string;
    confidence: number;
    unit?: string;
  }>;
  /** Device-level tags found on the source, matched to equipment in the
   *  Match Devices step. */
  deviceTags?: string[];
  recommendations?: string[];
  error?: string;
}

// Required-credential fields per connection type. Gates the Test button so
// users get inline feedback ("Missing: Host, Port") instead of a cryptic
// failure deep in the test path.
const REQUIRED_FIELDS: Record<ConnectionType, Array<{ key: keyof ConnectionConfig; label: string }>> = {
  influxdb: [
    { key: 'url', label: 'URL' },
    { key: 'token', label: 'API token' },
    { key: 'org', label: 'Organization' },
    { key: 'bucket', label: 'Bucket' },
  ],
  sql_scada: [
    { key: 'host', label: 'Host' },
    { key: 'database', label: 'Database' },
    { key: 'username', label: 'Username' },
  ],
  modbus_tcp: [
    { key: 'host', label: 'Host' },
    { key: 'port', label: 'Port' },
  ],
  sunspec: [
    { key: 'host', label: 'Host' },
    { key: 'port', label: 'Port' },
  ],
  csv_upload: [],
  huawei_api: [
    { key: 'huawei_username', label: 'Username' },
    { key: 'huawei_password', label: 'Password' },
    { key: 'huawei_endpoint', label: 'Endpoint' },
  ],
  sungrow_api: [
    { key: 'appkey', label: 'App key' },
    { key: 'appsecret', label: 'App secret' },
    { key: 'sungrow_username', label: 'Username' },
    { key: 'sungrow_password', label: 'Password' },
  ],
  sma_api: [
    { key: 'client_id', label: 'Client ID' },
    { key: 'client_secret', label: 'Client secret' },
  ],
  fronius_api: [
    { key: 'api_key', label: 'Access key ID' },
    { key: 'client_secret', label: 'Access key value' },
  ],
  solaredge_api: [
    { key: 'api_key', label: 'API key' },
    { key: 'site_id', label: 'Site ID' },
  ],
  goodwe_api: [
    { key: 'account_email', label: 'Account email' },
    { key: 'account_password', label: 'Password' },
  ],
};

/**
 * Map the wizard's vendor-prefixed credential keys onto the canonical keys the
 * backend + connector services expect. Historically the Huawei card collected
 * `huawei_username`/`huawei_password`/`huawei_endpoint` but the API validated
 * `username`/`password` and the connector read `baseUrl` — so real Huawei
 * connects 400'd on a key mismatch. Normalize here (keeping the originals too,
 * so nothing else that reads them breaks).
 */
function normalizeConfigForApi(type: ConnectionType | null, cfg: ConnectionConfig): ConnectionConfig {
  if (type === 'huawei_api') {
    return {
      ...cfg,
      username: cfg.username ?? (cfg as any).huawei_username,
      password: cfg.password ?? (cfg as any).huawei_password,
      baseUrl: (cfg as any).baseUrl ?? (cfg as any).huawei_endpoint,
    };
  }
  return cfg;
}

/**
 * Wizard storage block → the `storage` (BessAssetInput) shape POST /api/plants
 * expects, see src/lib/plants/create.ts. The form uses '' and null as "not
 * declared" sentinels, and '' is not a valid BessChemistry, so undeclared
 * fields are dropped rather than sent as a value. Nothing is inferred here: an
 * undeclared nameplate stays undeclared and the server then creates the plant
 * without a BessAsset instead of inventing one.
 */
function storagePayload(s: PlantStorageConfig | undefined) {
  if (!s) return undefined;
  const gb = {
    ...(s.gb?.bmu_id?.trim() ? { bmu_id: s.gb.bmu_id.trim() } : {}),
    ...(s.gb?.cmu_id?.trim() ? { cmu_id: s.gb.cmu_id.trim() } : {}),
  };
  return {
    energy_capacity_mwh: s.energy_capacity_mwh ?? undefined,
    chemistry: s.chemistry || undefined,
    rack_count: s.rack_count ?? undefined,
    module_count: s.module_count ?? undefined,
    manufacturer: s.manufacturer?.trim() || undefined,
    model: s.model?.trim() || undefined,
    installation_date: s.installation_date || undefined,
    max_continuous_c_rate: s.max_continuous_c_rate ?? undefined,
    ...(Object.keys(gb).length > 0 ? { gb } : {}),
  };
}

function missingRequiredFields(type: ConnectionType | null, cfg: ConnectionConfig): string[] {
  if (!type) return [];
  return (REQUIRED_FIELDS[type] ?? [])
    .filter(({ key }) => {
      const v = cfg[key];
      return v === undefined || v === null || String(v).trim() === '';
    })
    .map(({ label }) => label);
}

const CONNECTION_TYPES = [
  { id: 'influxdb' as ConnectionType, name: 'InfluxDB', description: 'Time-series database for metrics and monitoring', icon: Database, color: 'text-purple-600', bgColor: 'bg-purple-100' },
  { id: 'sql_scada' as ConnectionType, name: 'SQL SCADA', description: 'SQL Server based SCADA systems', icon: Server, color: 'text-blue-600', bgColor: 'bg-blue-100' },
  { id: 'modbus_tcp' as ConnectionType, name: 'Modbus TCP', description: 'Direct Modbus TCP/IP connection', icon: Cpu, color: 'text-green-600', bgColor: 'bg-green-100' },
  { id: 'sunspec' as ConnectionType, name: 'SunSpec', description: 'SunSpec Modbus standard for solar inverters', icon: Zap, color: 'text-yellow-600', bgColor: 'bg-yellow-100' },
  { id: 'csv_upload' as ConnectionType, name: 'CSV Upload', description: 'Upload CSV files with historical data', icon: Upload, color: 'text-orange-600', bgColor: 'bg-orange-100' },
  { id: 'huawei_api' as ConnectionType, name: 'Huawei FusionSolar', description: 'Huawei NorthBound API integration', icon: Cloud, color: 'text-red-600', bgColor: 'bg-red-100' },
  { id: 'sungrow_api' as ConnectionType, name: 'Sungrow iSolarCloud', description: 'Sungrow iSolarCloud API integration', icon: Sun, color: 'text-amber-600', bgColor: 'bg-amber-100' },
  { id: 'sma_api' as ConnectionType, name: 'SMA Sunny Portal', description: 'SMA ennexOS / Sunny Portal API', icon: Cloud, color: 'text-rose-600', bgColor: 'bg-rose-100' },
  { id: 'fronius_api' as ConnectionType, name: 'Fronius Solar.web', description: 'Fronius Solar.web API integration', icon: Cloud, color: 'text-orange-600', bgColor: 'bg-orange-100' },
  { id: 'solaredge_api' as ConnectionType, name: 'SolarEdge Monitoring', description: 'SolarEdge monitoring API', icon: Cloud, color: 'text-emerald-600', bgColor: 'bg-emerald-100' },
  { id: 'goodwe_api' as ConnectionType, name: 'GoodWe SEMS', description: 'GoodWe SEMS Portal API', icon: Cloud, color: 'text-sky-600', bgColor: 'bg-sky-100' },
];

// Demo discovery data
const DEMO_DISCOVERY: DiscoveryResult = {
  status: 'completed',
  plants: [
    { id: 'plant-1', name: 'Solar Plant Alpha', capacity_mw: 5.5 },
    { id: 'plant-2', name: 'Solar Plant Beta', capacity_mw: 3.2 },
  ],
  fieldMappings: [
    { originalField: 'Power_AC (kW)', mappedType: 'power_ac', confidence: 95, unit: 'kW' },
    { originalField: 'Irradiance_POA (W/m2)', mappedType: 'irradiance_poa', confidence: 92, unit: 'W/m²' },
    { originalField: 'Temp_Module (C)', mappedType: 'temp_module', confidence: 90, unit: '°C' },
    { originalField: 'Temp_Ambient (C)', mappedType: 'temp_ambient', confidence: 88, unit: '°C' },
    { originalField: 'Energy_Total (kWh)', mappedType: 'energy_total', confidence: 85, unit: 'kWh' },
    { originalField: 'Voltage_AC (V)', mappedType: 'voltage_ac', confidence: 82, unit: 'V' },
    { originalField: 'Current_AC (A)', mappedType: 'current_ac', confidence: 80, unit: 'A' },
    { originalField: 'Wind_Speed', mappedType: 'wind_speed', confidence: 65, unit: 'm/s' },
    { originalField: 'Unknown_Metric_1', mappedType: 'unmapped', confidence: 25 },
  ],
  deviceTags: [
    'PLC01.INV_A01.P_AC',
    'PLC01.INV_A02.P_AC',
    'PLC01.INV_A03.P_AC',
    'PLC01.INV_B01.P_AC',
    'PLC01.INV_B02.P_AC',
    'PLC02.CT1_INV01',
    'PLC02.CT1_INV02',
    'WS01.POA_IRRAD',
  ],
  recommendations: [
    'High confidence mapping detected for core power metrics',
    'Review wind speed mapping - column name ambiguous',
    '1 field could not be auto-mapped',
  ],
};

const SUNGROW_DEMO_INVERTERS: DiscoveredInverter[] = [
  // PV string inverters
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `SG50CX-${String(i + 1).padStart(2, '0')}`,
    name: `INV-${i < 10 ? 'A' : 'B'}${String((i % 10) + 1).padStart(2, '0')}`,
    model: 'Sungrow SG50CX',
    nominalPower_kW: 50,
    mpptCount: 6,
    stringsPerMppt: 2,
    deviceType: 'inverter' as const,
  })),
  // Hybrid inverter (PV + battery management)
  {
    id: 'SH10RT-01',
    name: 'HYB-01',
    model: 'Sungrow SH10RT',
    nominalPower_kW: 10,
    mpptCount: 2,
    stringsPerMppt: 1,
    deviceType: 'hybrid_inverter' as const,
  },
  // Battery storage unit
  {
    id: 'SBR096-01',
    name: 'BAT-01',
    model: 'Sungrow SBR096 (9.6kWh LFP)',
    nominalPower_kW: 9.6,
    mpptCount: 0,
    stringsPerMppt: 0,
    deviceType: 'battery' as const,
  },
];

const SUNGROW_DEMO_DISCOVERY: DiscoveryResult = {
  status: 'completed',
  plants: [{ id: 'theta', name: 'BCN Rooftop 1MW + 9.6kWh BESS', capacity_mw: 1.01 }],
  fieldMappings: [
    // PV metrics
    { originalField: 'p_ac (kW)', mappedType: 'power_ac', confidence: 96, unit: 'kW' },
    { originalField: 'e_total (kWh)', mappedType: 'energy_total', confidence: 94, unit: 'kWh' },
    { originalField: 'poa_irradiance (W/m²)', mappedType: 'irradiance_poa', confidence: 92, unit: 'W/m²' },
    { originalField: 'temp_module (°C)', mappedType: 'temp_module', confidence: 91, unit: '°C' },
    { originalField: 'temp_ambient (°C)', mappedType: 'temp_ambient', confidence: 89, unit: '°C' },
    { originalField: 'v_mppt (V)', mappedType: 'voltage_dc', confidence: 87, unit: 'V' },
    { originalField: 'i_mppt (A)', mappedType: 'current_dc', confidence: 85, unit: 'A' },
    { originalField: 'v_ac (V)', mappedType: 'voltage_ac', confidence: 83, unit: 'V' },
    { originalField: 'pr (%)', mappedType: 'performance_ratio', confidence: 80, unit: '%' },
    // Battery metrics (from hybrid inverter / BMS)
    { originalField: 'battery_soc (%)', mappedType: 'battery_soc', confidence: 95, unit: '%' },
    { originalField: 'battery_soh (%)', mappedType: 'battery_soh', confidence: 93, unit: '%' },
    { originalField: 'battery_power (kW)', mappedType: 'battery_power', confidence: 94, unit: 'kW' },
    { originalField: 'battery_voltage (V)', mappedType: 'battery_voltage', confidence: 91, unit: 'V' },
    { originalField: 'battery_temp (°C)', mappedType: 'battery_temp', confidence: 90, unit: '°C' },
  ],
  deviceTags: SUNGROW_DEMO_INVERTERS.map((inv) => `iSC.${inv.id}`),
  recommendations: [
    '20 Sungrow SG50CX inverters discovered (1,000 kWp PV)',
    '1 Sungrow SH10RT hybrid inverter with SBR096 battery (9.6 kWh LFP)',
    'String-level monitoring available (6 MPPT × 2 strings per inverter)',
    'Battery SoC/SoH/power monitoring via hybrid inverter BMS',
    'High confidence mapping for all core PV + battery metrics',
  ],
};

// ─── Component ───────────────────────────────────────────────────────────
// Step definitions + gating live in ./wizard-steps.ts (the state machine that
// makes the step indicator clickable and Back/Next skip-aware).

export default function ConnectionWizard({ onClose, onComplete, mode = 'full-onboarding', allowDemoFallback = false, initialConnectionId }: Props) {
  const isFullOnboarding = mode === 'full-onboarding';
  const steps = isFullOnboarding ? FULL_ONBOARDING_STEPS : CONNECTION_ONLY_STEPS;
  const confirmStep = isFullOnboarding ? 8 : 5;
  const mapFieldsStep = isFullOnboarding ? 7 : 4;

  const [currentStep, setCurrentStep] = useState(1);
  const [visited, setVisited] = useState<Set<number>>(new Set([1]));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  // ── Plant config (full-onboarding step 1) ──
  const [plantConfig, setPlantConfig] = useState<PlantConfig>({
    plantName: '',
    location: '',
    country: 'ES',
    latitude: 0,
    longitude: 0,
    altitude: 0,
    capacity_MW: 0,
    installed_MW: null,
    timezone: 'Europe/Madrid',
    assetType: 'SOLAR',
  });

  // Storage assets carry a battery nameplate (PlantConfigStep collects it) and
  // cannot be created without its MWh. PV and wind have no storage block.
  const isStorageAsset =
    plantConfig.assetType === 'BESS' || plantConfig.assetType === 'HYBRID';

  // ── Equipment (full-onboarding step 2) ──
  const [inverterGroups, setInverterGroups] = useState<InverterGroupConfig[]>([]);
  const [discoveredInverters, setDiscoveredInverters] = useState<DiscoveredInverter[]>([]);
  const [weatherStation, setWeatherStation] = useState<WeatherStationConfig>({
    hasOnSiteWeatherStation: false,
    irradianceSensorType: 'none',
    sensorMountedAtTilt: false,
    hasDustIQSensor: false,
    notes: '',
  });
  const [skipEquipment, setSkipEquipment] = useState(false);
  const [autoGroupSuggestion, setAutoGroupSuggestion] = useState<AutoGroupSuggestion | null>(null);

  // ── Data Sources (full-onboarding step 3, multi-source) ──
  const [dataSources, setDataSources] = useState<DataSourceEntry[]>([]);
  const [skipDataSources, setSkipDataSources] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  // Sandbox path: the user chose "Try with sample data" instead of a real
  // source. We skip the credential/discover steps and, after the plant is
  // created, generate a synthetic inverter feed via /sample-feed.
  const [sampleMode, setSampleMode] = useState(false);

  // ── Connection-only mode state ──
  const [connectionName, setConnectionName] = useState('');
  const [selectedType, setSelectedType] = useState<ConnectionType | null>(null);
  const [config, setConfig] = useState<ConnectionConfig>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  // FieldMapper edits, captured so confirmMappings persists the user's
  // overrides instead of posting an empty array (the old behaviour).
  const [editedMappings, setEditedMappings] = useState<any[]>([]);

  // ── Device-name matching (full onboarding step 6) ──
  const [deviceMatches, setDeviceMatches] = useState<Record<string, DeviceMatch>>({});

  // ── Starter report (full onboarding confirm step) ──
  const [createStarterReport, setCreateStarterReport] = useState(true);
  const router = useRouter();

  const equipmentIds = (): string[] => {
    const fromGroups = inverterGroups.flatMap((g) => g.inverterIds);
    if (fromGroups.length > 0) return fromGroups;
    return discoveredInverters.map((i) => i.id);
  };

  const hasDeviceMatching = (): boolean => {
    const disc = getActiveDiscovery();
    return Boolean(disc?.deviceTags && disc.deviceTags.length > 0 && equipmentIds().length > 0);
  };

  // ── Active source accessors (for multi-source flow) ──
  const activeSource = dataSources[activeSourceIndex] || null;

  // First plant reported by any source's discovery — used to prefill/hint the
  // plant-config step so vendor-known data never has to be retyped.
  const firstDiscoveredPlant = dataSources.flatMap(
    ds => ((ds.discovery as any)?.plants ?? []) as Array<{ name?: string; capacity_mw?: number }>
  )[0];

  const getActiveType = (): ConnectionType | null => {
    if (!isFullOnboarding) return selectedType;
    return activeSource?.type || null;
  };

  const getActiveConfig = (): ConnectionConfig => {
    if (!isFullOnboarding) return config;
    return (activeSource?.config || {}) as ConnectionConfig;
  };

  const setActiveConfig = (newConfig: ConnectionConfig) => {
    if (!isFullOnboarding) {
      setConfig(newConfig);
      return;
    }
    setDataSources(prev => prev.map((ds, i) =>
      i === activeSourceIndex ? { ...ds, config: newConfig } : ds
    ));
  };

  const getActiveConnectionId = (): string | null => {
    if (!isFullOnboarding) return connectionId;
    return activeSource?.connectionId || null;
  };

  const getActiveDiscovery = (): DiscoveryResult | null => {
    if (!isFullOnboarding) return discovery;
    return (activeSource?.discovery as DiscoveryResult | null) || null;
  };

  const getActiveConnectionName = (): string => {
    if (!isFullOnboarding) return connectionName;
    return activeSource?.name || '';
  };

  // ── Step state machine wiring (non-linear navigation) ──

  const snapshot: WizardSnapshot = useMemo(
    () => ({
      mode,
      plantName: plantConfig.plantName,
      capacityMw: plantConfig.capacity_MW,
      // Asset type and storage energy travel together: step 1 is only complete
      // for a storage plant once its MWh nameplate is declared, and the step
      // labels read as racks and BMS rather than inverters and sensors.
      assetType: plantConfig.assetType,
      energyCapacityMwh: plantConfig.storage?.energy_capacity_mwh ?? null,
      dataSources,
      skipDataSources,
      sampleMode,
      hasDeviceMatching: hasDeviceMatching(),
      selectedType,
      connectionName,
      connectionId,
      testSucceeded: Boolean(testResult?.success),
      discoveryStatus: discovery?.status ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, plantConfig, dataSources, skipDataSources, sampleMode, selectedType,
     connectionName, connectionId, testResult, discovery, inverterGroups, discoveredInverters],
  );

  // Every step the user lands on becomes re-enterable via the indicator.
  useEffect(() => {
    setVisited(prev => (prev.has(currentStep) ? prev : new Set(prev).add(currentStep)));
  }, [currentStep]);

  // Programmatic transitions (footer buttons, skip handlers) — unguarded on
  // purpose: they often run right after a state update the snapshot hasn't
  // caught up with. The step indicator guards its own clicks via canEnterStep.
  const goToStep = (id: number) => setCurrentStep(id);

  const goBack = () => {
    if (currentStep === 1) {
      onClose();
      return;
    }
    // Multi-source back-tracking: from a later source's Configure, return to
    // the previous source's mapping review.
    if (isFullOnboarding && currentStep === 4 && activeSourceIndex > 0) {
      setActiveSourceIndex(prev => prev - 1);
      setCurrentStep(mapFieldsStep);
      return;
    }
    // Returning to the source picker from Confirm clears the sample/skip
    // choice so the user can pick a real source cleanly.
    if (isFullOnboarding && currentStep === confirmStep && (skipDataSources || sampleMode)) {
      setSampleMode(false);
      setSkipDataSources(false);
      setCurrentStep(3);
      return;
    }
    const prev = prevStep(steps, currentStep, snapshot);
    if (prev === 0) onClose();
    else setCurrentStep(prev);
  };

  // The active source changed → any test banner belongs to the previous one.
  useEffect(() => {
    setTestResult(null);
  }, [activeSourceIndex]);

  // ── Draft persistence (refresh-proof wizard) ──

  const { draft, save: saveDraft, clear: clearDraft } = useWizardDraft(
    isFullOnboarding ? 'full' : 'connection',
    !allowDemoFallback,
  );
  const [draftHandled, setDraftHandled] = useState(false);

  const hydrateDraft = (d: WizardDraft) => {
    setPlantConfig(d.plantConfig ?? plantConfig);
    setInverterGroups(d.inverterGroups ?? []);
    setDiscoveredInverters(d.discoveredInverters ?? []);
    if (d.weatherStation) setWeatherStation(d.weatherStation);
    setSkipEquipment(Boolean(d.skipEquipment));
    setDataSources(d.dataSources ?? []);
    setSkipDataSources(Boolean(d.skipDataSources));
    setSampleMode(Boolean(d.sampleMode));
    setDeviceMatches(d.deviceMatches ?? {});
    setCreateStarterReport(d.createStarterReport ?? true);
    setConnectionName(d.connectionName ?? '');
    setSelectedType((d.selectedType as ConnectionType | null) ?? null);
    setConfig(d.config ?? {});
    setConnectionId(d.connectionId ?? null);
    setActiveSourceIndex(d.activeSourceIndex ?? 0);
    setVisited(new Set(d.visited ?? [1]));
    setCurrentStep(d.currentStep ?? 1);
    setDraftHandled(true);
    // Drop draft entries whose connection was deleted since the draft was
    // saved (reused entries vanish; created ones reset to unconfigured).
    fetch('/api/connections?page_size=100')
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (!json?.data) return;
        const ids = new Set((json.data as Array<{ id: string }>).map(c => c.id));
        setDataSources(prev =>
          prev.flatMap(ds => {
            if (!ds.connectionId || ids.has(ds.connectionId) || ds.connectionId.startsWith('demo-')) return [ds];
            if (ds.existing) return [];
            return [{ ...ds, connectionId: null, testSuccess: false, discovery: null }];
          }),
        );
      })
      .catch(() => {});
  };

  // Autosave (debounced in the hook). Held back while the resume banner is
  // pending so we don't clobber the stored draft with pristine state.
  const isDirty =
    currentStep > 1 ||
    Boolean(plantConfig.plantName) ||
    dataSources.length > 0 ||
    Boolean(selectedType) ||
    Boolean(connectionName);
  useEffect(() => {
    if (draft && !draftHandled) return;
    if (!isDirty) return;
    saveDraft({
      currentStep,
      visited: Array.from(visited),
      activeSourceIndex,
      plantConfig,
      inverterGroups,
      discoveredInverters,
      weatherStation,
      skipEquipment,
      dataSources,
      skipDataSources,
      sampleMode,
      deviceMatches,
      createStarterReport,
      connectionName,
      selectedType,
      config,
      connectionId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, visited, activeSourceIndex, plantConfig, inverterGroups, discoveredInverters,
      weatherStation, skipEquipment, dataSources, skipDataSources, sampleMode, deviceMatches,
      createStarterReport, connectionName, selectedType, config, connectionId, draftHandled]);

  // ── Reused-connection support ──

  /** Load persisted field mappings for reused connections (review in step 7). */
  const loadMappingsForExistingSources = async (): Promise<void> => {
    const updated = await Promise.all(
      dataSources.map(async ds => {
        if (!ds.existing || !ds.connectionId || ds.fieldMappings.length > 0) return ds;
        try {
          const res = await fetch(`/api/connections/${ds.connectionId}/mappings`);
          if (!res.ok) return ds;
          const json = await res.json();
          const mappings = (json.data?.mappings ?? []).map((m: any) => ({
            originalField: m.original_field,
            mappedType: m.mapped_field,
            confidence: Math.round(Number(m.confidence_score ?? 0) * 100),
            unit: m.unit ?? undefined,
            confirmed: Boolean(m.is_confirmed),
          }));
          return { ...ds, fieldMappings: mappings };
        } catch {
          return ds;
        }
      }),
    );
    setDataSources(updated);
  };

  /** Step-3 Next: configure the first new source, or — when every source is a
   *  reused connection — jump straight to mapping review. */
  const handleConfigureSources = async () => {
    const firstNewIdx = dataSources.findIndex(ds => !ds.existing);
    if (firstNewIdx >= 0) {
      setActiveSourceIndex(firstNewIdx);
      goToStep(4);
      return;
    }
    await loadMappingsForExistingSources();
    setActiveSourceIndex(0);
    goToStep(mapFieldsStep);
  };

  // Deep link from ConnectionsManager: seed the wizard with an existing
  // connection as a reused data source (plant details still come first).
  useEffect(() => {
    if (!initialConnectionId || !isFullOnboarding) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/connections/${initialConnectionId}`);
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const conn = json.data;
        if (!conn?.id) return;
        setDataSources(prev => {
          if (prev.some(ds => ds.connectionId === conn.id)) return prev;
          return [
            ...prev,
            {
              id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
              type: conn.type,
              name: conn.name,
              config: {},
              connectionId: conn.id,
              discovery: null,
              purpose: prev.length === 0 ? 'INVERTER_DATA' : 'SUPPLEMENTARY',
              provides_metrics: [],
              fieldMappings: [],
              existing: true,
              testSuccess: true,
            },
          ];
        });
      } catch {
        /* connection unavailable — the picker still works normally */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConnectionId]);

  // ── Connection Management ──

  const createConnection = async (type: ConnectionType, name: string, cfg: ConnectionConfig): Promise<string> => {
    try {
      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, config: normalizeConfigForApi(type, cfg) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.detail || body?.error || `Failed to create connection (HTTP ${response.status})`
        );
      }
      const data = await response.json();
      return data.data.id;
    } catch (err) {
      if (allowDemoFallback) {
        console.log('API unavailable, using demo mode');
        setIsDemo(true);
        return `demo-${Date.now()}`;
      }
      throw err instanceof Error ? err : new Error('Failed to create connection');
    }
  };

  /**
   * Resolve the active connection id, creating the connection first if it
   * doesn't exist yet (the register-map uploader needs a persisted
   * connection before the Test/Discover steps run).
   */
  const ensureActiveConnectionId = async (): Promise<string | null> => {
    const existing = getActiveConnectionId();
    if (existing) return existing;
    const type = getActiveType();
    if (!type) return null;
    let connId: string;
    try {
      connId = await createConnection(
        type,
        getActiveConnectionName() || 'Modbus connection',
        getActiveConfig()
      );
    } catch {
      return null;
    }
    if (isFullOnboarding) {
      setDataSources(prev => prev.map((ds, i) =>
        i === activeSourceIndex ? { ...ds, connectionId: connId } : ds
      ));
    } else {
      setConnectionId(connId);
    }
    return connId;
  };

  /** Record a passing test on the active source (gates the Continue button). */
  const markActiveTestSuccess = () => {
    if (!isFullOnboarding) return;
    setDataSources(prev => prev.map((ds, i) =>
      i === activeSourceIndex ? { ...ds, testSuccess: true } : ds
    ));
  };

  // No auto-advance on success: the banner renders and the footer Continue
  // button enables — the user stays in control (the old setTimeout jumps
  // could fire after they had navigated elsewhere).
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const type = getActiveType();
    const name = getActiveConnectionName();
    const cfg = getActiveConfig();

    try {
      let connId = getActiveConnectionId();
      if (!connId && type) {
        connId = await createConnection(type, name, cfg);
        if (isFullOnboarding) {
          setDataSources(prev => prev.map((ds, i) =>
            i === activeSourceIndex ? { ...ds, connectionId: connId } : ds
          ));
        } else {
          setConnectionId(connId);
        }
      }

      if (isDemo || connId?.startsWith('demo-')) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        setTestResult({ success: true, message: 'Connection test successful (demo mode)' });
        markActiveTestSuccess();
        return;
      }

      const response = await fetch(`/api/connections/${connId}/test`, { method: 'POST' });
      const data = await response.json();
      setTestResult({
        success: data.data?.success ?? false,
        message: data.data?.message ?? data.error ?? 'Test completed',
      });
      if (data.data?.success) {
        markActiveTestSuccess();
      }
    } catch (err) {
      if (allowDemoFallback) {
        setIsDemo(true);
        setTestResult({ success: true, message: 'Connection test successful (demo mode)' });
        markActiveTestSuccess();
      } else {
        setTestResult({
          success: false,
          message: err instanceof Error ? err.message : 'Connection test failed. Check your credentials and try again.',
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const runDiscovery = async () => {
    const connId = getActiveConnectionId();
    const type = getActiveType();
    if (!connId) return;

    setDiscovering(true);
    const inProgressResult: DiscoveryResult = { status: 'in_progress' };
    if (isFullOnboarding) {
      setDataSources(prev => prev.map((ds, i) =>
        i === activeSourceIndex ? { ...ds, discovery: inProgressResult as any } : ds
      ));
    } else {
      setDiscovery(inProgressResult);
    }

    if (isDemo || connId.startsWith('demo-')) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const demoResult = type === 'sungrow_api' ? SUNGROW_DEMO_DISCOVERY : DEMO_DISCOVERY;
      const demoInverters = type === 'sungrow_api' ? SUNGROW_DEMO_INVERTERS : [];

      if (isFullOnboarding) {
        setDataSources(prev => prev.map((ds, i) =>
          i === activeSourceIndex ? { ...ds, discovery: demoResult as any } : ds
        ));
      } else {
        setDiscovery(demoResult);
      }

      if (demoInverters.length > 0) {
        setDiscoveredInverters(demoInverters);
        // Auto-group discovered inverters
        const suggestion = autoGroupInverters(demoInverters);
        setAutoGroupSuggestion(suggestion);
      }

      if (type === 'sungrow_api') {
        setWeatherStation({
          hasOnSiteWeatherStation: true,
          irradianceSensorType: 'reference_cell',
          sensorMountedAtTilt: true,
          hasDustIQSensor: false,
          notes: '',
        });
      }

      setDiscovering(false);
      // No auto-advance: the completed panel renders and the footer button
      // ("Match Devices" / "Review Mappings") takes over.
      return;
    }

    try {
      const response = await fetch(`/api/connections/${connId}/discover`, { method: 'POST' });
      const data = await response.json();
      if (isFullOnboarding) {
        setDataSources(prev => prev.map((ds, i) =>
          i === activeSourceIndex ? { ...ds, discovery: data.data } : ds
        ));
        // Zero-touch assist: backfill ONLY-empty plant fields from what the
        // vendor reported, never overwriting the user's own input.
        const discoveredPlant = data.data?.plants?.[0];
        if (data.data?.status === 'completed' && discoveredPlant) {
          setPlantConfig(prev => ({
            ...prev,
            plantName: prev.plantName || discoveredPlant.name || prev.plantName,
            capacity_MW: prev.capacity_MW || discoveredPlant.capacity_mw || prev.capacity_MW,
            latitude: prev.latitude || discoveredPlant.location?.lat || prev.latitude,
            longitude: prev.longitude || discoveredPlant.location?.lng || prev.longitude,
            location: prev.location || discoveredPlant.location?.address || prev.location,
          }));
        }
      } else {
        setDiscovery(data.data);
      }
      // No auto-advance on completion — the footer button takes over.
    } catch (err) {
      if (allowDemoFallback) {
        setIsDemo(true);
        const fallback = DEMO_DISCOVERY;
        if (isFullOnboarding) {
          setDataSources(prev => prev.map((ds, i) =>
            i === activeSourceIndex ? { ...ds, discovery: fallback as any } : ds
          ));
        } else {
          setDiscovery(fallback);
        }
      } else {
        const failed: DiscoveryResult = {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Discovery failed. Check the connection and try again.',
        } as DiscoveryResult;
        if (isFullOnboarding) {
          setDataSources(prev => prev.map((ds, i) =>
            i === activeSourceIndex ? { ...ds, discovery: failed as any } : ds
          ));
        } else {
          setDiscovery(failed);
        }
      }
    } finally {
      setDiscovering(false);
    }
  };

  /** After mapping review: configure the next NEW source (reused connections
   *  need no Configure/Test/Discover pass), else move to Confirm. */
  const advanceAfterMappings = () => {
    if (isFullOnboarding) {
      const nextNewIdx = dataSources.findIndex((ds, i) => i > activeSourceIndex && !ds.existing);
      if (nextNewIdx !== -1) {
        setActiveSourceIndex(nextNewIdx);
        setCurrentStep(4); // Back to Configure for the next source
        return;
      }
    }
    setCurrentStep(confirmStep);
  };

  const confirmMappings = async () => {
    const connId = getActiveConnectionId();
    setSaving(true);

    // Reused connections already have confirmed mappings server-side — the
    // review is read-only, don't re-POST.
    if (isFullOnboarding && activeSource?.existing) {
      setSaving(false);
      advanceAfterMappings();
      return;
    }

    if (isDemo || !connId || connId.startsWith('demo-')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      setSaving(false);
      advanceAfterMappings();
      return;
    }

    try {
      await fetch(`/api/connections/${connId}/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Persist the user's FieldMapper overrides, previously this posted
        // an empty array and silently discarded every remap.
        body: JSON.stringify({ mappings: editedMappings, auto_confirm_threshold: 0.85 }),
      });
      advanceAfterMappings();
    } catch {
      setCurrentStep(confirmStep);
    } finally {
      setSaving(false);
    }
  };

  // ── Map source type to DataSourceType ──
  const mapTypeToSourceType = (type: ConnectionType): string => {
    switch (type) {
      case 'csv_upload': return 'MANUAL_CSV';
      default: return 'SCADA';
    }
  };

  // ── Final Save ──

  const finalSave = async () => {
    setSaving(true);

    try {
      if (isFullOnboarding && plantConfig.plantName) {
        const payload = {
          name: plantConfig.plantName,
          asset_type: plantConfig.assetType === 'SOLAR' ? 'PV' : plantConfig.assetType,
          location_name: plantConfig.location,
          latitude: plantConfig.latitude,
          longitude: plantConfig.longitude,
          altitude: plantConfig.altitude || undefined,
          timezone: plantConfig.timezone,
          country: plantConfig.country || undefined,
          capacity_mw: plantConfig.capacity_MW,
          installed_mw: plantConfig.installed_MW || undefined,
          // Storage nameplate. The plant-level MWh is what the pricing meter
          // reads; the storage block writes the plant's BessAsset row. Both are
          // gated on the asset type so a storage block left behind by a change
          // of mind cannot bill a PV plant as if it had a battery.
          energy_capacity_mwh: isStorageAsset
            ? plantConfig.storage?.energy_capacity_mwh ?? undefined
            : undefined,
          storage: isStorageAsset ? storagePayload(plantConfig.storage) : undefined,
          has_weather_station: weatherStation.hasOnSiteWeatherStation,
          irradiance_sensor_type: weatherStation.irradianceSensorType !== 'none' ? weatherStation.irradianceSensorType : undefined,
          sensor_mounted_at_tilt: weatherStation.sensorMountedAtTilt,
          has_dustiq_sensor: weatherStation.hasDustIQSensor,
          inverter_groups: inverterGroups.map(g => ({
            name: g.name,
            tilt: g.tilt,
            azimuth: g.azimuth,
            inverter_model: g.inverterModel || undefined,
            inverter_nominal_power_kw: g.inverterNominalPower_kW || undefined,
            mppt_count: g.mpptCount || undefined,
            strings_per_mppt: g.stringsPerMppt || undefined,
            gamma_pdc: g.gammaPdc || undefined,
            inverters: g.inverterIds.map(id => ({
              external_id: id,
              model: g.inverterModel || undefined,
              nominal_power_kw: g.inverterNominalPower_kW || undefined,
              mppt_count: g.mpptCount || undefined,
              strings_per_mppt: g.stringsPerMppt || undefined,
            })),
          })),
          // Sample mode provisions its own connection via /sample-feed, so it
          // sends no real data sources here.
          data_sources: sampleMode ? [] : dataSources.map((ds, i) => ({
            name: ds.name || `${ds.type} connection`,
            source_type: mapTypeToSourceType(ds.type),
            purpose: ds.purpose,
            provides_metrics: ds.provides_metrics.length > 0
              ? ds.provides_metrics
              : ['power_ac', 'power_dc', 'irradiance_poa', 'temp_module', 'temp_ambient'],
            is_primary: i === 0,
            connection_id: ds.connectionId?.startsWith('demo-') ? undefined : ds.connectionId || undefined,
            // SCADA tag → equipment external_id map from the Match Devices step.
            scada_device_map: Object.fromEntries(
              Object.entries(deviceMatches)
                .filter(([, m]) => m.equipmentId != null)
                .map(([tag, m]) => [tag, m.equipmentId]),
            ),
          })),
        };

        const res = await fetch('/api/plants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to create plant');
        }

        const { data: createdPlant } = await res.json();

        // Sample mode: generate the synthetic inverter feed for the new plant so
        // the dashboard lights up immediately. Best-effort — never block the
        // onboarding completion on it.
        if (sampleMode) {
          try {
            await fetch(`/api/plants/${createdPlant.slug}/sample-feed`, { method: 'POST' });
          } catch {
            // The plant still exists; the customer can retry from its status page.
          }
        }

        // Starter report: a performance dashboard scoped to the new plant.
        let starterDashboardId: string | null = null;
        if (createStarterReport) {
          try {
            const widget = (type: string, y: number, w = 12, h = 4, x = 0) => ({
              id: `w_${type.replace(/\W/g, '_')}_${y}`,
              type, x, y, w, h, config: {},
            });
            const dashRes = await fetch('/api/dashboards', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: `${plantConfig.plantName}, Performance`,
                description: 'Starter report created during onboarding',
                scope_plant_ids: [createdPlant.slug],
                default_range: 'last_30d',
                widgets: [
                  widget('kpi.single_metric', 0, 12, 2),
                  widget('pv.expected_vs_measured', 2),
                  widget('pv.loss_waterfall', 6, 6, 4, 0),
                  widget('pv.residual_heatmap', 6, 6, 4, 6),
                ],
              }),
            });
            if (dashRes.ok) {
              const dashJson = await dashRes.json();
              starterDashboardId = dashJson.data?.id ?? null;
            }
          } catch {
            // Starter report is best-effort, never block plant creation.
          }
        }

        clearDraft();
        onComplete({ plantId: createdPlant.slug } as any);
        // The starter-report redirect targets the demo reports viewer; real
        // customers navigate via onComplete (their parent decides the route).
        if (starterDashboardId && allowDemoFallback) {
          router.push(`/demo/reports/${starterDashboardId}`);
        }
      } else {
        // Connection-only mode
        if (connectionId && !connectionId.startsWith('demo-')) {
          await fetch(`/api/connections/${connectionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
          });
        }
        clearDraft();
        onComplete();
      }
    } catch (err) {
      console.error('Failed to save plant:', err);
      if (allowDemoFallback) {
        onComplete();
      } else {
        setSaveError(
          err instanceof Error ? err.message : 'Failed to save the plant. Please try again.'
        );
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Handle skip actions ──

  const handleSkipEquipment = () => {
    setSkipEquipment(true);
    setCurrentStep(3);
  };

  const handleSkipDataSources = () => {
    setSkipDataSources(true);
    setCurrentStep(confirmStep);
  };

  // "Try with sample data": skip the credential/discover steps entirely and
  // jump to Confirm. The synthetic feed is generated after the plant is created
  // (finalSave), so the customer sees the full dashboard without a real source.
  const handleChooseSample = () => {
    setSampleMode(true);
    setDataSources([]);
    setSkipDataSources(true);
    setCurrentStep(confirmStep);
  };

  // ── Handle auto-group acceptance ──

  const handleAcceptAutoGroups = () => {
    if (autoGroupSuggestion) {
      setInverterGroups(autoGroupSuggestion.groups);
      setAutoGroupSuggestion(null);
    }
  };

  // ── Render config form based on type ──

  const renderConfigForm = () => {
    const type = getActiveType();
    const cfg = getActiveConfig();
    const updateConfig = (patch: Partial<ConnectionConfig>) => setActiveConfig({ ...cfg, ...patch });

    switch (type) {
      case 'influxdb':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">InfluxDB URL <span className="text-red-500">*</span></label>
              <input type="url" placeholder="https://your-influxdb.com" value={cfg.url || ''} onChange={(e) => updateConfig({ url: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Token <span className="text-red-500">*</span></label>
              <input type="password" placeholder="Your InfluxDB token" value={cfg.token || ''} onChange={(e) => updateConfig({ token: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Organization <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Your org" value={cfg.org || ''} onChange={(e) => updateConfig({ org: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bucket <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Your bucket" value={cfg.bucket || ''} onChange={(e) => updateConfig({ bucket: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
          </div>
        );

      case 'sql_scada':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Host <span className="text-red-500">*</span></label>
                <input type="text" placeholder="db.example.com" value={cfg.host || ''} onChange={(e) => updateConfig({ host: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
                <input type="number" placeholder="1433" value={cfg.port || ''} onChange={(e) => updateConfig({ port: parseInt(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Database <span className="text-red-500">*</span></label>
              <input type="text" placeholder="scada_db" value={cfg.database || ''} onChange={(e) => updateConfig({ database: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Username" value={cfg.username || ''} onChange={(e) => updateConfig({ username: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password <span className="text-red-500">*</span></label>
                <input type="password" placeholder="Password" value={cfg.password || ''} onChange={(e) => updateConfig({ password: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
          </div>
        );

      case 'modbus_tcp': {
        const preset = MODBUS_PRESETS.find((p) => p.id === (cfg.manufacturer_preset || 'generic'))!;
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Inverter manufacturer preset</label>
              <select
                value={cfg.manufacturer_preset || 'generic'}
                onChange={(e) => {
                  const p = MODBUS_PRESETS.find((mp) => mp.id === e.target.value)!;
                  updateConfig({ manufacturer_preset: p.id, port: p.port, unit_id: p.unitId });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {MODBUS_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">{preset.note}</p>
            </div>
            {preset.registers.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Register map (pre-configured)</label>
                <div className="flex flex-wrap gap-2">
                  {preset.registers.map((r) => (
                    <span key={r} className="px-2 py-1 text-xs bg-green-50 text-green-800 rounded-md border border-green-200 font-mono">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Host <span className="text-red-500">*</span></label>
                <input type="text" placeholder="192.168.1.100" value={cfg.host || ''} onChange={(e) => updateConfig({ host: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Port <span className="text-red-500">*</span></label>
                <input type="number" placeholder="502" value={cfg.port || preset.port} onChange={(e) => updateConfig({ port: parseInt(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit ID</label>
              <input type="number" placeholder="1" value={cfg.unit_id || preset.unitId} onChange={(e) => updateConfig({ unit_id: parseInt(e.target.value) })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <RegisterMapUploader
              ensureConnectionId={ensureActiveConnectionId}
              preset={{ id: preset.id, label: preset.label, registers: preset.registers }}
            />
          </div>
        );
      }

      case 'sunspec':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
              <div className="font-semibold mb-1">SunSpec Alliance Standard</div>
              SunSpec uses Modbus TCP as a transport layer with standardized register maps for PV inverters. Auto-discovery will probe common models (Common, Inverter 101/102/103, MPPT 160).
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Host <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="192.168.1.100"
                  value={config.host || ''}
                  onChange={(e) => setConfig({ ...config, host: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Port <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  placeholder="502"
                  value={config.port || 502}
                  onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Slave/Unit ID</label>
                <input
                  type="number"
                  placeholder="1"
                  value={config.unit_id || 1}
                  onChange={(e) => setConfig({ ...config, unit_id: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Base Register</label>
                <input
                  type="number"
                  placeholder="40000"
                  value={config.base_register || 40000}
                  onChange={(e) => setConfig({ ...config, base_register: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Models to probe</label>
              <div className="flex flex-wrap gap-2">
                {['Common (1)', 'Inverter 101', 'Inverter 102', 'Inverter 103', 'MPPT 160', 'Meter 203'].map((m) => (
                  <span key={m} className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-md border border-yellow-200">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );

      case 'csv_upload':
        return (
          <div className="space-y-4">
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-colors cursor-pointer">
              <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600 mb-2">Drag and drop your CSV file here, or click to browse</p>
              <p className="text-sm text-gray-400">Supports CSV, Excel, and Parquet formats</p>
              <input type="file" className="hidden" accept=".csv.xlsx.parquet" />
            </div>
          </div>
        );

      case 'huawei_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 rounded-lg text-sm text-blue-700">
              <p className="font-medium mb-1">Use your Northbound API credentials (not your FusionSolar portal login).</p>
              <p className="text-blue-600">Setup: Company Admin → System → Northbound Management → Add</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Regional Endpoint <span className="text-red-500">*</span></label>
              <select value={cfg.huawei_endpoint || ''} onChange={(e) => updateConfig({ huawei_endpoint: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Select region...</option>
                {HUAWEI_ENDPOINTS.map(ep => (<option key={ep.value} value={ep.value}>{ep.label}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Northbound Username <span className="text-red-500">*</span></label>
              <input type="text" placeholder="API username" value={cfg.huawei_username || ''} onChange={(e) => updateConfig({ huawei_username: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Northbound Password <span className="text-red-500">*</span></label>
              <input type="password" placeholder="API password" value={cfg.huawei_password || ''} onChange={(e) => updateConfig({ huawei_password: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
          </div>
        );

      case 'sungrow_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-amber-50 rounded-lg text-sm text-amber-700">
              <p className="font-medium mb-1">Sungrow iSolarCloud requires portal credentials + API keys.</p>
              <p className="text-amber-600">Request API keys at service@sungrow-emea.com</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Gateway Region <span className="text-red-500">*</span></label>
              <select value={cfg.sungrow_gateway || ''} onChange={(e) => updateConfig({ sungrow_gateway: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Select region...</option>
                {SUNGROW_GATEWAYS.map(gw => (<option key={gw.value} value={gw.value}>{gw.label}</option>))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Username <span className="text-red-500">*</span></label>
                <input type="text" placeholder="iSolarCloud username" value={cfg.sungrow_username || ''} onChange={(e) => updateConfig({ sungrow_username: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Password <span className="text-red-500">*</span></label>
                <input type="password" placeholder="iSolarCloud password" value={cfg.sungrow_password || ''} onChange={(e) => updateConfig({ sungrow_password: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">App Key <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Developer App Key" value={cfg.appkey || ''} onChange={(e) => updateConfig({ appkey: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Key <span className="text-red-500">*</span></label>
                <input type="password" placeholder="Developer Access Key" value={cfg.appsecret || ''} onChange={(e) => updateConfig({ appsecret: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Plant ID <span className="text-gray-400">(optional)</span></label>
              <input type="text" placeholder="Leave empty to discover all plants" value={cfg.sungrow_plant_id || ''} onChange={(e) => updateConfig({ sungrow_plant_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
          </div>
        );

      case 'sma_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-rose-50 rounded-lg text-sm text-rose-700">
              <p className="font-medium mb-1">SMA ennexOS / Sunny Portal OAuth credentials.</p>
              <p className="text-rose-600">Request API access via the SMA Developer Portal (developer.sma.de).</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client ID <span className="text-red-500">*</span></label>
                <input type="text" placeholder="OAuth client ID" value={cfg.client_id || ''} onChange={(e) => updateConfig({ client_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client Secret <span className="text-red-500">*</span></label>
                <input type="password" placeholder="OAuth client secret" value={cfg.client_secret || ''} onChange={(e) => updateConfig({ client_secret: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Plant ID <span className="text-gray-400">(optional)</span></label>
              <input type="text" placeholder="Leave empty to discover all plants" value={cfg.site_id || ''} onChange={(e) => updateConfig({ site_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
          </div>
        );

      case 'fronius_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-orange-50 rounded-lg text-sm text-orange-700">
              <p className="font-medium mb-1">Fronius Solar.web API access keys.</p>
              <p className="text-orange-600">Generate under Solar.web → Settings → API keys (Solar API v1).</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Key ID <span className="text-red-500">*</span></label>
                <input type="text" placeholder="FKIA..." value={cfg.api_key || ''} onChange={(e) => updateConfig({ api_key: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Access Key Value <span className="text-red-500">*</span></label>
                <input type="password" placeholder="Access key value" value={cfg.client_secret || ''} onChange={(e) => updateConfig({ client_secret: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
          </div>
        );

      case 'solaredge_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-50 rounded-lg text-sm text-emerald-700">
              <p className="font-medium mb-1">SolarEdge monitoring API key.</p>
              <p className="text-emerald-600">Generate under Monitoring Portal → Admin → Site Access → API Access.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key <span className="text-red-500">*</span></label>
                <input type="password" placeholder="Site API key" value={cfg.api_key || ''} onChange={(e) => updateConfig({ api_key: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site ID <span className="text-red-500">*</span></label>
                <input type="text" placeholder="e.g. 1234567" value={cfg.site_id || ''} onChange={(e) => updateConfig({ site_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
          </div>
        );

      case 'goodwe_api':
        return (
          <div className="space-y-4">
            <div className="p-4 bg-sky-50 rounded-lg text-sm text-sky-700">
              <p className="font-medium mb-1">GoodWe SEMS Portal account credentials.</p>
              <p className="text-sky-600">Uses the SEMS Portal API, a dedicated read-only account is recommended.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Email <span className="text-red-500">*</span></label>
                <input type="email" placeholder="account@example.com" value={cfg.account_email || ''} onChange={(e) => updateConfig({ account_email: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password <span className="text-red-500">*</span></label>
                <input type="password" placeholder="SEMS password" value={cfg.account_password || ''} onChange={(e) => updateConfig({ account_password: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Station ID <span className="text-gray-400">(optional)</span></label>
              <input type="text" placeholder="Leave empty to discover all stations" value={cfg.site_id || ''} onChange={(e) => updateConfig({ site_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // ── Source tab bar for multi-source flow ──

  const renderSourceTabs = () => {
    if (!isFullOnboarding || dataSources.length <= 1) return null;
    const typeMeta = CONNECTION_TYPES;

    return (
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {dataSources.map((ds, i) => {
          const meta = typeMeta.find(t => t.id === ds.type);
          const Icon = meta?.icon || Database;
          const isActive = i === activeSourceIndex;
          const isDone = i < activeSourceIndex;

          return (
            <div
              key={ds.id}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
                isActive ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-300'
                : isDone ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-500'
              }`}
            >
              {isDone ? <Check className="w-3 h-3" /> : <Icon className="w-3 h-3" />}
              {ds.name || meta?.name || ds.type}
            </div>
          );
        })}
      </div>
    );
  };

  // ── Render ──

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {isFullOnboarding ? 'Onboard New Plant' : 'Add Data Connection'}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {(() => {
                const visible = steps.filter((s) => !s.isSkipped(snapshot));
                const idx = visible.findIndex((s) => s.id === currentStep);
                const active = steps.find((s) => s.id === currentStep);
                // stepDescription, not step.description: the storage branch
                // renames steps that talk about inverters and sensors.
                return `Step ${idx + 1} of ${visible.length}: ${active ? stepDescription(active, snapshot) : ''}`;
              })()}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Resume banner: an unfinished draft survives refresh/close. */}
        {draft && !draftHandled && (
          <div className="px-6 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center justify-between gap-3">
            <p className="text-sm text-blue-800">
              You have an unfinished setup from {new Date(draft.savedAt).toLocaleString()}. Resume where you left off?
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={() => hydrateDraft(draft)}
                className="px-3 py-1 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={() => {
                  clearDraft();
                  setDraftHandled(true);
                }}
                className="px-3 py-1 text-sm text-blue-700 border border-blue-300 rounded-lg hover:bg-blue-100"
              >
                Start over
              </button>
            </div>
          </div>
        )}

        {/* Step indicator (clickable — jump to any visited or unlocked step) */}
        <WizardStepIndicator
          steps={steps}
          currentStep={currentStep}
          snapshot={snapshot}
          visited={visited}
          onSelect={goToStep}
        />

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* ═══ FULL ONBOARDING FLOW ═══ */}
          {isFullOnboarding && (
            <>
              {/* Step 1: Plant Configuration */}
              {currentStep === 1 && (
                <PlantConfigStep
                  config={plantConfig}
                  onChange={setPlantConfig}
                  discoveredName={firstDiscoveredPlant?.name}
                  discoveredCapacity={firstDiscoveredPlant?.capacity_mw}
                />
              )}

              {/* Step 2: Equipment (optional) */}
              {currentStep === 2 && (
                <div className="space-y-4">
                  {/* Auto-group suggestion banner */}
                  {autoGroupSuggestion && autoGroupSuggestion.confidence !== 'low' && inverterGroups.length === 0 && (
                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-medium text-blue-800 flex items-center gap-2">
                            <Settings2 className="w-4 h-4" />
                            Suggested Groups ({autoGroupSuggestion.confidence} confidence)
                          </h4>
                          <p className="text-sm text-blue-600 mt-1">{autoGroupSuggestion.message}</p>
                          <p className="text-xs text-blue-500 mt-1">Method: {autoGroupSuggestion.method}</p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleAcceptAutoGroups}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => setAutoGroupSuggestion(null)}
                            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-100"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {discoveredInverters.length > 0 ? (
                    <InverterGroupStep
                      inverters={discoveredInverters}
                      groups={inverterGroups}
                      onChange={setInverterGroups}
                      weatherStation={weatherStation}
                      onWeatherStationChange={setWeatherStation}
                    />
                  ) : (
                    <div className="space-y-4">
                      <div className="p-4 bg-gray-50 rounded-lg text-sm text-gray-600">
                        No inverters have been discovered yet. You can define inverter groups manually or skip this step and configure after connecting a data source.
                      </div>
                      <InverterGroupStep
                        inverters={[]}
                        groups={inverterGroups}
                        onChange={setInverterGroups}
                        weatherStation={weatherStation}
                        onWeatherStationChange={setWeatherStation}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: Data Sources (multi-select, optional) */}
              {currentStep === 3 && (
                <DataSourceSelector
                  sources={dataSources}
                  onChange={setDataSources}
                  onSkip={handleSkipDataSources}
                  onChooseSample={handleChooseSample}
                  enforceAvailability={!allowDemoFallback}
                />
              )}

              {/* Step 4: Configure credentials (per-source) */}
              {currentStep === 4 && (
                <div className="space-y-6">
                  {renderSourceTabs()}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Connection Name
                    </label>
                    <input
                      type="text"
                      placeholder={`e.g. ${activeSource?.type || 'My'} connection`}
                      value={activeSource?.name || ''}
                      onChange={(e) => setDataSources(prev => prev.map((ds, i) =>
                        i === activeSourceIndex ? { ...ds, name: e.target.value } : ds
                      ))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  {renderConfigForm()}
                  {testResult && (
                    <div className={`p-4 rounded-lg flex items-center gap-3 ${testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {testResult.success ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <span>{testResult.message}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Step 5: Discover (per-source) */}
              {currentStep === 5 && (
                <div className="space-y-6">
                  {renderSourceTabs()}
                  {(() => {
                    const disc = getActiveDiscovery();
                    if (!disc) {
                      return (
                        <div className="text-center py-8">
                          <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                          <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Discover</h3>
                          <p className="text-gray-500 mb-6">Analyze your data source to discover plants, fields, and structure.</p>
                          <button onClick={runDiscovery} disabled={discovering} className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                            {discovering ? (<><Loader2 className="w-5 h-5 animate-spin" />Discovering...</>) : (<><RefreshCw className="w-5 h-5" />Start Discovery</>)}
                          </button>
                        </div>
                      );
                    }
                    if (disc.status === 'in_progress') {
                      return (
                        <div className="text-center py-8">
                          <Loader2 className="w-16 h-16 text-blue-500 mx-auto mb-4 animate-spin" />
                          <h3 className="text-lg font-medium text-gray-900 mb-2">Analyzing Data Source</h3>
                          <p className="text-gray-500">Discovering plants, fields, and data structure...</p>
                        </div>
                      );
                    }
                    if (disc.status === 'completed') {
                      return (
                        <div className="space-y-4">
                          <div className="p-4 bg-green-50 rounded-lg flex items-center gap-3 text-green-700">
                            <CheckCircle2 className="w-5 h-5" /><span>Discovery completed successfully!</span>
                          </div>
                          {disc.plants && disc.plants.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-2">Discovered {disc.plants.length} Plant{disc.plants.length !== 1 ? 's' : ''}</h4>
                              <div className="space-y-2">
                                {disc.plants.map(plant => (
                                  <div key={plant.id} className="p-3 bg-gray-50 rounded-lg flex items-center justify-between">
                                    <span className="font-medium">{plant.name}</span>
                                    {plant.capacity_mw && <span className="text-sm text-gray-500">{plant.capacity_mw} MW</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {discoveredInverters.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-2">Discovered {discoveredInverters.length} Inverters</h4>
                              <p className="text-sm text-gray-500">{discoveredInverters[0].model}, {discoveredInverters[0].nominalPower_kW} kW, {discoveredInverters[0].mpptCount} MPPT</p>
                            </div>
                          )}
                          {disc.recommendations && disc.recommendations.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-2">Recommendations</h4>
                              <ul className="space-y-1">
                                {disc.recommendations.map((rec, i) => (
                                  <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
                                    <span className="text-gray-400">&bull;</span>{rec}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div className="text-center py-8">
                        <AlertCircle className="w-16 h-16 text-red-300 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-red-700 mb-2">Discovery Failed</h3>
                        <p className="text-gray-500 mb-6">{disc.error}</p>
                        <button onClick={runDiscovery} className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                          <RefreshCw className="w-5 h-5" />Try Again
                        </button>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Step 6: Match SCADA device tags to equipment (per-source) */}
              {currentStep === 6 && (
                <div>
                  {renderSourceTabs()}
                  <DeviceMatchStep
                    tags={getActiveDiscovery()?.deviceTags ?? []}
                    equipment={equipmentIds()}
                    matches={deviceMatches}
                    onChange={setDeviceMatches}
                  />
                </div>
              )}

              {/* Step 7: Map Fields (per-source) */}
              {currentStep === 7 && (
                <div>
                  {renderSourceTabs()}
                  {activeSource?.existing && (
                    <div className="mb-4 p-3 bg-teal-50 border border-teal-200 rounded-lg text-sm text-teal-800">
                      Reusing <strong>{activeSource.name}</strong> — these are its already-confirmed
                      field mappings, shown for review.
                    </div>
                  )}
                  {(() => {
                    const connId = getActiveConnectionId();
                    const disc = getActiveDiscovery();
                    if (connId) {
                      // Reused connections have no fresh discovery — their
                      // persisted mappings were loaded into fieldMappings.
                      const source = disc?.fieldMappings || activeSource?.fieldMappings || [];
                      return (
                        <FieldMapper
                          connectionId={connId}
                          initialMappings={source.map(m => ({
                            source_field: m.originalField,
                            target_field: m.mappedType,
                            confidence: m.confidence,
                            unit: m.unit,
                            is_confirmed: (m as any).confirmed ?? m.confidence >= 85,
                          }))}
                          onMappingsChange={setEditedMappings}
                        />
                      );
                    }
                    return <p className="text-gray-500">No connection configured for this source.</p>;
                  })()}
                </div>
              )}

              {/* Step 8: Confirm */}
              {currentStep === 8 && (
                <div className="space-y-6">
                  <div className="p-4 bg-green-50 rounded-lg">
                    <h3 className="font-medium text-green-800 mb-2 flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5" />
                      Plant Ready
                    </h3>
                    <p className="text-sm text-green-700">
                      {sampleMode
                        ? 'Your plant will be created and populated with a sample inverter feed so you can explore the full dashboard right away.'
                        : skipDataSources
                          ? 'Your plant will be created. You can add data sources later from the Data Hub.'
                          : 'Your plant is configured and ready to start syncing data.'}
                    </p>
                  </div>

                  {/* Sample mode note — clearly synthetic, replaceable later. */}
                  {sampleMode && (
                    <div className="p-4 bg-teal-50 border border-teal-200 rounded-lg">
                      <h4 className="text-sm font-semibold text-teal-800 flex items-center gap-2">
                        <FlaskConical className="w-4 h-4" />
                        Sample data (sandbox)
                      </h4>
                      <p className="mt-1 text-sm text-teal-700">
                        We&apos;ll generate ~30 days of realistic synthetic inverter telemetry. It&apos;s
                        clearly labelled as sample data everywhere and you can replace it by connecting a
                        real source under <strong>Data Hub → Connections</strong> anytime.
                      </p>
                    </div>
                  )}

                  {/* Skip warnings, the plant can be created half-configured,
                      but the user should leave knowing exactly what's missing
                      and where to retrofit it. */}
                  {!sampleMode && (skipDataSources || inverterGroups.length === 0) && (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5">
                      <h4 className="text-sm font-semibold text-amber-800">
                        Heads up, this plant will be created incomplete
                      </h4>
                      {inverterGroups.length === 0 && (
                        <p className="text-sm text-amber-700">
                          • No equipment configured: analytics (digital twin,
                          soiling, fault detection) need inverter groups. Add
                          them later under <strong>Settings → Equipment</strong>.
                        </p>
                      )}
                      {skipDataSources && (
                        <p className="text-sm text-amber-700">
                          • No data sources connected: no telemetry will flow
                          until you add one under <strong>Data Hub →
                          Connections</strong>.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="p-4 bg-gray-50 rounded-lg">
                    <h4 className="font-medium mb-3">Plant Summary</h4>
                    <dl className="space-y-2 text-sm">
                      {plantConfig.plantName && (
                        <div className="flex justify-between"><dt className="text-gray-500">Plant Name:</dt><dd className="font-medium">{plantConfig.plantName}</dd></div>
                      )}
                      {plantConfig.location && (
                        <div className="flex justify-between"><dt className="text-gray-500">Location:</dt><dd className="font-medium">{plantConfig.location}</dd></div>
                      )}
                      {plantConfig.capacity_MW > 0 && (
                        <div className="flex justify-between"><dt className="text-gray-500">Capacity:</dt><dd className="font-medium">{plantConfig.capacity_MW} MW</dd></div>
                      )}
                      {isStorageAsset && (plantConfig.storage?.energy_capacity_mwh ?? 0) > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Energy capacity:</dt>
                          <dd className="font-medium">{plantConfig.storage?.energy_capacity_mwh} MWh</dd>
                        </div>
                      )}
                      {inverterGroups.length > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Equipment:</dt>
                          <dd className="font-medium text-right">
                            {inverterGroups.map(g =>
                              `${g.name}: ${g.inverterIds.length}× ${g.inverterModel || 'inverter'}${g.inverterNominalPower_kW ? ` ${g.inverterNominalPower_kW}kW` : ''}`
                            ).join(', ')}
                          </dd>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Data Sources:</dt>
                        <dd className="font-medium">
                          {skipDataSources ? 'None (configure later)' : `${dataSources.length} source${dataSources.length !== 1 ? 's' : ''}`}
                        </dd>
                      </div>
                      {dataSources.length > 0 && dataSources.map(ds => (
                        <div key={ds.id} className="flex justify-between pl-4">
                          <dt className="text-gray-400">{ds.name || ds.type}:</dt>
                          <dd className="text-gray-600">{ds.purpose}</dd>
                        </div>
                      ))}
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Weather Station:</dt>
                        <dd className="font-medium">
                          {weatherStation.hasOnSiteWeatherStation
                            ? `On-site ${weatherStation.irradianceSensorType === 'pyranometer' ? 'pyranometer' : 'reference cell'}${weatherStation.sensorMountedAtTilt ? ' (POA)' : ' (GHI)'}`
                            : 'No weather station'}
                        </dd>
                      </div>
                      {Object.keys(deviceMatches).length > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Device matching:</dt>
                          <dd className="font-medium">
                            {Object.values(deviceMatches).filter((m) => m.equipmentId != null).length}/
                            {Object.keys(deviceMatches).length} tags matched
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  {/* Starter report */}
                  <label className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createStarterReport}
                      onChange={(e) => setCreateStarterReport(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="block text-sm font-medium text-blue-900">
                        Create a starter report
                      </span>
                      <span className="block text-xs text-blue-700 mt-0.5">
                        Generates a performance dashboard (production vs expected, loss
                        waterfall, fleet heatmap) scoped to this plant and opens it in the
                        reports hub.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </>
          )}

          {/* ═══ CONNECTION-ONLY FLOW ═══ */}
          {!isFullOnboarding && (
            <>
              {/* Step 1: Type Selection */}
              {currentStep === 1 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Connection Name <span className="text-red-500">*</span></label>
                    <input type="text" placeholder="My Solar Plant" value={connectionName} onChange={(e) => setConnectionName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">Select Connection Type</label>
                    <div className="grid grid-cols-2 gap-3">
                      {CONNECTION_TYPES.map((type) => {
                        const Icon = type.icon;
                        const isSelected = selectedType === type.id;
                        const availability = allowDemoFallback
                          ? 'available'
                          : vendorAvailability(type.id as OnboardingConnectionType);
                        const comingSoon = availability === 'coming_soon';
                        return (
                          <button key={type.id} disabled={comingSoon}
                            onClick={() => setSelectedType(type.id)}
                            className={`relative p-4 rounded-lg border-2 text-left transition-all ${comingSoon ? 'border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed' : isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                            {availability !== 'available' && (
                              <span className={`absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${comingSoon ? 'bg-gray-200 text-gray-600' : 'bg-amber-100 text-amber-800'}`}>
                                {AVAILABILITY_BADGE[availability as 'beta' | 'coming_soon']}
                              </span>
                            )}
                            <div className="flex items-center gap-3">
                              <div className={`p-2 rounded-lg ${type.bgColor}`}><Icon className={`w-5 h-5 ${type.color}`} /></div>
                              <div>
                                <h4 className="font-medium text-gray-900">{type.name}</h4>
                                <p className="text-xs text-gray-500">{comingSoon ? 'Not yet available. Tell us if you need it.' : type.description}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Configuration */}
              {currentStep === 2 && (
                <div className="space-y-6">
                  {renderConfigForm()}
                  {testResult && (
                    <div className={`p-4 rounded-lg flex items-center gap-3 ${testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {testResult.success ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <span>{testResult.message}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: Discovery */}
              {currentStep === 3 && (
                <div className="space-y-6">
                  {!discovery ? (
                    <div className="text-center py-8">
                      <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Discover</h3>
                      <p className="text-gray-500 mb-6">Analyze your data source to discover plants, fields, and structure.</p>
                      <button onClick={runDiscovery} disabled={discovering} className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                        {discovering ? (<><Loader2 className="w-5 h-5 animate-spin" />Discovering...</>) : (<><RefreshCw className="w-5 h-5" />Start Discovery</>)}
                      </button>
                    </div>
                  ) : discovery.status === 'in_progress' ? (
                    <div className="text-center py-8">
                      <Loader2 className="w-16 h-16 text-blue-500 mx-auto mb-4 animate-spin" />
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Analyzing Data Source</h3>
                      <p className="text-gray-500">Discovering plants, fields, and data structure...</p>
                    </div>
                  ) : discovery.status === 'completed' ? (
                    <div className="space-y-4">
                      <div className="p-4 bg-green-50 rounded-lg flex items-center gap-3 text-green-700">
                        <CheckCircle2 className="w-5 h-5" /><span>Discovery completed successfully!</span>
                      </div>
                      {discovery.plants && discovery.plants.length > 0 && (
                        <div>
                          <h4 className="font-medium mb-2">Discovered {discovery.plants.length} Plant{discovery.plants.length !== 1 ? 's' : ''}</h4>
                          <div className="space-y-2">
                            {discovery.plants.map(plant => (
                              <div key={plant.id} className="p-3 bg-gray-50 rounded-lg flex items-center justify-between">
                                <span className="font-medium">{plant.name}</span>
                                {plant.capacity_mw && <span className="text-sm text-gray-500">{plant.capacity_mw} MW</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {discovery.fieldMappings && (
                        <div>
                          <h4 className="font-medium mb-2">Mapped {discovery.fieldMappings.filter(m => m.mappedType !== 'unmapped').length} Fields</h4>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <AlertCircle className="w-16 h-16 text-red-300 mx-auto mb-4" />
                      <h3 className="text-lg font-medium text-red-700 mb-2">Discovery Failed</h3>
                      <p className="text-gray-500 mb-6">{discovery.error}</p>
                      <button onClick={runDiscovery} className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                        <RefreshCw className="w-5 h-5" />Try Again
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 4: Map Fields */}
              {currentStep === 4 && connectionId && (
                <FieldMapper
                  connectionId={connectionId}
                  initialMappings={(discovery?.fieldMappings || []).map(m => ({
                    source_field: m.originalField,
                    target_field: m.mappedType,
                    confidence: m.confidence,
                    unit: m.unit,
                    is_confirmed: m.confidence >= 85,
                  }))}
                  onMappingsChange={setEditedMappings}
                />
              )}

              {/* Step 5: Confirm */}
              {currentStep === 5 && (
                <div className="space-y-6">
                  <div className="p-4 bg-green-50 rounded-lg">
                    <h3 className="font-medium text-green-800 mb-2 flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5" />Connection Ready
                    </h3>
                    <p className="text-sm text-green-700">Your connection is configured and ready to start syncing data.</p>
                  </div>
                  <div className="p-4 bg-gray-50 rounded-lg">
                    <h4 className="font-medium mb-3">Connection Summary</h4>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between"><dt className="text-gray-500">Connection:</dt><dd className="font-medium">{connectionName}</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Type:</dt><dd className="font-medium">{CONNECTION_TYPES.find(t => t.id === selectedType)?.name}</dd></div>
                    </dl>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 flex justify-between">
          <button
            onClick={goBack}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
          >
            <ChevronLeft className="w-5 h-5" />
            {currentStep === 1 ? 'Cancel' : 'Back'}
          </button>

          {/* ═══ FULL ONBOARDING FOOTER BUTTONS ═══ */}
          {isFullOnboarding && (
            <>
              {/* Step 1: Continue to Equipment. Gated by the step machine so a
                  storage plant cannot walk past its missing MWh nameplate here
                  and then fail at create time. */}
              {currentStep === 1 && (() => {
                const step1 = steps.find((s) => s.id === 1);
                const ready = step1 ? step1.isComplete(snapshot) : true;
                return (
                  <button onClick={() => setCurrentStep(2)} disabled={!ready}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                    Continue <ChevronRight className="w-5 h-5" />
                  </button>
                );
              })()}

              {/* Step 2: Continue or Skip */}
              {currentStep === 2 && (
                <div className="flex gap-2">
                  <button onClick={handleSkipEquipment}
                    className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
                    Skip for now
                  </button>
                  <button onClick={() => setCurrentStep(3)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                    Continue <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              )}

              {/* Step 3: Continue with sources or handled by DataSourceSelector skip.
                  All-reused sources jump straight to mapping review. */}
              {currentStep === 3 && dataSources.length > 0 && (
                <button onClick={handleConfigureSources}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                  {dataSources.every(ds => ds.existing) ? 'Review Mappings' : 'Configure Sources'} <ChevronRight className="w-5 h-5" />
                </button>
              )}

              {/* Step 4: Test connection, gated on required credentials.
                  Continue appears after a passing test (no auto-jump). */}
              {currentStep === 4 && (() => {
                const missing = missingRequiredFields(getActiveType(), getActiveConfig());
                const tested = Boolean(activeSource?.testSuccess);
                return (
                  <div className="flex items-center gap-3">
                    {missing.length > 0 && (
                      <span className="text-xs text-amber-700">
                        Missing: {missing.join(', ')}
                      </span>
                    )}
                    <button onClick={testConnection} disabled={testing || missing.length > 0}
                      className={`px-4 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${tested ? 'text-gray-700 border border-gray-300 hover:bg-gray-50' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                      {testing ? (<><Loader2 className="w-5 h-5 animate-spin" />Testing...</>) : tested ? 'Retest' : (<>Test Connection<ChevronRight className="w-5 h-5" /></>)}
                    </button>
                    {tested && (
                      <button onClick={() => goToStep(5)}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                        Continue <ChevronRight className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Step 5: Advance after discovery */}
              {currentStep === 5 && getActiveDiscovery()?.status === 'completed' && (
                <button onClick={() => setCurrentStep(hasDeviceMatching() ? 6 : 7)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                  {hasDeviceMatching() ? 'Match Devices' : 'Review Mappings'} <ChevronRight className="w-5 h-5" />
                </button>
              )}

              {/* Step 6: Confirm device matches */}
              {currentStep === 6 && (
                <button onClick={() => setCurrentStep(7)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                  Review Mappings <ChevronRight className="w-5 h-5" />
                </button>
              )}

              {/* Step 7: Confirm Mappings */}
              {currentStep === 7 && (
                <button onClick={confirmMappings} disabled={saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
                  {saving ? (<><Loader2 className="w-5 h-5 animate-spin" />Saving...</>) : (<>Confirm Mappings<ChevronRight className="w-5 h-5" /></>)}
                </button>
              )}

              {/* Step 8: Create Plant */}
              {currentStep === 8 && (
                <div className="flex items-center gap-3">
                  {saveError && (
                    <span className="text-sm text-red-600 max-w-xs text-right">{saveError}</span>
                  )}
                  <button onClick={() => { setSaveError(null); finalSave(); }} disabled={saving}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2">
                    {saving ? (<><Loader2 className="w-5 h-5 animate-spin" />{sampleMode ? 'Generating...' : 'Finishing...'}</>) : (<><Check className="w-5 h-5" />{saveError ? 'Retry' : sampleMode ? 'Generate sample data' : 'Create Plant'}</>)}
                  </button>
                </div>
              )}
            </>
          )}

          {/* ═══ CONNECTION-ONLY FOOTER BUTTONS ═══ */}
          {!isFullOnboarding && (
            <>
              {currentStep === 1 && (
                <button onClick={() => setCurrentStep(2)} disabled={!selectedType || !connectionName}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              )}
              {currentStep === 2 && (() => {
                const missing = missingRequiredFields(getActiveType(), getActiveConfig());
                const tested = Boolean(testResult?.success);
                return (
                  <div className="flex items-center gap-3">
                    {missing.length > 0 && (
                      <span className="text-xs text-amber-700">
                        Missing: {missing.join(', ')}
                      </span>
                    )}
                    <button onClick={testConnection} disabled={testing || missing.length > 0}
                      className={`px-4 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${tested ? 'text-gray-700 border border-gray-300 hover:bg-gray-50' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                      {testing ? (<><Loader2 className="w-5 h-5 animate-spin" />Testing...</>) : tested ? 'Retest' : (<>Test Connection<ChevronRight className="w-5 h-5" /></>)}
                    </button>
                    {tested && (
                      <button onClick={() => goToStep(3)}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                        Continue <ChevronRight className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                );
              })()}
              {currentStep === 3 && discovery?.status === 'completed' && (
                <button onClick={() => setCurrentStep(4)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2">
                  Review Mappings <ChevronRight className="w-5 h-5" />
                </button>
              )}
              {currentStep === 4 && (
                <button onClick={confirmMappings} disabled={saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
                  {saving ? (<><Loader2 className="w-5 h-5 animate-spin" />Saving...</>) : (<>Confirm Mappings<ChevronRight className="w-5 h-5" /></>)}
                </button>
              )}
              {currentStep === 5 && (
                <button onClick={finalSave} disabled={saving}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2">
                  {saving ? (<><Loader2 className="w-5 h-5 animate-spin" />Finishing...</>) : (<><Check className="w-5 h-5" />Complete Setup</>)}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
