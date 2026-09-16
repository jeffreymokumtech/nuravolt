'use client';

import { Map, Sun, Link, AlertTriangle, Lightbulb, CheckCircle, Info, RefreshCw } from 'lucide-react';
import type {
  UniformityAlert,
  IrradianceQualityAlert,
  AlertSeverity,
} from '@/types/soiling';

// Combined alert type that can be from any quality check
export interface QualityAlert {
  id: string;
  source: 'spatial' | 'irradiance' | 'correlation';
  type: string;
  severity: AlertSeverity;
  message: string;
  recommendation?: string;
  timestamp?: string;
  affectedZones?: string[];
}

interface QualityAlertsPanelProps {
  spatialAlerts?: UniformityAlert[];
  irradianceAlerts?: IrradianceQualityAlert[];
  correlationRecommendations?: string[];
  isLoading?: boolean;
  maxAlerts?: number;
}

// Map severity to badge color
function getSeverityBadge(severity: AlertSeverity): string {
  switch (severity) {
    case 'high':
      return 'badge-error';
    case 'medium':
      return 'badge-warning';
    case 'low':
      return 'badge-info';
    default:
      return 'badge-ghost';
  }
}

// Get icon for alert source
function getSourceIcon(source: QualityAlert['source']): any {
  switch (source) {
    case 'spatial':
      return Map;
    case 'irradiance':
      return Sun;
    case 'correlation':
      return Link;
    default:
      return AlertTriangle;
  }
}

// Get source label
function getSourceLabel(source: QualityAlert['source']): string {
  switch (source) {
    case 'spatial':
      return 'Spatial';
    case 'irradiance':
      return 'Irradiance';
    case 'correlation':
      return 'Correlation';
    default:
      return 'Unknown';
  }
}

export default function QualityAlertsPanel({
  spatialAlerts = [],
  irradianceAlerts = [],
  correlationRecommendations = [],
  isLoading = false,
  maxAlerts = 10,
}: QualityAlertsPanelProps) {
  // Combine and normalize all alerts
  const combinedAlerts: QualityAlert[] = [
    // Spatial uniformity alerts
    ...spatialAlerts.map((alert) => ({
      id: alert.id,
      source: 'spatial' as const,
      type: alert.likelyCause || 'non_uniform',
      severity: alert.severity,
      message: `Non-uniform conditions detected (CV: ${(alert.avgCV * 100).toFixed(1)}%)`,
      recommendation:
        alert.likelyCause === 'partial_cloud'
          ? 'Partial cloud coverage affecting some zones. May impact data quality during this period.'
          : alert.likelyCause === 'localized_soiling'
          ? 'Localized soiling detected. Consider zone-specific cleaning inspection.'
          : undefined,
      timestamp: alert.startTime,
      affectedZones: alert.affectedZones,
    })),
    // Irradiance quality alerts
    ...irradianceAlerts.map((alert, idx) => ({
      id: alert.id || `irr-${idx}`,
      source: 'irradiance' as const,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      recommendation: alert.recommendation,
    })),
    // Correlation recommendations (treated as low severity alerts)
    ...correlationRecommendations.map((rec, idx) => ({
      id: `corr-${idx}`,
      source: 'correlation' as const,
      type: 'recommendation',
      severity: 'low' as AlertSeverity,
      message: rec,
    })),
  ];

  // Sort by severity (high first) and take max
  const sortedAlerts = combinedAlerts
    .sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    })
    .slice(0, maxAlerts);

  // Count by severity
  const counts = {
    high: combinedAlerts.filter((a) => a.severity === 'high').length,
    medium: combinedAlerts.filter((a) => a.severity === 'medium').length,
    low: combinedAlerts.filter((a) => a.severity === 'low').length,
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Quality Alerts
          </h3>
        </div>
        <div className="flex flex-col items-center justify-center h-48">
          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
          <span className="mt-3 text-sm font-bold text-gray-400 uppercase tracking-widest">Processing checks...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
        <h3 className="font-bold text-gray-900 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          Quality Alerts
        </h3>
        <div className="flex gap-2">
          {counts.high > 0 && (
            <div className="px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-black uppercase rounded border border-red-200">
              {counts.high} High
            </div>
          )}
          {counts.medium > 0 && (
            <div className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-black uppercase rounded border border-amber-200">
              {counts.medium} Medium
            </div>
          )}
          {counts.low > 0 && (
            <div className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-black uppercase rounded border border-blue-200">
              {counts.low} Low
            </div>
          )}
        </div>
      </div>

      <div className="p-4 flex-1">
        {sortedAlerts.length === 0 ? (
          <div className="bg-green-50 border border-green-100 rounded-xl p-6 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-sm mb-3">
              <CheckCircle className="w-6 h-6 text-green-500" />
            </div>
            <p className="text-sm font-bold text-green-800">All quality checks passed</p>
            <p className="text-xs text-green-600/70 mt-1">No data anomalies detected in the current period.</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {sortedAlerts.map((alert) => {
              const Icon = getSourceIcon(alert.source);
              return (
                <div
                  key={alert.id}
                  className={`group relative p-4 rounded-xl border-l-4 transition-all ${
                    alert.severity === 'high'
                      ? 'bg-red-50/30 border-red-500 hover:bg-red-50/50'
                      : alert.severity === 'medium'
                      ? 'bg-amber-50/30 border-amber-500 hover:bg-amber-50/50'
                      : 'bg-blue-50/30 border-blue-500 hover:bg-blue-50/50'
                  }`}
                >
                  <div className="flex flex-col w-full">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`p-1 rounded-md bg-white shadow-sm ${
                          alert.severity === 'high' ? 'text-red-600' : alert.severity === 'medium' ? 'text-amber-600' : 'text-blue-600'
                        }`}>
                          <Icon className="w-3.5 h-3.5" />
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-wider text-gray-400">
                          {getSourceLabel(alert.source)}
                        </span>
                      </div>
                      {alert.timestamp && (
                        <span className="text-[10px] font-bold text-gray-400">
                          {new Date(alert.timestamp).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    
                    <p className="text-sm font-bold text-gray-900 leading-tight">
                      {alert.message}
                    </p>
                    
                    {alert.affectedZones && alert.affectedZones.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {alert.affectedZones.map(zone => (
                          <span key={zone} className="text-[9px] font-black uppercase bg-white px-1.5 py-0.5 rounded border border-gray-100 text-gray-500">
                            {zone}
                          </span>
                        ))}
                      </div>
                    )}
                    
                    {alert.recommendation && (
                      <div className="mt-3 p-2 bg-white/50 rounded-lg border border-gray-100 flex items-start gap-2">
                        <Lightbulb className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
                        <p className="text-[11px] text-gray-600 font-medium leading-relaxed italic">
                          {alert.recommendation}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {combinedAlerts.length > maxAlerts && (
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 text-center">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
            Showing {maxAlerts} of {combinedAlerts.length} total alerts
          </p>
        </div>
      )}
    </div>
  );
}
