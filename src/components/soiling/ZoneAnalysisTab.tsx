'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ZoneAnalysisData } from '@/types/soiling';
import { Map, RefreshCw, AlertTriangle, FileText, Info, Layers, Sparkles, Calendar, Target } from 'lucide-react';
import ZonePerformanceGrid from './ZonePerformanceGrid';

interface ZoneAnalysisTabProps {
  plantId: string;
  className?: string;
}

/**
 * ZoneAnalysisTab - Complete zone analysis view
 *
 * Features:
 * - Auto-detects zones from inverter patterns
 * - Shows zone-level performance metrics
 * - Provides cleaning recommendations per zone
 * - Allows zone selection for detailed view
 */
export function ZoneAnalysisTab({
  plantId,
  className = '',
}: ZoneAnalysisTabProps) {
  const [data, setData] = useState<ZoneAnalysisData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | undefined>();

  // Fetch zone data
  const fetchZoneData = useCallback(async (analyze = false) => {
    if (analyze) {
      setIsAnalyzing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const params = new URLSearchParams();
      if (analyze) {
        params.set('analyze', 'true');
      }

      const response = await fetch(
        `/api/soiling/plants/${plantId}/zones?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error('Failed to load zone data');
      }

      const result: ZoneAnalysisData = await response.json();

      if (result.success === false) {
        throw new Error(result.error || 'Zone analysis failed');
      }

      setData(result);
    } catch (err) {
      console.error('Error fetching zone data:', err);
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
      setIsAnalyzing(false);
    }
  }, [plantId]);

  // Initial fetch
  useEffect(() => {
    fetchZoneData();
  }, [fetchZoneData]);

  // Handle zone selection
  const handleZoneSelect = useCallback((zoneId: string) => {
    setSelectedZoneId((prev) => (prev === zoneId ? undefined : zoneId));
  }, []);

  // Get selected zone details
  const selectedZone = data?.zones.find((z) => z.zone_id === selectedZoneId);
  const selectedPerf = data?.performance?.find((p) => p.zone_id === selectedZoneId);

  if (isLoading) {
    return (
      <div className={`bg-gray-50 rounded-xl p-8 border border-gray-200 ${className}`}>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <span className="ml-3 text-gray-500 font-medium">Loading zone data...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-red-50 rounded-xl p-8 border border-red-200 ${className}`}>
        <div className="text-center py-8 flex flex-col items-center gap-3">
          <AlertTriangle className="w-10 h-10 text-red-500" />
          <h3 className="text-red-800 text-lg font-bold">Error loading zone analysis</h3>
          <p className="text-red-600 text-sm max-w-md">{error}</p>
          <button
            onClick={() => fetchZoneData()}
            className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-colors shadow-sm"
          >
            Retry Analysis
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`bg-gray-50 rounded-xl p-8 border border-gray-200 ${className}`}>
        <div className="text-center py-12 flex flex-col items-center gap-2">
          <Info className="w-10 h-10 text-gray-300" />
          <p className="text-gray-500 font-medium">No zone data available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header with actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Map className="w-6 h-6 text-blue-600" />
            Zone Analysis
          </h3>
          <p className="text-gray-500 text-sm mt-1">
            {data.zones?.length || 0} zones detected | Analysis period: {data.data_period?.start} to {data.data_period?.end}
          </p>
        </div>

        <button
          onClick={() => fetchZoneData(true)}
          disabled={isAnalyzing}
          className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-all shadow-sm ${
            isAnalyzing
              ? 'bg-gray-100 text-gray-400 cursor-wait'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {isAnalyzing ? (
            <>
              <RefreshCw className="animate-spin w-4 h-4" />
              Analyzing...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              Refresh Analysis
            </>
          )}
        </button>
      </div>

      {/* Cleaning recommendations */}
      {data.cleaning_recommendations && data.cleaning_recommendations.length > 0 && (
        <div className="bg-blue-50 rounded-xl border border-blue-100 p-5 shadow-sm">
          <h4 className="font-bold text-blue-900 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            Cleaning Recommendations
          </h4>
          <ul className="space-y-3">
            {data.cleaning_recommendations.map((rec, idx) => {
              const isUrgent = rec.toLowerCase().includes('urgent');
              const isPriority = rec.toLowerCase().includes('priority');

              return (
                <li
                  key={idx}
                  className={`flex items-start gap-3 text-sm p-3 rounded-lg bg-white/50 border ${
                    isUrgent
                      ? 'border-red-100 text-red-800'
                      : isPriority
                      ? 'border-amber-100 text-amber-800'
                      : 'border-blue-100 text-blue-800'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                    isUrgent ? 'bg-red-500' : isPriority ? 'bg-amber-500' : 'bg-blue-500'
                  }`} />
                  <span className="font-medium">{rec}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Zone performance grid */}
      {data.zones && data.zones.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h4 className="font-bold text-gray-900 mb-6 flex items-center gap-2">
            <Layers className="w-5 h-5 text-gray-400" />
            Zone Performance
          </h4>
          <ZonePerformanceGrid
            zones={data.zones}
            performance={data?.performance || []}
            onZoneSelect={handleZoneSelect}
            selectedZoneId={selectedZoneId}
          />
        </div>
      )}

      {/* Selected zone details */}
      {selectedZone && selectedPerf && (
        <div className="bg-white rounded-xl border-2 border-blue-500/20 p-6 shadow-md transition-all">
          <h4 className="font-bold text-gray-900 mb-6 flex items-center gap-2 text-lg">
            <div className="w-2 h-6 bg-blue-600 rounded"></div>
            {selectedZone.zone_name} Details
          </h4>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-50 border border-gray-100 rounded-lg p-4">
              <div className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Average SR</div>
              <div className="text-2xl font-bold text-blue-700">
                {((selectedPerf.avg_sr ?? 0) * 100).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-lg p-4">
              <div className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">SR Range</div>
              <div className="text-2xl font-bold text-gray-900">
                {((selectedPerf.min_sr ?? 0) * 100).toFixed(0)}-{((selectedPerf.max_sr ?? 0) * 100).toFixed(0)}%
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-lg p-4">
              <div className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Est. Loss</div>
              <div className="text-2xl font-bold text-red-600">
                {(selectedPerf.avg_loss_pct ?? 0).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-lg p-4">
              <div className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Data Points</div>
              <div className="text-2xl font-bold text-gray-900">
                {(selectedPerf.data_points ?? 0).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Inverter list */}
          <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
            <div className="text-gray-600 text-xs font-bold uppercase tracking-wider mb-3">
              Connected Inverters ({selectedZone.inverter_count})
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedZone.inverters?.length ? (
                <>
                  {selectedZone.inverters.slice(0, 20).map((inv) => (
                    <span
                      key={inv}
                      className="px-3 py-1 bg-white border border-gray-200 text-gray-700 text-xs font-mono font-medium rounded shadow-sm"
                    >
                      {inv}
                    </span>
                  ))}
                  {selectedZone.inverter_count > 20 && (
                    <span className="px-3 py-1 bg-gray-200 text-gray-600 text-xs font-bold rounded">
                      +{selectedZone.inverter_count - 20} more
                    </span>
                  )}
                </>
              ) : (
                // The zones API often carries only the membership pattern,
                // not an explicit inverter list.
                <span className="px-3 py-1 bg-white border border-gray-200 text-gray-700 text-xs font-mono font-medium rounded shadow-sm">
                  pattern: {selectedZone.inverter_pattern}
                </span>
              )}
            </div>
          </div>

          {selectedZone.description && (
            <div className="mt-4 p-4 bg-amber-50 border border-amber-100 rounded-lg flex items-start gap-3">
              <FileText className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-900 font-medium">
                {selectedZone.description}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Analysis metadata */}
      <div className="text-xs text-gray-400 flex items-center gap-3 pt-4 px-2">
        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> Last analyzed: {new Date(data.analyzed_at).toLocaleString()}</span>
        <span className="text-gray-300">|</span>
        <span className="flex items-center gap-1"><Target className="w-3 h-3" /> Data period: {data.data_period?.start} to {data.data_period?.end}</span>
      </div>
    </div>
  );
}

export default ZoneAnalysisTab;
