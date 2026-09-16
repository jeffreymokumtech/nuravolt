/**
 * DataLabelingPanel - UI for managing user labels/annotations
 *
 * Features:
 * - Add new labels with type, description, and notes
 * - List existing labels with edit/delete capabilities
 * - Export labels as JSON
 * - Import labels from JSON
 * - Filter labels by type
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { 
  Plus, 
  List, 
  Download, 
  Upload, 
  Calendar, 
  Tag, 
  FileText, 
  Check, 
  X, 
  Edit2, 
  Trash2,
  AlertTriangle,
  Droplets,
  Wind,
  Wrench,
  Info,
  RefreshCw
} from 'lucide-react';
import type { DataLabel, LabelType } from '@/types/soiling';

// Label type configuration
const LABEL_TYPES: Array<{
  value: LabelType;
  label: string;
  Icon: any;
  color: string;
  description: string;
}> = [
  {
    value: 'rain_cleaning',
    label: 'Rain Cleaning',
    Icon: Droplets,
    color: '#3B82F6',
    description: 'Natural cleaning event from rain (>5mm)',
  },
  {
    value: 'dust_event',
    label: 'Dust Event',
    Icon: Wind,
    color: '#92400E',
    description: 'Dust storm or high particulate event',
  },
  {
    value: 'manual_cleaning',
    label: 'Manual Cleaning',
    Icon: Wrench,
    color: '#10B981',
    description: 'Scheduled or manual panel cleaning',
  },
  {
    value: 'anomaly',
    label: 'Anomaly',
    Icon: AlertTriangle,
    color: '#EF4444',
    description: 'Unusual data point requiring investigation',
  },
  {
    value: 'other',
    label: 'Other',
    Icon: FileText,
    color: '#6B7280',
    description: 'Other observation or note',
  },
];

interface DataLabelingPanelProps {
  plantId: string;
  labels: DataLabel[];
  selectedDate?: string;
  onAddLabel: (label: Omit<DataLabel, 'id' | 'createdAt'>) => Promise<void>;
  onUpdateLabel: (label: DataLabel) => Promise<void>;
  onDeleteLabel: (id: string) => Promise<void>;
  onClose?: () => void;
  isLoading?: boolean;
  className?: string;
}

export function DataLabelingPanel({
  plantId,
  labels,
  selectedDate,
  onAddLabel,
  onUpdateLabel,
  onDeleteLabel,
  onClose,
  isLoading = false,
  className = '',
}: DataLabelingPanelProps) {
  const [activeTab, setActiveTab] = useState<'add' | 'list' | 'export'>('add');
  const [filterType, setFilterType] = useState<LabelType | 'all'>('all');
  const [editingLabel, setEditingLabel] = useState<DataLabel | null>(null);

  // Form state for new/edit label
  const [formData, setFormData] = useState({
    date: selectedDate || format(new Date(), 'yyyy-MM-dd'),
    type: 'rain_cleaning' as LabelType,
    label: '',
    notes: '',
  });

  // Update form when selectedDate changes
  useMemo(() => {
    if (selectedDate) {
      setFormData(prev => ({ ...prev, date: selectedDate }));
      setActiveTab('add');
    }
  }, [selectedDate]);

  // Reset form
  const resetForm = useCallback(() => {
    setFormData({
      date: selectedDate || format(new Date(), 'yyyy-MM-dd'),
      type: 'rain_cleaning',
      label: '',
      notes: '',
    });
    setEditingLabel(null);
  }, [selectedDate]);

  // Handle form submit
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.label.trim()) return;

    try {
      if (editingLabel) {
        await onUpdateLabel({
          ...editingLabel,
          date: formData.date,
          type: formData.type,
          label: formData.label.trim(),
          notes: formData.notes.trim() || undefined,
        });
      } else {
        await onAddLabel({
          date: formData.date,
          type: formData.type,
          label: formData.label.trim(),
          notes: formData.notes.trim() || undefined,
        });
      }
      resetForm();
    } catch (error) {
      console.error('Error saving label:', error);
    }
  }, [formData, editingLabel, onAddLabel, onUpdateLabel, resetForm]);

  // Handle edit click
  const handleEdit = useCallback((label: DataLabel) => {
    setEditingLabel(label);
    setFormData({
      date: label.date,
      type: label.type,
      label: label.label,
      notes: label.notes || '',
    });
    setActiveTab('add');
  }, []);

  // Handle delete click
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Are you sure you want to delete this label?')) return;
    try {
      await onDeleteLabel(id);
    } catch (error) {
      console.error('Error deleting label:', error);
    }
  }, [onDeleteLabel]);

  // Filter labels
  const filteredLabels = useMemo(() => {
    let result = [...labels];
    if (filterType !== 'all') {
      result = result.filter(l => l.type === filterType);
    }
    return result.sort((a, b) => b.date.localeCompare(a.date));
  }, [labels, filterType]);

  // Export labels as JSON
  const handleExport = useCallback(() => {
    const exportData = {
      plantId,
      exportedAt: new Date().toISOString(),
      labels,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${plantId}_labels_${format(new Date(), 'yyyy-MM-dd')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [plantId, labels]);

  // Import labels from JSON
  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.labels || !Array.isArray(data.labels)) {
        alert('Invalid labels file format');
        return;
      }

      // Add each label (skip duplicates)
      const existingDates = new Set(labels.map(l => `${l.date}-${l.type}`));
      let imported = 0;

      for (const label of data.labels) {
        const key = `${label.date}-${label.type}`;
        if (!existingDates.has(key)) {
          await onAddLabel({
            date: label.date,
            type: label.type,
            label: label.label,
            notes: label.notes,
          });
          imported++;
        }
      }

      alert(`Imported ${imported} labels (${data.labels.length - imported} duplicates skipped)`);
    } catch (error) {
      alert('Error importing labels: ' + (error as Error).message);
    }

    // Reset file input
    e.target.value = '';
  }, [labels, onAddLabel]);

  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden flex flex-col ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-gray-50 border-b border-gray-200">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
          <Tag className="w-4 h-4 text-blue-600" />
          Data Labels
          <span className="text-[10px] font-bold bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
            {labels.length}
          </span>
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex bg-white border-b border-gray-100">
        <button
          onClick={() => setActiveTab('add')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'add'
              ? 'text-blue-600 border-blue-600 bg-blue-50/30'
              : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          {editingLabel ? <Edit2 className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
          {editingLabel ? 'Edit' : 'Add'}
        </button>
        <button
          onClick={() => setActiveTab('list')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'list'
              ? 'text-blue-600 border-blue-600 bg-blue-50/30'
              : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          <List className="w-3 h-3" />
          List
        </button>
        <button
          onClick={() => setActiveTab('export')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
            activeTab === 'export'
              ? 'text-blue-600 border-blue-600 bg-blue-50/30'
              : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Download className="w-3 h-3" />
          IO
        </button>
      </div>

      {/* Content */}
      <div className="p-4 flex-1 overflow-y-auto max-h-[500px]">
        {/* Add/Edit Label Form */}
        {activeTab === 'add' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Date */}
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
                Event Date
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                  className="w-full pl-10 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  required
                />
              </div>
            </div>

            {/* Type */}
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
                Label Category
              </label>
              <div className="grid grid-cols-1 gap-2">
                {LABEL_TYPES.map((type) => {
                  const Icon = type.Icon;
                  return (
                    <button
                      key={type.value}
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, type: type.value }))}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all text-left ${
                        formData.type === type.value
                          ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-500/10'
                          : 'border-gray-100 bg-gray-50/50 text-gray-500 hover:border-gray-300 hover:bg-white'
                      }`}
                    >
                      <div 
                        className="p-1.5 rounded-md bg-white shadow-sm"
                        style={{ color: type.color }}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-bold">{type.label}</div>
                        <div className="text-[10px] opacity-70 leading-tight">{type.description}</div>
                      </div>
                      {formData.type === type.value && (
                        <Check className="w-4 h-4 ml-auto text-blue-600" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Label text */}
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
                Display Title
              </label>
              <input
                type="text"
                value={formData.label}
                onChange={(e) => setFormData(prev => ({ ...prev, label: e.target.value }))}
                placeholder="Brief summary..."
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                required
                maxLength={100}
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
                Additional Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Provide context..."
                rows={3}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none"
                maxLength={500}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={isLoading || !formData.label.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-all shadow-md active:scale-[0.98]"
              >
                {isLoading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                {editingLabel ? 'Update Label' : 'Save Label'}
              </button>
              {editingLabel && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-bold rounded-lg transition-all"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        {/* Labels List */}
        {activeTab === 'list' && (
          <div className="space-y-4">
            {/* Filter */}
            <div className="flex flex-wrap gap-1.5 pb-4 border-b border-gray-100">
              <button
                onClick={() => setFilterType('all')}
                className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full transition-all border ${
                  filterType === 'all'
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
                }`}
              >
                All
              </button>
              {LABEL_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setFilterType(type.value)}
                  className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full transition-all border ${
                    filterType === type.value
                      ? 'text-white border-transparent shadow-sm'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
                  }`}
                  style={{
                    backgroundColor: filterType === type.value ? type.color : undefined,
                  }}
                >
                  {type.label}
                </button>
              ))}
            </div>

            {/* Labels */}
            <div className="space-y-3 pt-2">
              {filteredLabels.length === 0 ? (
                <div className="text-center py-12 flex flex-col items-center gap-2">
                  <Info className="w-8 h-8 text-gray-200" />
                  <p className="text-gray-400 text-xs font-medium">
                    No labels found
                  </p>
                </div>
              ) : (
                filteredLabels.map((label) => {
                  const typeConfig = LABEL_TYPES.find(t => t.value === label.type);
                  const Icon = typeConfig?.Icon || FileText;
                  return (
                    <div
                      key={label.id}
                      className="group flex items-start gap-3 p-3 bg-white border border-gray-100 rounded-xl hover:border-blue-300 hover:shadow-md transition-all"
                    >
                      <div 
                        className="p-2 rounded-lg bg-gray-50 flex-shrink-0"
                        style={{ color: typeConfig?.color }}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                            {format(parseISO(label.date), 'MMM d, yyyy')}
                          </span>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => handleEdit(label)}
                              className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                              title="Edit label"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(label.id)}
                              className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                              title="Delete label"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <p className="text-sm font-bold text-gray-900 leading-tight mt-0.5">
                          {label.label}
                        </p>
                        {label.notes && (
                          <p className="text-xs text-gray-500 mt-1 line-clamp-2 italic border-l-2 border-gray-100 pl-2">
                            {label.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Export/Import */}
        {activeTab === 'export' && (
          <div className="space-y-6">
            <div className="p-5 bg-blue-50 border border-blue-100 rounded-xl shadow-sm">
              <h4 className="text-sm font-bold text-blue-900 mb-2 flex items-center gap-2">
                <Upload className="w-4 h-4" />
                Export Data
              </h4>
              <p className="text-xs text-blue-700/70 mb-4 leading-relaxed">
                Download all labels as a portable JSON file for backup or cross-plant analysis.
              </p>
              <button
                onClick={handleExport}
                disabled={labels.length === 0}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-all shadow-md"
              >
                Download JSON ({labels.length} entries)
              </button>
            </div>

            <div className="p-5 bg-emerald-50 border border-emerald-100 rounded-xl shadow-sm">
              <h4 className="text-sm font-bold text-emerald-900 mb-2 flex items-center gap-2">
                <Download className="w-4 h-4" />
                Import Data
              </h4>
              <p className="text-xs text-emerald-700/70 mb-4 leading-relaxed">
                Restore labels from a previous export. System will skip identical duplicates.
              </p>
              <label className="block w-full text-center py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg transition-all shadow-md cursor-pointer">
                Select File
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleImport}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="p-3 bg-gray-50 border-t border-gray-100">
        <div className="flex items-center gap-2 text-[10px] text-gray-400 font-bold uppercase tracking-wider justify-center">
          <Info className="w-3 h-3" />
          <span>Click on chart timeline to add new labels</span>
        </div>
      </div>
    </div>
  );
}

export default DataLabelingPanel;