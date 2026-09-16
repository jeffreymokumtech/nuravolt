'use client';

import { useState, useEffect } from 'react';
import { Plus, X, ChevronDown, ChevronUp } from 'lucide-react';
import { InverterGroupConfig, DiscoveredInverter, WeatherStationConfig } from '@/types/onboarding';

interface Props {
  inverters: DiscoveredInverter[];
  groups: InverterGroupConfig[];
  onChange: (groups: InverterGroupConfig[]) => void;
  weatherStation: WeatherStationConfig;
  onWeatherStationChange: (ws: WeatherStationConfig) => void;
  connectionType?: string;
}

const ORIENTATION_PRESETS = [
  { name: 'South', azimuth: 180, tilt: 15 },
  { name: 'East', azimuth: 90, tilt: 10 },
  { name: 'West', azimuth: 270, tilt: 10 },
  { name: 'North', azimuth: 0, tilt: 10 },
];

export default function InverterGroupStep({ inverters, groups, onChange, weatherStation, onWeatherStationChange, connectionType }: Props) {
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupTilt, setNewGroupTilt] = useState(15);
  const [newGroupAzimuth, setNewGroupAzimuth] = useState(180);
  const [selectedInverters, setSelectedInverters] = useState<Set<string>>(new Set());

  // Equipment specs state
  const [newGroupModel, setNewGroupModel] = useState('');
  const [newGroupPower, setNewGroupPower] = useState(0);
  const [newGroupMpptCount, setNewGroupMpptCount] = useState(0);
  const [newGroupStringsPerMppt, setNewGroupStringsPerMppt] = useState(0);
  const [newGroupGammaPdc, setNewGroupGammaPdc] = useState(-0.004);
  const [showEquipment, setShowEquipment] = useState(false);

  const assignedInverterIds = new Set(groups.flatMap(g => g.inverterIds));
  const unassignedInverters = inverters.filter(inv => !assignedInverterIds.has(inv.id));

  // Auto-populate equipment specs from first selected inverter
  useEffect(() => {
    if (selectedInverters.size > 0 && !newGroupModel) {
      const firstId = Array.from(selectedInverters)[0];
      const inv = inverters.find(i => i.id === firstId);
      if (inv) {
        setNewGroupModel(inv.model);
        setNewGroupPower(inv.nominalPower_kW);
        setNewGroupMpptCount(inv.mpptCount);
        setNewGroupStringsPerMppt(inv.stringsPerMppt);
        setShowEquipment(true);
      }
    }
  }, [selectedInverters, inverters, newGroupModel]);

  const addGroup = () => {
    if (!newGroupName.trim()) return;
    const groupId = newGroupName.toLowerCase().replace(/\s+/g, '_');
    const newGroup: InverterGroupConfig = {
      groupId,
      name: newGroupName.trim(),
      tilt: newGroupTilt,
      azimuth: newGroupAzimuth,
      inverterIds: Array.from(selectedInverters),
      inverterModel: newGroupModel,
      inverterNominalPower_kW: newGroupPower,
      mpptCount: newGroupMpptCount,
      stringsPerMppt: newGroupStringsPerMppt,
      gammaPdc: newGroupGammaPdc,
    };
    onChange([...groups, newGroup]);
    setNewGroupName('');
    setSelectedInverters(new Set());
    setNewGroupModel('');
    setNewGroupPower(0);
    setNewGroupMpptCount(0);
    setNewGroupStringsPerMppt(0);
    setNewGroupGammaPdc(-0.004);
    setShowEquipment(false);
  };

  const removeGroup = (groupId: string) => {
    onChange(groups.filter(g => g.groupId !== groupId));
  };

  const toggleInverter = (inverterId: string) => {
    setSelectedInverters(prev => {
      const next = new Set(prev);
      if (next.has(inverterId)) {
        next.delete(inverterId);
      } else {
        next.add(inverterId);
      }
      return next;
    });
  };

  const selectAllUnassigned = () => {
    setSelectedInverters(new Set(unassignedInverters.map(inv => inv.id)));
  };

  const applyPreset = (preset: typeof ORIENTATION_PRESETS[0]) => {
    setNewGroupName(preset.name);
    setNewGroupAzimuth(preset.azimuth);
    setNewGroupTilt(preset.tilt);
  };

  const updateWeather = (partial: Partial<WeatherStationConfig>) => {
    onWeatherStationChange({ ...weatherStation, ...partial });
  };

  return (
    <div className="space-y-5">
      <div className="p-4 bg-blue-50 rounded-lg text-sm text-blue-700">
        Group inverters by roof orientation or physical zone, then configure equipment specs and on-site sensors.
      </div>

      {/* Existing groups */}
      {groups.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Configured Groups</h4>
          <div className="space-y-2">
            {groups.map(group => (
              <div key={group.groupId} className="p-3 bg-gray-50 rounded-lg flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900">{group.name}</span>
                  <span className="ml-2 text-sm text-gray-500">
                    {group.inverterIds.length} inv.
                    {group.inverterModel && <> | {group.inverterModel} {group.inverterNominalPower_kW}kW</>}
                    {' | '}{group.azimuth}° az | {group.tilt}° tilt
                  </span>
                </div>
                <button
                  onClick={() => removeGroup(group.groupId)}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add new group */}
      <div className="border border-gray-200 rounded-lg p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-700">Add Group</h4>

        {/* Quick presets */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Quick presets:</label>
          <div className="flex gap-2">
            {ORIENTATION_PRESETS.map(preset => (
              <button
                key={preset.name}
                onClick={() => applyPreset(preset)}
                className="px-3 py-1 text-xs border border-gray-200 rounded-full hover:bg-blue-50 hover:border-blue-300 transition-colors"
              >
                {preset.name} ({preset.azimuth}°)
              </button>
            ))}
          </div>
        </div>

        {/* Orientation row */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Group Name</label>
            <input
              type="text"
              placeholder="South"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Azimuth (°)</label>
            <input
              type="number"
              min={0}
              max={360}
              value={newGroupAzimuth}
              onChange={(e) => setNewGroupAzimuth(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tilt (°)</label>
            <input
              type="number"
              min={0}
              max={90}
              value={newGroupTilt}
              onChange={(e) => setNewGroupTilt(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
        </div>

        {/* Equipment specs toggle */}
        <button
          type="button"
          onClick={() => setShowEquipment(!showEquipment)}
          className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
        >
          {showEquipment ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Equipment Specifications
        </button>

        {showEquipment && (
          <div className="space-y-3 pl-2 border-l-2 border-blue-100">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Inverter Model</label>
                <input
                  type="text"
                  placeholder="SG50CX"
                  value={newGroupModel}
                  onChange={(e) => setNewGroupModel(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nominal Power (kW)</label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="50"
                  value={newGroupPower || ''}
                  onChange={(e) => setNewGroupPower(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Temp Coeff. (%/°C)</label>
                <input
                  type="number"
                  step="0.001"
                  value={newGroupGammaPdc}
                  onChange={(e) => setNewGroupGammaPdc(parseFloat(e.target.value) || -0.004)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
                <p className="text-xs text-gray-400 mt-0.5">-0.004 for c-Si, -0.002 for CdTe</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">MPPT Channels</label>
                <input
                  type="number"
                  min={1}
                  placeholder="6"
                  value={newGroupMpptCount || ''}
                  onChange={(e) => setNewGroupMpptCount(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Strings per MPPT</label>
                <input
                  type="number"
                  min={1}
                  placeholder="2"
                  value={newGroupStringsPerMppt || ''}
                  onChange={(e) => setNewGroupStringsPerMppt(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
            </div>
          </div>
        )}

        {/* Inverter selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700">
              Select Inverters ({selectedInverters.size} selected)
            </label>
            {unassignedInverters.length > 0 && (
              <button
                onClick={selectAllUnassigned}
                className="text-xs text-blue-600 hover:underline"
              >
                Select all unassigned ({unassignedInverters.length})
              </button>
            )}
          </div>
          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg">
            {unassignedInverters.length === 0 ? (
              <div className="p-3 text-sm text-gray-500 text-center">
                All inverters are assigned to groups
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {unassignedInverters.map(inv => (
                  <label
                    key={inv.id}
                    className="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedInverters.has(inv.id)}
                      onChange={() => toggleInverter(inv.id)}
                      className="mr-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm font-mono text-gray-800">{inv.id}</span>
                    <span className="ml-2 text-xs text-gray-500">
                      {inv.model} ({inv.nominalPower_kW} kW, {inv.mpptCount} MPPT)
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={addGroup}
          disabled={!newGroupName.trim() || (inverters.length > 0 && selectedInverters.size === 0)}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" />
          Add Group
        </button>
      </div>

      {/* Summary */}
      <div className="p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
        <div className="flex justify-between">
          <span>Total inverters: {inverters.length}</span>
          <span>Assigned: {assignedInverterIds.size}</span>
          <span>Unassigned: {unassignedInverters.length}</span>
        </div>
        {unassignedInverters.length > 0 && groups.length > 0 && (
          <p className="mt-1 text-amber-600 text-xs">
            {unassignedInverters.length} inverter{unassignedInverters.length !== 1 ? 's' : ''} not yet assigned to a group
          </p>
        )}
      </div>

      {/* Weather & Irradiance Sensors */}
      <div className="border border-gray-200 rounded-lg p-4 space-y-4">
        <h4 className="text-sm font-medium text-gray-700">Weather &amp; Irradiance Sensors</h4>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={weatherStation.hasOnSiteWeatherStation}
            onChange={(e) => updateWeather({
              hasOnSiteWeatherStation: e.target.checked,
              irradianceSensorType: e.target.checked ? (weatherStation.irradianceSensorType === 'none' ? 'reference_cell' : weatherStation.irradianceSensorType) : 'none',
              sensorMountedAtTilt: e.target.checked ? weatherStation.sensorMountedAtTilt : false,
            })}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">On-site weather station installed</span>
        </label>

        {weatherStation.hasOnSiteWeatherStation && (
          <div className="pl-6 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Irradiance Sensor Type</label>
              <select
                value={weatherStation.irradianceSensorType}
                onChange={(e) => updateWeather({ irradianceSensorType: e.target.value as WeatherStationConfig['irradianceSensorType'] })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="reference_cell">PV Reference Cell (recommended)</option>
                <option value="pyranometer">Pyranometer (thermopile)</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {weatherStation.irradianceSensorType === 'reference_cell'
                  ? 'Matches PV module spectral response, best for performance monitoring'
                  : 'Broad-spectrum measurement, good for GHI reference'}
              </p>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={weatherStation.sensorMountedAtTilt}
                onChange={(e) => updateWeather({ sensorMountedAtTilt: e.target.checked })}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Sensor mounted at array tilt (POA measurement)</span>
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={weatherStation.hasDustIQSensor}
            onChange={(e) => updateWeather({ hasDustIQSensor: e.target.checked })}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">DustIQ soiling sensor installed</span>
        </label>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            rows={2}
            placeholder="Additional sensor details..."
            value={weatherStation.notes}
            onChange={(e) => updateWeather({ notes: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
          />
        </div>
      </div>
    </div>
  );
}
