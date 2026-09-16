'use client';

import { useState, useCallback } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  HelpCircle,
  Zap,
  X,
  GripVertical,
} from 'lucide-react';

// Field types available in NuraVolt standard
const NURAVOLT_FIELD_TYPES = [
  { value: 'power_ac', label: 'AC Power', unit: 'kW', category: 'power' },
  { value: 'power_dc', label: 'DC Power', unit: 'kW', category: 'power' },
  { value: 'voltage_ac', label: 'AC Voltage', unit: 'V', category: 'electrical' },
  { value: 'voltage_dc', label: 'DC Voltage', unit: 'V', category: 'electrical' },
  { value: 'current_ac', label: 'AC Current', unit: 'A', category: 'electrical' },
  { value: 'current_dc', label: 'DC Current', unit: 'A', category: 'electrical' },
  { value: 'irradiance_poa', label: 'POA Irradiance', unit: 'W/m²', category: 'irradiance' },
  { value: 'irradiance_ghi', label: 'GHI Irradiance', unit: 'W/m²', category: 'irradiance' },
  { value: 'temp_module', label: 'Module Temperature', unit: '°C', category: 'temperature' },
  { value: 'temp_ambient', label: 'Ambient Temperature', unit: '°C', category: 'temperature' },
  { value: 'temp_inverter', label: 'Inverter Temperature', unit: '°C', category: 'temperature' },
  { value: 'energy_total', label: 'Total Energy', unit: 'kWh', category: 'energy' },
  { value: 'energy_daily', label: 'Daily Energy', unit: 'kWh', category: 'energy' },
  { value: 'frequency', label: 'Grid Frequency', unit: 'Hz', category: 'electrical' },
  { value: 'power_factor', label: 'Power Factor', unit: '', category: 'electrical' },
  { value: 'reactive_power', label: 'Reactive Power', unit: 'kVAR', category: 'power' },
  { value: 'soiling_ratio', label: 'Soiling Ratio', unit: '', category: 'performance' },
  { value: 'performance_ratio', label: 'Performance Ratio', unit: '%', category: 'performance' },
  { value: 'wind_speed', label: 'Wind Speed', unit: 'm/s', category: 'weather' },
  { value: 'humidity', label: 'Humidity', unit: '%', category: 'weather' },
  { value: 'precipitation', label: 'Precipitation', unit: 'mm', category: 'weather' },
  { value: 'status_code', label: 'Status Code', unit: '', category: 'status' },
  { value: 'error_code', label: 'Error Code', unit: '', category: 'status' },
  { value: 'timestamp', label: 'Timestamp', unit: '', category: 'meta' },
  { value: 'plant_id', label: 'Plant ID', unit: '', category: 'meta' },
  { value: 'inverter_id', label: 'Inverter ID', unit: '', category: 'meta' },
  { value: 'string_id', label: 'String ID', unit: '', category: 'meta' },
  { value: 'unmapped', label: 'Unmapped', unit: '', category: 'other' },
];

const FIELD_CATEGORIES = [
  { id: 'power', label: 'Power', color: 'bg-blue-100 text-blue-700' },
  { id: 'electrical', label: 'Electrical', color: 'bg-purple-100 text-purple-700' },
  { id: 'irradiance', label: 'Irradiance', color: 'bg-yellow-100 text-yellow-700' },
  { id: 'temperature', label: 'Temperature', color: 'bg-red-100 text-red-700' },
  { id: 'energy', label: 'Energy', color: 'bg-green-100 text-green-700' },
  { id: 'weather', label: 'Weather', color: 'bg-cyan-100 text-cyan-700' },
  { id: 'performance', label: 'Performance', color: 'bg-orange-100 text-orange-700' },
  { id: 'status', label: 'Status', color: 'bg-gray-100 text-gray-700' },
  { id: 'meta', label: 'Meta', color: 'bg-indigo-100 text-indigo-700' },
  { id: 'other', label: 'Other', color: 'bg-gray-100 text-gray-500' },
];

interface FieldMapping {
  id?: string;
  source_field: string;
  target_field: string;
  confidence: number;
  unit?: string;
  sample_values?: (string | number)[];
  detected_unit?: string;
  component_id?: string;
  is_confirmed: boolean;
}

interface Props {
  connectionId: string;
  initialMappings: FieldMapping[];
  onMappingsChange?: (mappings: FieldMapping[]) => void;
  onConfirm?: (mappings: FieldMapping[]) => void;
}

export default function FieldMapper({
  connectionId,
  initialMappings,
  onMappingsChange,
  onConfirm,
}: Props) {
  const [mappings, setMappings] = useState<FieldMapping[]>(initialMappings);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  // Get confidence badge color
  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 85) {
      return { color: 'bg-green-100 text-green-700 border-green-200', label: 'High' };
    } else if (confidence >= 60) {
      return { color: 'bg-yellow-100 text-yellow-700 border-yellow-200', label: 'Medium' };
    } else {
      return { color: 'bg-red-100 text-red-700 border-red-200', label: 'Low' };
    }
  };

  // Update a single mapping
  const updateMapping = useCallback((sourceField: string, targetField: string) => {
    setMappings(prev => {
      const updated = prev.map(m =>
        m.source_field === sourceField
          ? { ...m, target_field: targetField, is_confirmed: true }
          : m
      );
      onMappingsChange?.(updated);
      return updated;
    });
  }, [onMappingsChange]);

  // Confirm a mapping (mark as user-confirmed)
  const confirmMapping = useCallback((sourceField: string) => {
    setMappings(prev => {
      const updated = prev.map(m =>
        m.source_field === sourceField
          ? { ...m, is_confirmed: true }
          : m
      );
      onMappingsChange?.(updated);
      return updated;
    });
  }, [onMappingsChange]);

  // Clear a mapping
  const clearMapping = useCallback((sourceField: string) => {
    setMappings(prev => {
      const updated = prev.map(m =>
        m.source_field === sourceField
          ? { ...m, target_field: 'unmapped', is_confirmed: false }
          : m
      );
      onMappingsChange?.(updated);
      return updated;
    });
  }, [onMappingsChange]);

  // Map all high-confidence fields
  const mapAllHighConfidence = useCallback(() => {
    setMappings(prev => {
      const updated = prev.map(m =>
        m.confidence >= 85 && !m.is_confirmed
          ? { ...m, is_confirmed: true }
          : m
      );
      onMappingsChange?.(updated);
      return updated;
    });
  }, [onMappingsChange]);

  // Drag and drop handlers
  const handleDragStart = (sourceField: string) => {
    setDraggedField(sourceField);
  };

  const handleDragOver = (e: React.DragEvent, targetField: string) => {
    e.preventDefault();
    setDropTarget(targetField);
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = (targetField: string) => {
    if (draggedField) {
      updateMapping(draggedField, targetField);
    }
    setDraggedField(null);
    setDropTarget(null);
  };

  // Save mappings to API
  const saveMappings = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/connections/${connectionId}/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings }),
      });
      if (!response.ok) throw new Error('Failed to save mappings');
      onConfirm?.(mappings);
    } catch (error) {
      console.error('Error saving mappings:', error);
    } finally {
      setSaving(false);
    }
  };

  // Filter mappings
  const filteredMappings = mappings.filter(m => {
    if (showUnmappedOnly && m.target_field !== 'unmapped') return false;
    if (filterCategory) {
      const targetType = NURAVOLT_FIELD_TYPES.find(f => f.value === m.target_field);
      if (targetType?.category !== filterCategory) return false;
    }
    return true;
  });

  // Group by confidence level
  const highConfidence = filteredMappings.filter(m => m.confidence >= 85);
  const mediumConfidence = filteredMappings.filter(m => m.confidence >= 60 && m.confidence < 85);
  const lowConfidence = filteredMappings.filter(m => m.confidence < 60);

  // Stats
  const confirmedCount = mappings.filter(m => m.is_confirmed).length;
  const unmappedCount = mappings.filter(m => m.target_field === 'unmapped').length;
  const highConfidenceUnconfirmed = highConfidence.filter(m => !m.is_confirmed).length;

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Total Fields</p>
          <p className="text-2xl font-bold text-gray-900">{mappings.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Confirmed</p>
          <p className="text-2xl font-bold text-green-600">{confirmedCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Needs Review</p>
          <p className="text-2xl font-bold text-yellow-600">{mediumConfidence.length + lowConfidence.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Unmapped</p>
          <p className="text-2xl font-bold text-red-600">{unmappedCount}</p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Category Filter */}
          <select
            value={filterCategory || ''}
            onChange={(e) => setFilterCategory(e.target.value || null)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Categories</option>
            {FIELD_CATEGORIES.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.label}</option>
            ))}
          </select>

          {/* Show unmapped only */}
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showUnmappedOnly}
              onChange={(e) => setShowUnmappedOnly(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Show unmapped only
          </label>
        </div>

        {/* Bulk Actions */}
        {highConfidenceUnconfirmed > 0 && (
          <button
            onClick={mapAllHighConfidence}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            <Zap className="w-4 h-4" />
            Confirm All High-Confidence ({highConfidenceUnconfirmed})
          </button>
        )}
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-2 gap-6">
        {/* Source Fields Column */}
        <div className="space-y-2">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            Source Fields
            <span className="text-sm font-normal text-gray-500">
              (from your data source)
            </span>
          </h3>

          <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
            {filteredMappings.map((mapping) => {
              const badge = getConfidenceBadge(mapping.confidence);
              const targetType = NURAVOLT_FIELD_TYPES.find(f => f.value === mapping.target_field);
              const category = FIELD_CATEGORIES.find(c => c.id === targetType?.category);
              const isExpanded = expandedSource === mapping.source_field;

              return (
                <div
                  key={mapping.source_field}
                  draggable
                  onDragStart={() => handleDragStart(mapping.source_field)}
                  className={`p-3 bg-white hover:bg-gray-50 transition-colors cursor-grab ${
                    draggedField === mapping.source_field ? 'opacity-50' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-2">
                      <GripVertical className="w-4 h-4 text-gray-400 mt-1 flex-shrink-0" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 text-sm">
                            {mapping.source_field}
                          </span>
                          {mapping.detected_unit && (
                            <span className="text-xs text-gray-500">
                              ({mapping.detected_unit})
                            </span>
                          )}
                        </div>
                        {mapping.sample_values && mapping.sample_values.length > 0 && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Sample: {mapping.sample_values.slice(0, 3).join(', ')}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${badge.color}`}>
                        {mapping.confidence}%
                      </span>
                      <button
                        onClick={() => setExpandedSource(isExpanded ? null : mapping.source_field)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Mapping Status */}
                  <div className="mt-2 flex items-center gap-2">
                    <ArrowRight className="w-4 h-4 text-gray-400" />
                    {mapping.target_field !== 'unmapped' ? (
                      <div className="flex items-center gap-2">
                        {category && (
                          <span className={`px-2 py-0.5 rounded text-xs ${category.color}`}>
                            {category.label}
                          </span>
                        )}
                        <span className="text-sm text-gray-700">{targetType?.label || mapping.target_field}</span>
                        {mapping.is_confirmed ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <HelpCircle className="w-4 h-4 text-yellow-500" />
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400 italic">Not mapped</span>
                    )}
                  </div>

                  {/* Expanded Actions */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={mapping.target_field}
                          onChange={(e) => updateMapping(mapping.source_field, e.target.value)}
                          className="flex-1 px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="unmapped">-- Select mapping --</option>
                          {FIELD_CATEGORIES.map(cat => (
                            <optgroup key={cat.id} label={cat.label}>
                              {NURAVOLT_FIELD_TYPES
                                .filter(f => f.category === cat.id)
                                .map(field => (
                                  <option key={field.value} value={field.value}>
                                    {field.label} {field.unit && `(${field.unit})`}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                        </select>
                        {mapping.target_field !== 'unmapped' && !mapping.is_confirmed && (
                          <button
                            onClick={() => confirmMapping(mapping.source_field)}
                            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                          >
                            Confirm
                          </button>
                        )}
                        {mapping.target_field !== 'unmapped' && (
                          <button
                            onClick={() => clearMapping(mapping.source_field)}
                            className="p-1.5 text-gray-400 hover:text-red-600"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Target Fields Column */}
        <div className="space-y-2">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            NuraVolt Standard Fields
            <span className="text-sm font-normal text-gray-500">
              (drop fields here to map)
            </span>
          </h3>

          <div className="border border-gray-200 rounded-lg max-h-[600px] overflow-y-auto">
            {FIELD_CATEGORIES.map(category => {
              const categoryFields = NURAVOLT_FIELD_TYPES.filter(f => f.category === category.id);
              const mappedToCategory = mappings.filter(m => {
                const targetType = NURAVOLT_FIELD_TYPES.find(f => f.value === m.target_field);
                return targetType?.category === category.id;
              });

              return (
                <div key={category.id} className="border-b border-gray-100 last:border-0">
                  <div className={`px-3 py-2 ${category.color} font-medium text-sm`}>
                    {category.label} ({mappedToCategory.length} mapped)
                  </div>
                  <div className="p-2 space-y-1">
                    {categoryFields.map(field => {
                      const mappedFields = mappings.filter(m => m.target_field === field.value);
                      const isDropTarget = dropTarget === field.value;

                      return (
                        <div
                          key={field.value}
                          onDragOver={(e) => handleDragOver(e, field.value)}
                          onDragLeave={handleDragLeave}
                          onDrop={() => handleDrop(field.value)}
                          className={`p-2 rounded border-2 border-dashed transition-colors ${
                            isDropTarget
                              ? 'border-blue-500 bg-blue-50'
                              : mappedFields.length > 0
                              ? 'border-green-200 bg-green-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="text-sm font-medium text-gray-900">
                                {field.label}
                              </span>
                              {field.unit && (
                                <span className="text-xs text-gray-500 ml-1">
                                  ({field.unit})
                                </span>
                              )}
                            </div>
                            {mappedFields.length > 0 && (
                              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">
                                {mappedFields.length} mapped
                              </span>
                            )}
                          </div>
                          {mappedFields.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {mappedFields.map(m => (
                                <span
                                  key={m.source_field}
                                  className="text-xs bg-white border border-gray-200 px-2 py-0.5 rounded"
                                >
                                  {m.source_field}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Confidence Groups Summary */}
      <div className="bg-gray-50 rounded-lg p-4">
        <h4 className="font-medium text-gray-900 mb-3">Mapping Summary by Confidence</h4>
        <div className="grid grid-cols-3 gap-4">
          {/* High Confidence */}
          <div className="bg-white rounded-lg border border-green-200 p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-full bg-green-500" />
              <span className="font-medium text-gray-900">High Confidence ({'>'}85%)</span>
            </div>
            <p className="text-2xl font-bold text-green-600">{highConfidence.length}</p>
            <p className="text-xs text-gray-500">
              {highConfidence.filter(m => m.is_confirmed).length} confirmed
            </p>
          </div>

          {/* Medium Confidence */}
          <div className="bg-white rounded-lg border border-yellow-200 p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <span className="font-medium text-gray-900">Medium Confidence (60-85%)</span>
            </div>
            <p className="text-2xl font-bold text-yellow-600">{mediumConfidence.length}</p>
            <p className="text-xs text-gray-500">
              {mediumConfidence.filter(m => m.is_confirmed).length} confirmed
            </p>
          </div>

          {/* Low Confidence */}
          <div className="bg-white rounded-lg border border-red-200 p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="font-medium text-gray-900">Low Confidence ({'<'}60%)</span>
            </div>
            <p className="text-2xl font-bold text-red-600">{lowConfidence.length}</p>
            <p className="text-xs text-gray-500">
              {lowConfidence.filter(m => m.is_confirmed).length} confirmed
            </p>
          </div>
        </div>
      </div>

      {/* Warning for unconfirmed low-confidence */}
      {lowConfidence.filter(m => !m.is_confirmed).length > 0 && (
        <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-yellow-800">Review Required</h4>
            <p className="text-sm text-yellow-700 mt-1">
              {lowConfidence.filter(m => !m.is_confirmed).length} fields have low confidence scores
              and need manual review before proceeding.
            </p>
          </div>
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end pt-4 border-t border-gray-200">
        <button
          onClick={saveMappings}
          disabled={saving || unmappedCount === mappings.length}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : 'Save Mappings & Continue'}
        </button>
      </div>
    </div>
  );
}
