'use client';

import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';

interface PlantData {
  plantId: string;
  plantName: string;
  location: string;
  status: 'operational' | 'demo' | 'offline';
  healthDistribution: {
    normal: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
}

interface IssuesPanelProps {
  plants: PlantData[];
}

export default function IssuesPanel({ plants }: IssuesPanelProps) {
  // Sort plants by severity (critical first, then major issues)
  const sortedPlants = [...plants].sort((a, b) => {
    const aCritical = a.healthDistribution.critical;
    const bCritical = b.healthDistribution.critical;
    if (aCritical !== bCritical) return bCritical - aCritical;
    return b.healthDistribution.majorIssues - a.healthDistribution.majorIssues;
  });

  const totalCritical = plants.reduce((sum, p) => sum + p.healthDistribution.critical, 0);
  const totalMajor = plants.reduce((sum, p) => sum + p.healthDistribution.majorIssues, 0);

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-divider bg-paper">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <h3 className="font-semibold text-ink">Issues Requiring Attention</h3>
        </div>
        <div className="flex gap-4 mt-2 text-sm">
          {totalCritical > 0 && (
            <span className="flex items-center gap-1 text-signal-critical font-medium">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              {totalCritical} critical
            </span>
          )}
          {totalMajor > 0 && (
            <span className="flex items-center gap-1 text-orange-600 font-medium">
              <span className="w-2 h-2 rounded-full bg-orange-500"></span>
              {totalMajor} major
            </span>
          )}
        </div>
      </div>

      {/* Issues List */}
      <div className="divide-y divide-gray-100">
        {sortedPlants.map((plant) => {
          const hasCritical = plant.healthDistribution.critical > 0;
          const isDemo = plant.status === 'demo';

          const IssueContent = () => (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-ink">{plant.plantName}</div>
                <div className="text-xs text-ink-3">{plant.location}</div>
              </div>
              <div className="flex items-center gap-2">
                {plant.healthDistribution.critical > 0 && (
                  <span className="px-2 py-1 bg-signal-critical/10 text-signal-critical text-xs font-medium rounded-full">
                    {plant.healthDistribution.critical} critical
                  </span>
                )}
                {plant.healthDistribution.majorIssues > 0 && (
                  <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-medium rounded-full">
                    {plant.healthDistribution.majorIssues} major
                  </span>
                )}
                {!isDemo && (
                  <ChevronRight className="w-4 h-4 text-ink-3" />
                )}
              </div>
            </div>
          );

          if (!isDemo) {
            return (
              <Link
                key={plant.plantId}
                href={`/demo/plant/${plant.plantId}`}
                className={`block px-5 py-3 hover:bg-gray-50 transition-colors ${
                  hasCritical ? 'border-l-4 border-red-500' : 'border-l-4 border-orange-400'
                }`}
              >
                <IssueContent />
              </Link>
            );
          }

          return (
            <div
              key={plant.plantId}
              className={`px-5 py-3 ${
                hasCritical ? 'border-l-4 border-red-500' : 'border-l-4 border-orange-400'
              } opacity-60`}
            >
              <IssueContent />
            </div>
          );
        })}
      </div>
    </div>
  );
}
