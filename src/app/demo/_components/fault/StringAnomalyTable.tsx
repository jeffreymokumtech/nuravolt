'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Cable, ArrowUpDown, ExternalLink } from 'lucide-react';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

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

interface StringAnomalyTableProps {
  plantId: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  warning: 'bg-signal-warning/10 text-signal-warning border-signal-warning/20',
  info: 'bg-blue-100 text-blue-700 border-blue-200',
};

type SortField = 'severity' | 'currentDrop_pct' | 'detectedAt';

export default function StringAnomalyTable({ plantId }: StringAnomalyTableProps) {
  const [data, setData] = useState<StringAnomalyData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sortField, setSortField] = useState<SortField>('severity');
  const [sortAsc, setSortAsc] = useState(true);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  useEffect(() => {
    let cancelled = false;
    fetch(`${dataRoot}/digitaltwin/${plantId}/string_anomalies.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then((json: StringAnomalyData) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        // File may not exist, expected
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [plantId]);

  const sorted = useMemo(() => {
    if (!data) return [];
    const items = [...data.anomalies];
    items.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'severity':
          cmp = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
          break;
        case 'currentDrop_pct':
          cmp = a.currentDrop_pct - b.currentDrop_pct;
          break;
        case 'detectedAt':
          cmp = new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime();
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return items;
  }, [data, sortField, sortAsc]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(field === 'severity'); // severity ascending = critical first
    }
  };

  if (!loaded || !data || data.anomalies.length === 0) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-divider overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-divider flex items-center gap-3">
        <div className="p-2 bg-violet-100 rounded-lg">
          <Cable className="w-5 h-5 text-violet-600" />
        </div>
        <div>
          <h3 className="text-base font-bold text-ink">String-Level Anomalies</h3>
          <p className="text-xs text-ink-3">
            {data.totalAnomalies} anomal{data.totalAnomalies === 1 ? 'y' : 'ies'} detected across inverter strings
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-paper border-b border-divider">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                Inverter
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                MPPT
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                String
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                Type
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                <button
                  onClick={() => handleSort('severity')}
                  className="flex items-center gap-1 hover:text-gray-700 transition-colors"
                >
                  Severity
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                <button
                  onClick={() => handleSort('currentDrop_pct')}
                  className="flex items-center gap-1 hover:text-gray-700 transition-colors ml-auto"
                >
                  Drop %
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-ink-3 uppercase tracking-wide">
                <button
                  onClick={() => handleSort('detectedAt')}
                  className="flex items-center gap-1 hover:text-gray-700 transition-colors"
                >
                  Detected
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((anomaly) => (
              <tr
                key={anomaly.id}
                className="hover:bg-gray-50 transition-colors"
              >
                <td className="px-4 py-2.5 font-medium text-ink-2">
                  {anomaly.inverterId}
                </td>
                <td className="px-4 py-2.5 text-ink-2">
                  {anomaly.mpptId}
                </td>
                <td className="px-4 py-2.5 text-ink-2">
                  {anomaly.stringId}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-xs text-ink-2">
                    {anomaly.type.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex px-2 py-0.5 text-[11px] font-semibold rounded-full border ${SEVERITY_BADGE[anomaly.severity] || 'bg-paper-2 text-ink-2 border-divider'}`}
                  >
                    {anomaly.severity}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium text-ink-2">
                  {anomaly.currentDrop_pct.toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-ink-3 text-xs">
                  {new Date(anomaly.detectedAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="px-4 py-2.5">
                  <Link
                    href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(anomaly.inverterId)}/string/${encodeURIComponent(anomaly.stringId)}`}
                    className="text-indigo-500 hover:text-indigo-700 transition-colors"
                    title="Jump to string detail"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
