'use client';

import AnonymizationToggle from '@/components/demo/AnonymizationToggle';
import { useDataSource } from '@/contexts/DataSourceContext';

export default function SettingsSection() {
  const { readOnly } = useDataSource();
  const disabled = readOnly;

  return (
    <div className="bg-white rounded-lg md:rounded-xl shadow-sm border border-divider p-6 md:p-8">
      <h2 className="text-xl font-semibold text-ink mb-4">Plant Settings</h2>

      {readOnly && (
        <div className="mb-6 rounded-lg border border-signal-warning/20 bg-signal-warning/10 p-4 text-sm text-signal-warning leading-relaxed">
          <strong>Read-only showcase.</strong> In production, operators configure alert
          thresholds, notification channels, and integration settings here. All inputs
          below are disabled for the public demo.
        </div>
      )}

      <div className="space-y-6">
        {/* Alert Thresholds */}
        <div className="border-b border-divider pb-6">
          <h3 className="text-lg font-medium text-ink mb-3">Alert Thresholds</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                Soiling Loss Alert (%)
              </label>
              <input
                type="number"
                defaultValue={5}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                Performance Ratio Alert (%)
              </label>
              <input
                type="number"
                defaultValue={75}
                disabled={disabled}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
              />
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div className="border-b border-divider pb-6">
          <h3 className="text-lg font-medium text-ink mb-3">Notifications</h3>
          <div className="space-y-3">
            <label className={`flex items-center gap-3 ${disabled ? 'opacity-60' : ''}`}>
              <input type="checkbox" defaultChecked disabled={disabled} className="w-4 h-4 text-blue-600 rounded" />
              <span className="text-ink-2">Email alerts for critical issues</span>
            </label>
            <label className={`flex items-center gap-3 ${disabled ? 'opacity-60' : ''}`}>
              <input type="checkbox" defaultChecked disabled={disabled} className="w-4 h-4 text-blue-600 rounded" />
              <span className="text-ink-2">Daily performance summary</span>
            </label>
            <label className={`flex items-center gap-3 ${disabled ? 'opacity-60' : ''}`}>
              <input type="checkbox" disabled={disabled} className="w-4 h-4 text-blue-600 rounded" />
              <span className="text-ink-2">Weekly cleaning recommendations</span>
            </label>
          </div>
        </div>

        {/* Privacy & Anonymization */}
        <div className="border-b border-divider pb-6">
          <h3 className="text-lg font-medium text-ink mb-3">Privacy & Anonymization</h3>
          <AnonymizationToggle variant="full" />
        </div>

        {/* Data Integration */}
        <div>
          <h3 className="text-lg font-medium text-ink mb-3">Data Integration</h3>
          <div className="bg-paper rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-ink">Huawei FusionSolar</p>
                <p className="text-sm text-ink-3">Demo feed for this plant</p>
              </div>
              <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                Demo
              </span>
            </div>
          </div>
        </div>

        {/* Language */}
        <div className="border-b border-divider pb-6">
          <h3 className="text-lg font-medium text-ink mb-3">Language</h3>
          <div className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-ink-2">
            English
          </div>
          <p className="text-xs text-ink-3 mt-2">Interface language is English.</p>
        </div>

        {/* Demo Notice */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
          <p className="text-sm text-blue-700">
            Demo view. Preferences here are illustrative and reset between sessions.
          </p>
        </div>
      </div>
    </div>
  );
}
