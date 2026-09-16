'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Compass, Zap, Activity, Server, ChevronRight } from 'lucide-react';
import type { PlantGroup, EquipmentGroupMapping } from '@/hooks/usePlantGroups';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface InverterPerformanceEntry {
  inverterId: string;
  performanceRatio?: number;
  soilingRatio?: number;
  health?: 'normal' | 'minorIssues' | 'majorIssues' | 'critical';
}

interface GroupPerformancePanelProps {
  groups: PlantGroup[];
  equipmentToGroup: Map<string, EquipmentGroupMapping>;
  inverterPerformance?: InverterPerformanceEntry[];
  faultCounts?: Record<string, number>;
  plantId?: string;
}

interface ComputedGroupMetrics {
  group: PlantGroup;
  avgPR: number | null;
  avgSR: number | null;
  healthDistribution: { normal: number; minor: number; major: number; critical: number };
  totalFaults: number;
  hasData: boolean;
}

function computeGroupMetrics(
  group: PlantGroup,
  inverterPerformance: InverterPerformanceEntry[] | undefined,
  faultCounts: Record<string, number> | undefined,
): ComputedGroupMetrics {
  const inverterSet = new Set(group.inverterIds);

  // Filter performance entries belonging to this group
  const groupEntries = (inverterPerformance ?? []).filter((e) =>
    inverterSet.has(e.inverterId),
  );

  // Average Performance Ratio
  const prValues = groupEntries
    .map((e) => e.performanceRatio)
    .filter((v): v is number => v != null);
  const avgPR = prValues.length > 0
    ? prValues.reduce((a, b) => a + b, 0) / prValues.length
    : null;

  // Average Soiling Ratio
  const srValues = groupEntries
    .map((e) => e.soilingRatio)
    .filter((v): v is number => v != null);
  const avgSR = srValues.length > 0
    ? srValues.reduce((a, b) => a + b, 0) / srValues.length
    : null;

  // Health distribution
  const healthDistribution = { normal: 0, minor: 0, major: 0, critical: 0 };
  for (const entry of groupEntries) {
    switch (entry.health) {
      case 'normal':
        healthDistribution.normal++;
        break;
      case 'minorIssues':
        healthDistribution.minor++;
        break;
      case 'majorIssues':
        healthDistribution.major++;
        break;
      case 'critical':
        healthDistribution.critical++;
        break;
    }
  }

  // Sum fault counts for inverters in this group
  const totalFaults = group.inverterIds.reduce(
    (sum, id) => sum + (faultCounts?.[id] ?? 0),
    0,
  );

  return {
    group,
    avgPR,
    avgSR,
    healthDistribution,
    totalFaults,
    hasData: groupEntries.length > 0,
  };
}

function prColorClass(pr: number): string {
  if (pr >= 80) return 'text-emerald-600 dark:text-emerald-400';
  if (pr >= 75) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function prBgClass(pr: number): string {
  if (pr >= 80) return 'bg-emerald-50 dark:bg-emerald-950/40';
  if (pr >= 75) return 'bg-amber-50 dark:bg-amber-950/40';
  return 'bg-red-50 dark:bg-red-950/40';
}

function srColorClass(sr: number): string {
  // SR close to 1.0 is healthy; below 0.9 is concerning
  if (sr >= 0.95) return 'text-emerald-600 dark:text-emerald-400';
  if (sr >= 0.90) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function HealthBar({ dist }: { dist: ComputedGroupMetrics['healthDistribution'] }) {
  const total = dist.normal + dist.minor + dist.major + dist.critical;
  if (total === 0) {
    return <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700" />;
  }

  const segments = [
    { count: dist.normal, color: 'bg-emerald-500' },
    { count: dist.minor, color: 'bg-amber-400' },
    { count: dist.major, color: 'bg-orange-500' },
    { count: dist.critical, color: 'bg-red-500' },
  ].filter((s) => s.count > 0);

  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      {segments.map((seg, i) => (
        <div
          key={i}
          className={`${seg.color} transition-all`}
          style={{ width: `${(seg.count / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

function GroupCard({ metrics }: { metrics: ComputedGroupMetrics }) {
  const { group, avgPR, avgSR, healthDistribution, totalFaults, hasData } = metrics;

  // Determine border accent based on overall PR health
  const borderAccent = avgPR != null
    ? avgPR >= 80
      ? 'border-l-emerald-500'
      : avgPR >= 75
        ? 'border-l-amber-500'
        : 'border-l-red-500'
    : 'border-l-gray-300 dark:border-l-gray-600';

  return (
    <div
      className={`rounded-lg border border-gray-200 border-l-4 ${borderAccent} bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-900`}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {group.name}
          </h3>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Compass className="h-3.5 w-3.5" />
            <span>{group.azimuth}&deg; / {group.tilt}&deg;</span>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          <Server className="h-3 w-3" />
          {group.inverterCount}
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-20 items-center justify-center rounded-md bg-gray-50 text-xs text-gray-400 dark:bg-gray-800 dark:text-gray-500">
          No data available
        </div>
      ) : (
        <>
          {/* Metrics row */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            {/* Performance Ratio */}
            <div className={`rounded-md px-2.5 py-2 ${avgPR != null ? prBgClass(avgPR) : 'bg-gray-50 dark:bg-gray-800'}`}>
              <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Avg PR
              </div>
              <div className={`text-lg font-bold ${avgPR != null ? prColorClass(avgPR) : 'text-gray-400'}`}>
                {avgPR != null ? `${avgPR.toFixed(1)}%` : '--'}
              </div>
            </div>

            {/* Soiling Ratio */}
            <div className="rounded-md bg-gray-50 px-2.5 py-2 dark:bg-gray-800">
              <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Avg SR
              </div>
              <div className={`text-lg font-bold ${avgSR != null ? srColorClass(avgSR) : 'text-gray-400'}`}>
                {avgSR != null ? `${(avgSR * 100).toFixed(1)}%` : '--'}
              </div>
            </div>
          </div>

          {/* Health distribution */}
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Health
              </span>
              <div className="flex gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                {healthDistribution.normal > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {healthDistribution.normal}
                  </span>
                )}
                {healthDistribution.minor > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                    {healthDistribution.minor}
                  </span>
                )}
                {healthDistribution.major > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500" />
                    {healthDistribution.major}
                  </span>
                )}
                {healthDistribution.critical > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
                    {healthDistribution.critical}
                  </span>
                )}
              </div>
            </div>
            <HealthBar dist={healthDistribution} />
          </div>

          {/* Faults */}
          {totalFaults > 0 && (
            <div className="flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
              <Zap className="h-3.5 w-3.5" />
              {totalFaults} active fault{totalFaults !== 1 ? 's' : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function GroupPerformancePanel({
  groups,
  equipmentToGroup,
  inverterPerformance,
  faultCounts,
  plantId,
}: GroupPerformancePanelProps) {
  const prefix = usePlantRoutePrefix();
  const groupMetrics = useMemo(
    () =>
      groups.map((group) =>
        computeGroupMetrics(group, inverterPerformance, faultCounts),
      ),
    [groups, inverterPerformance, faultCounts],
  );

  if (groups.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Group Performance
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {groupMetrics.map((metrics) => (
          <Link
            key={metrics.group.id}
            href={`${prefix}/plant/${plantId}/group/${encodeURIComponent(metrics.group.slug || metrics.group.name)}`}
            className="block hover:ring-2 hover:ring-blue-200 rounded-xl transition-all"
          >
            <GroupCard metrics={metrics} />
            <div className="flex items-center justify-center gap-1 text-xs text-blue-600 pb-2 -mt-1">
              <span>View group details</span>
              <ChevronRight className="w-3 h-3" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
