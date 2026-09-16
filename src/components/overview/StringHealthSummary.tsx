'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Zap, ExternalLink } from 'lucide-react';
import type { PlantMpptData } from '@/types/mppt';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

// Anomaly shape from string_anomalies.json
interface StringAnomaly {
  id: string;
  inverterId: string;
  mpptId: string;
  stringId: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  currentDrop_pct: number;
  detectedAt: string;
  description: string;
}

interface StringAnomalyData {
  plantId: string;
  generatedAt: string;
  totalAnomalies: number;
  anomalies: StringAnomaly[];
}

interface StringHealthSummaryProps {
  plantId: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info: 'bg-blue-100 text-blue-700',
};

const TYPE_COLORS: Record<string, string> = {
  OPEN_CIRCUIT: 'bg-red-500',
  DEGRADATION: 'bg-amber-500',
  MISMATCH: 'bg-orange-400',
  SHADING: 'bg-yellow-400',
};

export default function StringHealthSummary({ plantId }: StringHealthSummaryProps) {
  const [mpptData, setMpptData] = useState<PlantMpptData | null>(null);
  const [anomalyData, setAnomalyData] = useState<StringAnomalyData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      // String-level fixtures only exist for demo/showcase plants.
      if (prefix === '/dashboard') {
        setLoaded(true);
        return;
      }
      try {
        const [mpptRes, anomalyRes] = await Promise.allSettled([
          fetch(`${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`),
          fetch(`${dataRoot}/digitaltwin/${plantId}/string_anomalies.json`),
        ]);

        if (cancelled) return;

        if (mpptRes.status === 'fulfilled' && mpptRes.value.ok) {
          const json = await mpptRes.value.json();
          setMpptData(json);
        }

        if (anomalyRes.status === 'fulfilled' && anomalyRes.value.ok) {
          const json = await anomalyRes.value.json();
          setAnomalyData(json);
        }
      } catch {
        // Files may not exist for all plants, this is expected
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [plantId, dataRoot, prefix]);

  // Compute string health metrics from mppt data
  const metrics = useMemo(() => {
    if (!mpptData) return null;

    let totalStrings = 0;
    let healthy = 0;
    let degraded = 0;
    let openCircuit = 0;
    let warning = 0;

    for (const inv of Object.values(mpptData.inverters)) {
      for (const mppt of inv.mppts) {
        for (const s of mppt.strings) {
          totalStrings++;
          switch (s.status) {
            case 'normal':
              healthy++;
              break;
            case 'degraded':
              degraded++;
              break;
            case 'open_circuit':
              openCircuit++;
              break;
            case 'shorted':
            case 'offline':
              warning++;
              break;
          }
        }
      }
    }

    return { totalStrings, healthy, degraded, openCircuit, warning };
  }, [mpptData]);

  // Group anomalies by type
  const anomalyByType = useMemo(() => {
    if (!anomalyData) return {};
    const map: Record<string, number> = {};
    for (const a of anomalyData.anomalies) {
      map[a.type] = (map[a.type] || 0) + 1;
    }
    return map;
  }, [anomalyData]);

  // Top 3 worst inverters by anomaly count
  const worstInverters = useMemo(() => {
    if (!anomalyData || anomalyData.anomalies.length === 0) return [];
    const countMap: Record<string, { count: number; critical: number }> = {};
    for (const a of anomalyData.anomalies) {
      if (!countMap[a.inverterId]) {
        countMap[a.inverterId] = { count: 0, critical: 0 };
      }
      countMap[a.inverterId].count++;
      if (a.severity === 'critical') countMap[a.inverterId].critical++;
    }
    return Object.entries(countMap)
      .sort(([, a], [, b]) => b.critical - a.critical || b.count - a.count)
      .slice(0, 3)
      .map(([inverterId, stats]) => ({ inverterId, ...stats }));
  }, [anomalyData]);

  // Do not render if data has not loaded or there is no mppt data
  if (!loaded || !mpptData || !metrics) return null;

  const anomalyCount = anomalyData?.totalAnomalies ?? 0;
  const totalSegments = metrics.totalStrings;
  const healthyPct = totalSegments > 0 ? (metrics.healthy / totalSegments) * 100 : 0;
  const degradedPct = totalSegments > 0 ? (metrics.degraded / totalSegments) * 100 : 0;
  const warningPct = totalSegments > 0 ? (metrics.warning / totalSegments) * 100 : 0;
  const faultPct = totalSegments > 0 ? (metrics.openCircuit / totalSegments) * 100 : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2">
        <Zap className="h-4 w-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-gray-700">
          String-Level Monitoring
        </h2>
      </div>

      {/* KPI row */}
      <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiBox label="Total Strings" value={metrics.totalStrings} color="gray" />
        <KpiBox label="Healthy" value={metrics.healthy} color="emerald" />
        <KpiBox label="Anomalies" value={anomalyCount} color="amber" />
        <KpiBox label="Open Circuits" value={metrics.openCircuit} color="red" />
      </div>

      {/* Health bar */}
      <div className="mb-1">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            String Health Distribution
          </span>
          <span className="text-[10px] text-gray-400">
            {healthyPct.toFixed(0)}% healthy
          </span>
        </div>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-200">
          {healthyPct > 0 && (
            <div
              className="bg-emerald-500 transition-all"
              style={{ width: `${healthyPct}%` }}
              title={`Normal: ${metrics.healthy}`}
            />
          )}
          {degradedPct > 0 && (
            <div
              className="bg-amber-400 transition-all"
              style={{ width: `${degradedPct}%` }}
              title={`Degraded: ${metrics.degraded}`}
            />
          )}
          {warningPct > 0 && (
            <div
              className="bg-orange-500 transition-all"
              style={{ width: `${warningPct}%` }}
              title={`Warning: ${metrics.warning}`}
            />
          )}
          {faultPct > 0 && (
            <div
              className="bg-red-500 transition-all"
              style={{ width: `${faultPct}%` }}
              title={`Fault/Open: ${metrics.openCircuit}`}
            />
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Normal
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
            Degraded
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500" />
            Warning
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
            Fault
          </span>
        </div>
      </div>

      {/* Anomaly breakdown by type */}
      {Object.keys(anomalyByType).length > 0 && (
        <div className="mt-4 space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Anomaly Breakdown
          </span>
          {Object.entries(anomalyByType)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <div key={type} className="flex items-center gap-2">
                <span className="w-28 text-xs text-gray-600 truncate" title={type}>
                  {type.replace(/_/g, ' ')}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${TYPE_COLORS[type] || 'bg-gray-400'} transition-all`}
                    style={{ width: `${Math.min((count / anomalyCount) * 100, 100)}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-500 w-6 text-right">{count}</span>
              </div>
            ))}
        </div>
      )}

      {/* Worst inverters */}
      {worstInverters.length > 0 && (
        <div className="mt-4">
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Worst Inverters
          </span>
          <div className="mt-1.5 space-y-1.5">
            {worstInverters.map((inv) => (
              <Link
                key={inv.inverterId}
                href={`${prefix}/plant/${plantId}/inverter/${inv.inverterId}`}
                className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-700 group-hover:text-indigo-600 transition-colors">
                    {inv.inverterId}
                  </span>
                  {inv.critical > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 text-red-700">
                      {inv.critical} critical
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">
                    {inv.count} anomal{inv.count === 1 ? 'y' : 'ies'}
                  </span>
                  <ExternalLink className="h-3 w-3 text-gray-400 group-hover:text-indigo-500 transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiBox({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    gray: 'text-gray-700',
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
  };
  const bgMap: Record<string, string> = {
    gray: 'bg-gray-50',
    emerald: 'bg-emerald-50',
    amber: 'bg-amber-50',
    red: 'bg-red-50',
  };

  return (
    <div className={`rounded-lg px-3 py-2 ${bgMap[color] || 'bg-gray-50'}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className={`text-lg font-bold ${colorMap[color] || 'text-gray-700'}`}>
        {value}
      </div>
    </div>
  );
}
