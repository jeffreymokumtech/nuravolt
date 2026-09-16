'use client';

import { useMemo } from 'react';
import type {
  SoilingZoneConfig,
  ZonePerformanceMetrics,
} from '@/types/soiling';
import {
  ZONE_PRIORITY_COLORS,
  getZoneHealthColor,
  getZoneHealthLabel,
} from '@/types/soiling';

interface ZonePerformanceGridProps {
  zones: SoilingZoneConfig[];
  performance: ZonePerformanceMetrics[];
  onZoneSelect?: (zoneId: string) => void;
  selectedZoneId?: string;
  className?: string;
}

/**
 * ZonePerformanceGrid - Display zone-level soiling performance
 *
 * Features:
 * - Grid layout of zone performance cards
 * - Health score visualization
 * - Cleaning priority indicators
 * - Interactive zone selection
 * - Comparison to fleet average
 */
export function ZonePerformanceGrid({
  zones,
  performance,
  onZoneSelect,
  selectedZoneId,
  className = '',
}: ZonePerformanceGridProps) {
  // Create a map of zone performance
  const perfMap = useMemo(() => {
    return performance.reduce((acc, p) => {
      acc[p.zone_id] = p;
      return acc;
    }, {} as Record<string, ZonePerformanceMetrics>);
  }, [performance]);

  // Calculate fleet average
  const fleetAvgSr = useMemo(() => {
    if (performance.length === 0) return 0;
    return performance.reduce((sum, p) => sum + p.avg_sr, 0) / performance.length;
  }, [performance]);

  // Sort zones by performance (worst first for cleaning priority)
  const sortedZones = useMemo(() => {
    return [...zones].sort((a, b) => {
      const perfA = perfMap[a.zone_id];
      const perfB = perfMap[b.zone_id];
      if (!perfA || !perfB) return 0;

      // Sort by cleaning priority, then by SR
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const priorityDiff = priorityOrder[perfA.cleaning_priority] - priorityOrder[perfB.cleaning_priority];
      if (priorityDiff !== 0) return priorityDiff;

      return perfA.avg_sr - perfB.avg_sr;
    });
  }, [zones, perfMap]);

  if (zones.length === 0) {
    return (
      <div className={`text-center py-12 text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200 ${className}`}>
        No zones detected for this plant
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Summary header */}
      <div className="mb-6 flex items-center justify-between px-1">
        <div className="text-sm text-gray-500 font-medium">
          {zones.length} zones detected <span className="mx-2 text-gray-300">|</span> Fleet avg SR: <span className="text-gray-900 font-bold">{(fleetAvgSr * 100).toFixed(1)}%</span>
        </div>
        <div className="flex gap-3 text-[10px] font-bold uppercase tracking-wider">
          {(['low', 'medium', 'high', 'critical'] as const).map((priority) => (
            <div key={priority} className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: ZONE_PRIORITY_COLORS[priority] }}
              />
              <span className="text-gray-400">{priority}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Zone grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {sortedZones.map((zone) => {
          const perf = perfMap[zone.zone_id];
          const isSelected = selectedZoneId === zone.zone_id;

          if (!perf) {
            return (
              <div
                key={zone.zone_id}
                className="bg-gray-50 rounded-lg border border-gray-200 p-4 opacity-50"
              >
                <div className="text-gray-900 font-bold">{zone.zone_name}</div>
                <div className="text-gray-400 text-xs mt-1">No data available</div>
              </div>
            );
          }

          const healthColor = getZoneHealthColor(perf.health_score);
          const healthLabel = getZoneHealthLabel(perf.health_score);
          const priorityColor = ZONE_PRIORITY_COLORS[perf.cleaning_priority];
          const vsFleet = ((perf.avg_sr / fleetAvgSr - 1) * 100).toFixed(1);
          const vsFleetPositive = parseFloat(vsFleet) >= 0;

          return (
            <button
              key={zone.zone_id}
              onClick={() => onZoneSelect?.(zone.zone_id)}
              className={`w-full text-left rounded-lg border-2 p-4 transition-all shadow-sm ${
                isSelected
                  ? 'border-blue-500 bg-blue-50/30 ring-1 ring-blue-500/20'
                  : 'border-gray-100 bg-white hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              {/* Zone header */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h4 className="text-gray-900 font-bold">{zone.zone_name}</h4>
                  <p className="text-gray-400 text-[10px] font-bold uppercase tracking-wide mt-0.5">
                    {zone.inverter_count} inverters
                  </p>
                </div>
                <div
                  className="px-2 py-0.5 text-[10px] font-bold uppercase rounded border"
                  style={{
                    backgroundColor: `${priorityColor}10`,
                    color: priorityColor,
                    borderColor: `${priorityColor}20`,
                  }}
                >
                  {perf.cleaning_priority}
                </div>
              </div>

              {/* SR metric */}
              <div className="mb-4">
                <div className="flex items-end justify-between">
                  <div>
                    <span className="text-2xl font-bold text-gray-900">
                      {(perf.avg_sr * 100).toFixed(1)}%
                    </span>
                    <span className="text-gray-400 text-xs font-bold ml-1">SR</span>
                  </div>
                  <span
                    className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                      vsFleetPositive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {vsFleetPositive ? '+' : ''}{vsFleet}%
                  </span>
                </div>
              </div>

              {/* Health score bar */}
              <div className="mb-4">
                <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-1.5">
                  <span className="text-gray-400">Health Score</span>
                  <span style={{ color: healthColor }}>{healthLabel}</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${perf.health_score}%`,
                      backgroundColor: healthColor,
                    }}
                  />
                </div>
              </div>

              {/* Additional metrics */}
              <div className="grid grid-cols-2 gap-2 text-[11px] font-medium">
                <div className="bg-gray-50 border border-gray-100 rounded p-2 flex justify-between">
                  <span className="text-gray-400">Loss</span>
                  <span className="text-red-600 font-bold">
                    {perf.avg_loss_pct.toFixed(1)}%
                  </span>
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded p-2 flex justify-between">
                  <span className="text-gray-400">Std</span>
                  <span className="text-gray-700 font-bold">
                    ±{(perf.std_sr * 100).toFixed(2)}%
                  </span>
                </div>
              </div>

              {/* Recommendation */}
              {perf.recommendation && (
                <div className="mt-4 pt-3 border-t border-gray-100">
                  <p className="text-[11px] text-gray-500 leading-relaxed line-clamp-2 italic">
                    &ldquo;{perf.recommendation}&rdquo;
                  </p>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ZonePerformanceGrid;
