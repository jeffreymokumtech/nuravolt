'use client';

import { Sun, Wind, Battery, Layers, ShieldCheck, Globe2 } from 'lucide-react';
import { PlantConfig, PlantStorageConfig } from '@/types/onboarding';
import {
  COMPLIANCE_PACKS,
  COUNTRY_GROUPS,
  getCompliancePack,
} from '@/config/compliance';

/**
 * Storage nameplate collected when the asset type is a storage one (battery, or
 * solar plus storage). Lives on the wizard's plant config as `storage` and is
 * posted to /api/plants, which writes Plant.energy_capacity_mwh and the plant's
 * BessAsset row in the same transaction (src/lib/plants/create.ts,
 * BessAssetInput).
 *
 * The shape is owned by src/types/onboarding.ts and re-exported here under the
 * name this form has always used. It is an alias, not a second declaration: a
 * structural twin would narrow to `never` the moment the two drifted, and the
 * drift would only show up as a type error somewhere else entirely.
 */
export type BessStorageConfig = PlantStorageConfig;

export const EMPTY_STORAGE_CONFIG: BessStorageConfig = {
  energy_capacity_mwh: null,
  chemistry: '',
  rack_count: null,
  module_count: null,
  manufacturer: '',
  model: '',
  installation_date: '',
  max_continuous_c_rate: null,
  gb: { bmu_id: '', cmu_id: '' },
};

/**
 * PlantConfig already carries the optional storage branch, so this is a plain
 * alias kept for the call sites that name it.
 */
export type StoragePlantConfig = PlantConfig;

interface Props {
  config: StoragePlantConfig;
  onChange: (config: StoragePlantConfig) => void;
  discoveredName?: string;
  discoveredCapacity?: number;
}

// Timezones that make sense per supported country. Kept tiny on purpose, // users can still free-type any valid tz if we extend the select later.
const TIMEZONES_BY_COUNTRY: Record<string, string[]> = {
  ES: ['Europe/Madrid', 'Atlantic/Canary'],
  PT: ['Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores'],
  IT: ['Europe/Rome'],
  GB: ['Europe/London'],
  AE: ['Asia/Dubai'],
  SA: ['Asia/Riyadh'],
  KE: ['Africa/Nairobi'],
  NG: ['Africa/Lagos'],
  ZA: ['Africa/Johannesburg'],
};

// Mirrors BUSINESS_BANDS + DURATION_REFERENCE_HOURS in src/lib/billing/plan.ts.
// Duplicated rather than imported because that module pulls in Prisma and this
// is a client component; update both together.
const DURATION_REFERENCE_HOURS = 4;
const CAPACITY_BANDS = [
  { label: 'Business S', mwCap: 2 },
  { label: 'Business M', mwCap: 8 },
  { label: 'Business L', mwCap: 20 },
  { label: 'Business XL', mwCap: 60 },
];

const CHEMISTRIES: { value: BessStorageConfig['chemistry']; label: string }[] = [
  { value: '', label: 'Not declared' },
  { value: 'LFP', label: 'LFP (lithium iron phosphate)' },
  { value: 'NMC', label: 'NMC (nickel manganese cobalt)' },
  { value: 'NCA', label: 'NCA (nickel cobalt aluminium)' },
  { value: 'LTO', label: 'LTO (lithium titanate)' },
];

// HYBRID is a co-located site (generation plus storage on one grid connection).
// The server has always accepted it (AssetType in prisma/schema.prisma, and the
// storage branch in src/lib/plants/create.ts keys on BESS or HYBRID), so leaving
// it out of the picker made a whole asset class unreachable from the UI.
const ASSET_TYPES = [
  { id: 'SOLAR' as const, label: 'Solar PV', icon: Sun, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  { id: 'WIND' as const, label: 'Wind', icon: Wind, color: 'text-cyan-600', bg: 'bg-cyan-50 border-cyan-200' },
  { id: 'BESS' as const, label: 'Battery Storage', icon: Battery, color: 'text-green-600', bg: 'bg-green-50 border-green-200' },
  { id: 'HYBRID' as const, label: 'Solar plus storage', icon: Layers, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
];

/** Asset types that carry a battery, and so reveal the storage nameplate block. */
const STORAGE_ASSET_TYPES: PlantConfig['assetType'][] = ['BESS', 'HYBRID'];

export default function PlantConfigStep({ config, onChange, discoveredName, discoveredCapacity }: Props) {
  const update = (partial: Partial<StoragePlantConfig>) => {
    onChange({ ...config, ...partial });
  };

  const storage = config.storage ?? EMPTY_STORAGE_CONFIG;
  const updateStorage = (partial: Partial<BessStorageConfig>) => {
    update({ storage: { ...storage, ...partial } });
  };

  const pack = getCompliancePack(config.country);
  const timezoneOptions = TIMEZONES_BY_COUNTRY[config.country] ?? [config.timezone];

  const isStorageAsset = STORAGE_ASSET_TYPES.includes(config.assetType);
  // The billed size of this plant: max(rated MW, MWh / 4). Shown live so the
  // capacity band is legible before checkout, not a surprise after it.
  const energyMwh = storage.energy_capacity_mwh || 0;
  const equivalentMw = Math.max(config.capacity_MW || 0, energyMwh / DURATION_REFERENCE_HOURS);
  const band = CAPACITY_BANDS.find((b) => equivalentMw > 0 && equivalentMw <= b.mwCap);

  const onCountryChange = (country: string) => {
    const newPack = COMPLIANCE_PACKS[country];
    if (!newPack) {
      update({ country });
      return;
    }
    // Auto-fill timezone & currency-adjacent defaults when country changes.
    update({
      country,
      timezone: newPack.default_timezone,
    });
  };

  return (
    <div className="space-y-5">
      <div className="p-4 bg-blue-50 rounded-lg text-sm text-blue-700">
        Configure your plant details. The country drives reporting & grid-code defaults.
      </div>

      {/* Country first, it cascades timezone and compliance pack */}
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
          <Globe2 className="w-4 h-4 text-gray-500" />
          Country <span className="text-red-500">*</span>
        </label>
        <select
          value={config.country}
          onChange={(e) => onCountryChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          {COUNTRY_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.countries.map((iso) => {
                const p = COMPLIANCE_PACKS[iso];
                return (
                  <option key={iso} value={iso}>
                    {p.display_name} ({iso})
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1">
          Determines currency, timezone, grid code and regulatory reporting defaults.
        </p>
      </div>

      {pack && (
        <div className="p-4 rounded-lg border border-emerald-200 bg-emerald-50/60">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span className="text-sm font-semibold text-emerald-800">
              Compliance pack: {pack.display_name} · v{pack.version}
            </span>
          </div>
          <dl className="text-xs text-emerald-900/90 grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-emerald-700">Regulator</dt>
            <dd>{pack.regulator.name}</dd>
            <dt className="text-emerald-700">Grid operator</dt>
            <dd>{pack.grid_operator.name}</dd>
            <dt className="text-emerald-700">Grid code</dt>
            <dd>{pack.grid_code.reference}</dd>
            {/* meter_class and retention_years are optional on purpose: a pack
                that has not verified them omits them rather than guessing, so
                render only what the pack actually asserts. */}
            <dt className="text-emerald-700">Metering</dt>
            <dd>
              {[
                pack.metering.meter_class,
                `${pack.metering.interval_minutes} min`,
                pack.metering.retention_years ? `${pack.metering.retention_years}y retention` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </dl>
          {pack.reporting_obligations.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-emerald-800 mb-1">
                Applicable reports ({pack.reporting_obligations.length})
              </div>
              <ul className="text-xs text-emerald-900/90 space-y-0.5">
                {pack.reporting_obligations.map((o) => (
                  <li key={o.id}>
                    · {o.name} <span className="text-emerald-700">→ {o.recipient} ({o.cadence})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Plant Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          placeholder={discoveredName || 'My Solar Plant'}
          value={config.plantName}
          onChange={(e) => update({ plantName: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Location (city / region) <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          placeholder="Barcelona, Catalonia"
          value={config.location}
          onChange={(e) => update({ location: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Latitude</label>
          <input
            type="number"
            step="0.001"
            placeholder="41.385"
            value={config.latitude || ''}
            onChange={(e) => update({ latitude: parseFloat(e.target.value) || 0 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Longitude</label>
          <input
            type="number"
            step="0.001"
            placeholder="2.173"
            value={config.longitude || ''}
            onChange={(e) => update({ longitude: parseFloat(e.target.value) || 0 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Altitude (m)</label>
          <input
            type="number"
            step="1"
            placeholder="0"
            value={config.altitude || ''}
            onChange={(e) => update({ altitude: parseInt(e.target.value) || 0 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Meters above sea level</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Nominal Capacity (MW) <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            step="0.1"
            placeholder={discoveredCapacity?.toString() || '1.0'}
            value={config.capacity_MW || ''}
            onChange={(e) => update({ capacity_MW: parseFloat(e.target.value) || 0 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Installed Capacity (MW)
          </label>
          <input
            type="number"
            step="0.1"
            placeholder="Same as nominal"
            value={config.installed_MW ?? ''}
            onChange={(e) => update({ installed_MW: e.target.value ? parseFloat(e.target.value) : null })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Leave blank if same</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
          <select
            value={config.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Asset Type</label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {ASSET_TYPES.map(type => {
            const Icon = type.icon;
            const isSelected = config.assetType === type.id;
            return (
              <button
                key={type.id}
                onClick={() => update({ assetType: type.id })}
                className={`p-3 rounded-lg border-2 text-center transition-all ${
                  isSelected
                    ? `${type.bg} border-current`
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <Icon className={`w-6 h-6 mx-auto mb-1 ${isSelected ? type.color : 'text-gray-400'}`} />
                <span className={`text-sm font-medium ${isSelected ? type.color : 'text-gray-600'}`}>
                  {type.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isStorageAsset && (
        <div className="rounded-lg border border-green-200 bg-green-50/60 p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Battery className="w-4 h-4 text-green-600" />
            <span className="text-sm font-semibold text-green-800">Storage nameplate</span>
          </div>
          <p className="text-xs text-green-900/80">
            Energy capacity is required. It sets the plant&apos;s size for billing, and the
            warranty, cycling and dispatch models all work in energy, not power.
          </p>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Energy capacity (MWh) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                step="0.1"
                placeholder="200"
                value={storage.energy_capacity_mwh ?? ''}
                onChange={(e) =>
                  updateStorage({
                    energy_capacity_mwh: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Chemistry</label>
              <select
                value={storage.chemistry}
                onChange={(e) =>
                  updateStorage({ chemistry: e.target.value as BessStorageConfig['chemistry'] })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {CHEMISTRIES.map((c) => (
                  <option key={c.value || 'none'} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">Leave as not declared if unsure</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max continuous C rate
              </label>
              <input
                type="number"
                step="0.05"
                placeholder="0.5"
                value={storage.max_continuous_c_rate ?? ''}
                onChange={(e) =>
                  updateStorage({
                    max_continuous_c_rate: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Rack count</label>
              <input
                type="number"
                step="1"
                placeholder="80"
                value={storage.rack_count ?? ''}
                onChange={(e) =>
                  updateStorage({ rack_count: e.target.value ? parseInt(e.target.value) : null })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Module count</label>
              <input
                type="number"
                step="1"
                placeholder="960"
                value={storage.module_count ?? ''}
                onChange={(e) =>
                  updateStorage({ module_count: e.target.value ? parseInt(e.target.value) : null })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Install date</label>
              <input
                type="date"
                value={storage.installation_date}
                onChange={(e) => updateStorage({ installation_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Manufacturer</label>
              <input
                type="text"
                placeholder="Battery OEM"
                value={storage.manufacturer}
                onChange={(e) => updateStorage({ manufacturer: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
              <input
                type="text"
                placeholder="Product name"
                value={storage.model}
                onChange={(e) => updateStorage({ model: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {config.country === 'GB' && (
            <div className="rounded-lg border border-green-200 bg-white/70 p-3">
              <div className="text-sm font-medium text-gray-700 mb-1">
                Great Britain market identifiers
              </div>
              <p className="text-xs text-gray-500 mb-3">
                A declared BMU id lets us reconstruct your Balancing Mechanism revenue from
                public Elexon settlement data.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">BMU id</label>
                  <input
                    type="text"
                    placeholder="E_EXAMPLE-1"
                    value={storage.gb.bmu_id}
                    onChange={(e) =>
                      updateStorage({ gb: { ...storage.gb, bmu_id: e.target.value } })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">CMU id</label>
                  <input
                    type="text"
                    placeholder="CM_EXAMPLE"
                    value={storage.gb.cmu_id}
                    onChange={(e) =>
                      updateStorage({ gb: { ...storage.gb, cmu_id: e.target.value } })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
            </div>
          )}

          {equivalentMw > 0 && (
            <p className="text-xs text-green-900/80">
              This plant is {Math.round(equivalentMw * 100) / 100} equivalent MW, the larger of
              its {config.capacity_MW || 0} MW rating and {energyMwh} MWh divided by{' '}
              {DURATION_REFERENCE_HOURS}.{' '}
              {band
                ? `On its own that fits the ${band.label} band; plants you already manage count towards the same cap.`
                : 'That is above the largest self-serve band, so it needs an Enterprise plan.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
