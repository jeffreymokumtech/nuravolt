'use client';

import { useEffect, useState } from 'react';
import {
  Database,
  Server,
  Cpu,
  Upload,
  Cloud,
  Sun,
  Zap,
  Plus,
  X,
  ChevronDown,
  FlaskConical,
  Link2,
  CheckCircle2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  DataSourceEntry,
  DataSourcePurpose,
  OnboardingConnectionType,
} from '@/types/onboarding';
import { vendorAvailability, AVAILABILITY_BADGE } from './vendor-availability';

type ConnectionType = OnboardingConnectionType;

interface DataSourceSelectorProps {
  sources: DataSourceEntry[];
  onChange: (sources: DataSourceEntry[]) => void;
  onSkip: () => void;
  /** "Try with sample data" — hands the flow to the sandbox sample-feed path. */
  onChooseSample?: () => void;
  /** When true, coming-soon vendors render disabled (real customers). */
  enforceAvailability?: boolean;
}

interface ConnectionTypeOption {
  id: ConnectionType;
  name: string;
  description: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  borderColor: string;
  selectedBg: string;
  /** Setup-type path the source belongs to (grouping in the type grid). */
  setup: 'direct' | 'cloud' | 'scada' | 'files';
}

// Setup-type paths: each plant setup finds its own entry point instead of
// scanning one flat grid of eleven options.
const SETUP_GROUPS: Array<{ id: ConnectionTypeOption['setup']; label: string; hint: string }> = [
  { id: 'direct', label: 'Direct to devices', hint: 'On-site network access to inverters or dataloggers' },
  { id: 'cloud', label: 'Manufacturer cloud', hint: 'Portal credentials, no site network access needed' },
  { id: 'scada', label: 'SCADA & historians', hint: 'Existing plant database or time-series historian' },
  { id: 'files', label: 'Files', hint: 'One-off or recurring file exports' },
];

const CONNECTION_TYPES: ConnectionTypeOption[] = [
  {
    id: 'sample_api',
    name: 'Sample inverter feed',
    description: 'Explore NuraVolt with a realistic synthetic inverter feed — no credentials needed',
    icon: FlaskConical,
    color: 'text-teal-600',
    bgColor: 'bg-teal-100',
    borderColor: 'border-teal-300',
    selectedBg: 'bg-teal-50',
    setup: 'cloud',
  },
  {
    id: 'influxdb',
    name: 'InfluxDB',
    description: 'Time-series database for metrics and monitoring',
    icon: Database,
    color: 'text-purple-600',
    bgColor: 'bg-purple-100',
    borderColor: 'border-purple-300',
    selectedBg: 'bg-purple-50',
    setup: 'scada',
  },
  {
    id: 'sql_scada',
    name: 'SQL SCADA',
    description: 'SQL Server based SCADA systems',
    icon: Server,
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
    borderColor: 'border-blue-300',
    selectedBg: 'bg-blue-50',
    setup: 'scada',
  },
  {
    id: 'modbus_tcp',
    name: 'Modbus TCP',
    description: 'Direct Modbus TCP/IP connection',
    icon: Cpu,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
    borderColor: 'border-green-300',
    selectedBg: 'bg-green-50',
    setup: 'direct',
  },
  {
    id: 'sunspec',
    name: 'SunSpec',
    description: 'SunSpec Modbus standard for solar inverters',
    icon: Zap,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-100',
    borderColor: 'border-yellow-300',
    selectedBg: 'bg-yellow-50',
    setup: 'direct',
  },
  {
    id: 'csv_upload',
    name: 'CSV Upload',
    description: 'Upload CSV files with historical data',
    icon: Upload,
    color: 'text-orange-600',
    bgColor: 'bg-orange-100',
    borderColor: 'border-orange-300',
    selectedBg: 'bg-orange-50',
    setup: 'files',
  },
  {
    id: 'huawei_api',
    name: 'Huawei FusionSolar',
    description: 'Huawei NorthBound API integration',
    icon: Cloud,
    color: 'text-red-600',
    bgColor: 'bg-red-100',
    borderColor: 'border-red-300',
    selectedBg: 'bg-red-50',
    setup: 'cloud',
  },
  {
    id: 'sungrow_api',
    name: 'Sungrow iSolarCloud',
    description: 'Sungrow iSolarCloud API integration',
    icon: Sun,
    color: 'text-amber-600',
    bgColor: 'bg-amber-100',
    borderColor: 'border-amber-300',
    selectedBg: 'bg-amber-50',
    setup: 'cloud',
  },
  {
    id: 'sma_api',
    name: 'SMA Sunny Portal',
    description: 'SMA ennexOS / Sunny Portal API',
    icon: Cloud,
    color: 'text-rose-600',
    bgColor: 'bg-rose-100',
    borderColor: 'border-rose-300',
    selectedBg: 'bg-rose-50',
    setup: 'cloud',
  },
  {
    id: 'fronius_api',
    name: 'Fronius Solar.web',
    description: 'Fronius Solar.web API integration',
    icon: Cloud,
    color: 'text-orange-600',
    bgColor: 'bg-orange-100',
    borderColor: 'border-orange-300',
    selectedBg: 'bg-orange-50',
    setup: 'cloud',
  },
  {
    id: 'solaredge_api',
    name: 'SolarEdge Monitoring',
    description: 'SolarEdge monitoring API',
    icon: Cloud,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-100',
    borderColor: 'border-emerald-300',
    selectedBg: 'bg-emerald-50',
    setup: 'cloud',
  },
  {
    id: 'goodwe_api',
    name: 'GoodWe SEMS',
    description: 'GoodWe SEMS Portal API',
    icon: Cloud,
    color: 'text-sky-600',
    bgColor: 'bg-sky-100',
    borderColor: 'border-sky-300',
    selectedBg: 'bg-sky-50',
    setup: 'cloud',
  },
];

const PURPOSE_OPTIONS: { value: DataSourcePurpose; label: string }[] = [
  { value: 'INVERTER_DATA', label: 'Inverter / SCADA Data' },
  { value: 'WEATHER_DATA', label: 'Weather Station' },
  { value: 'IRRADIANCE_DATA', label: 'Irradiance Data' },
  { value: 'SOILING_MEASUREMENT', label: 'Soiling Sensor' },
  { value: 'GRID_METERING', label: 'Grid Metering' },
  { value: 'SUPPLEMENTARY', label: 'Supplementary Data' },
];

function getConnectionMeta(type: ConnectionType): ConnectionTypeOption {
  return CONNECTION_TYPES.find((ct) => ct.id === type)!;
}

function createSourceEntry(
  type: ConnectionType,
  isFirst: boolean
): DataSourceEntry {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(),
    type,
    name: '',
    config: {},
    connectionId: null,
    discovery: null,
    purpose: isFirst ? 'INVERTER_DATA' : 'SUPPLEMENTARY',
    provides_metrics: [],
    fieldMappings: [],
  };
}

interface ExistingConnection {
  id: string;
  name: string;
  type: ConnectionType;
  status: string;
  plants_connected: number;
  _count?: { field_mappings: number };
}

export default function DataSourceSelector({
  sources,
  onChange,
  onSkip,
  onChooseSample,
  enforceAvailability = false,
}: DataSourceSelectorProps) {
  const [showTypeGrid, setShowTypeGrid] = useState(sources.length === 0);
  // Already-tested connections in this org — offered for reuse so a plant can
  // attach to an existing data source instead of re-entering credentials.
  const [existingConnections, setExistingConnections] = useState<ExistingConnection[]>([]);

  useEffect(() => {
    fetch('/api/connections?status=connected&page_size=100')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.data) setExistingConnections(json.data);
      })
      .catch(() => {
        /* section simply doesn't render */
      });
  }, []);

  const selectedTypes = new Set(sources.map((s) => s.type));
  const selectedConnectionIds = new Set(sources.map((s) => s.connectionId).filter(Boolean));
  const allTypesSelected = selectedTypes.size >= CONNECTION_TYPES.length;

  function handleReuseConnection(conn: ExistingConnection) {
    if (selectedConnectionIds.has(conn.id)) return;
    const entry: DataSourceEntry = {
      ...createSourceEntry(conn.type, sources.length === 0),
      name: conn.name,
      connectionId: conn.id,
      existing: true,
      testSuccess: true, // already tested when it was created
    };
    onChange([...sources, entry]);
    setShowTypeGrid(false);
  }

  function handleTypeToggle(type: ConnectionType) {
    // If this type is already added, don't toggle from the grid -- user removes via the card
    if (selectedTypes.has(type)) return;

    const newSource = createSourceEntry(type, sources.length === 0);
    const updated = [...sources, newSource];
    onChange(updated);
    setShowTypeGrid(false);
  }

  function handleRemoveSource(id: string) {
    const updated = sources.filter((s) => s.id !== id);
    onChange(updated);
    if (updated.length === 0) {
      setShowTypeGrid(true);
    }
  }

  function handleUpdateSource(id: string, patch: Partial<DataSourceEntry>) {
    const updated = sources.map((s) =>
      s.id === id ? { ...s, ...patch } : s
    );
    onChange(updated);
  }

  function handleAddAnother() {
    setShowTypeGrid(true);
  }

  return (
    <div className="space-y-6">
      {/* Selected sources */}
      {sources.length > 0 && (
        <div className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">
            Configured Data Sources
          </label>
          {sources.map((source) => {
            const meta = getConnectionMeta(source.type);
            const Icon = meta.icon;

            return (
              <div
                key={source.id}
                className={`rounded-lg border-2 ${meta.borderColor} ${meta.selectedBg} p-4 transition-all`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${meta.bgColor}`}>
                      <Icon className={`w-5 h-5 ${meta.color}`} />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 flex items-center gap-2">
                        {meta.name}
                        {source.existing && (
                          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
                            Reused — already tested &amp; mapped
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">
                        {source.existing ? source.name : meta.description}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSource(source.id)}
                    className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600 transition-colors"
                    aria-label={`Remove ${meta.name} source`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Name input */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Source Name
                    </label>
                    <input
                      type="text"
                      placeholder={`e.g. ${meta.name} Main Inverters`}
                      value={source.name}
                      onChange={(e) =>
                        handleUpdateSource(source.id, { name: e.target.value })
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  {/* Purpose dropdown */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Data Purpose
                    </label>
                    <div className="relative">
                      <select
                        value={source.purpose}
                        onChange={(e) =>
                          handleUpdateSource(source.id, {
                            purpose: e.target.value as DataSourcePurpose,
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none pr-8"
                      >
                        {PURPOSE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Type selection grid */}
      {showTypeGrid && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            {sources.length === 0
              ? 'How does this plant expose its data?'
              : 'Add Another Data Source'}
          </label>

          {/* Reuse an existing, already-tested connection — no credentials,
              no discovery; its confirmed mappings are shown for review. */}
          {existingConnections.length > 0 && (
            <div className="mb-5">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                  Reuse an existing connection
                </span>
                <span className="text-xs text-gray-400">
                  Already tested &amp; mapped in your Data Hub
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {existingConnections.map((conn) => {
                  const meta = CONNECTION_TYPES.find((t) => t.id === conn.type);
                  const Icon = meta?.icon ?? Link2;
                  const alreadyUsed = selectedConnectionIds.has(conn.id);
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      disabled={alreadyUsed}
                      onClick={() => handleReuseConnection(conn)}
                      className={`relative p-3 rounded-lg border-2 text-left transition-all ${
                        alreadyUsed
                          ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                          : 'border-blue-200 bg-blue-50/50 hover:border-blue-400 hover:bg-blue-50 cursor-pointer'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`shrink-0 inline-flex p-2 rounded-lg ${meta?.bgColor ?? 'bg-blue-100'}`}>
                          <Icon className={`w-4 h-4 ${meta?.color ?? 'text-blue-600'}`} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 text-sm truncate">{conn.name}</p>
                          <p className="text-xs text-gray-500 truncate flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                            {alreadyUsed
                              ? 'Already added'
                              : `Connected · ${conn._count?.field_mappings ?? 0} mapped fields · ${conn.plants_connected} plant${conn.plants_connected === 1 ? '' : 's'}`}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Prominent "try it now" path — a synthetic inverter feed so a new
              customer can see the whole platform light up before wiring a real
              vendor. Clearly badged as sample/sandbox data. */}
          {!selectedTypes.has('sample_api') && (
            <button
              type="button"
              onClick={() => (onChooseSample ? onChooseSample() : handleTypeToggle('sample_api'))}
              className="mb-5 flex w-full items-center gap-3 rounded-lg border-2 border-teal-300 bg-teal-50 p-3 text-left transition-all hover:border-teal-400 hover:bg-teal-100"
            >
              <div className="shrink-0 inline-flex p-2 rounded-lg bg-teal-100">
                <FlaskConical className="w-5 h-5 text-teal-600" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-900 text-sm">Try with sample data</p>
                  <span className="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Sample data
                  </span>
                </div>
                <p className="text-xs text-gray-600">
                  Generate a realistic synthetic inverter feed and see the full dashboard now — no credentials needed.
                </p>
              </div>
            </button>
          )}

          <div className="space-y-5">
            {SETUP_GROUPS.map((group) => {
              const typesInGroup = CONNECTION_TYPES.filter(
                (t) => t.setup === group.id && t.id !== 'sample_api',
              );
              if (typesInGroup.length === 0) return null;
              return (
                <div key={group.id}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                      {group.label}
                    </span>
                    <span className="text-xs text-gray-400">{group.hint}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {typesInGroup.map((type) => {
                      const Icon = type.icon;
                      const alreadyAdded = selectedTypes.has(type.id);
                      const availability = enforceAvailability
                        ? vendorAvailability(type.id)
                        : 'available';
                      const comingSoon = availability === 'coming_soon';
                      const disabled = alreadyAdded || comingSoon;
                      return (
                        <button
                          key={type.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => handleTypeToggle(type.id)}
                          className={`relative p-3 rounded-lg border-2 text-left transition-all
                            ${
                              disabled
                                ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                                : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer'
                            }
                          `}
                        >
                          {availability !== 'available' && (
                            <span
                              className={`absolute top-1.5 right-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                comingSoon ? 'bg-gray-200 text-gray-600' : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {AVAILABILITY_BADGE[availability as 'beta' | 'coming_soon']}
                            </span>
                          )}
                          <div className="flex items-center gap-2.5">
                            <div className={`shrink-0 inline-flex p-2 rounded-lg ${type.bgColor}`}>
                              <Icon className={`w-4 h-4 ${type.color}`} />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-gray-900 text-sm truncate">
                                {type.name}
                              </p>
                              <p className="text-xs text-gray-500 truncate">
                                {alreadyAdded
                                  ? 'Already added'
                                  : comingSoon
                                  ? 'Not yet available'
                                  : type.description}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add another source link */}
      {sources.length > 0 && !showTypeGrid && (
        <button
          type="button"
          onClick={handleAddAnother}
          disabled={allTypesSelected}
          className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors
            ${
              allTypesSelected
                ? 'text-gray-300 cursor-not-allowed'
                : 'text-blue-600 hover:text-blue-700'
            }
          `}
        >
          <Plus className="w-4 h-4" />
          Add another source
        </button>
      )}

      {/* Skip link */}
      <div className="pt-2 border-t border-gray-100">
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700 transition-colors"
        >
          I&apos;ll configure data sources later
        </button>
      </div>
    </div>
  );
}
