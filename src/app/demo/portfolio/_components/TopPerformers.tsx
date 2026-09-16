'use client';

import Link from 'next/link';
import { Trophy, ChevronRight } from 'lucide-react';

interface PlantData {
  plantId: string;
  plantName: string;
  location: string;
  capacity_MW: number;
  status: 'operational' | 'demo' | 'offline';
  metrics: {
    avgR2: number | null;
    avgMAE_kW: number | null;
    soilingRatio: number | null;
    healthScore: number | null;
  };
}

interface TopPerformersProps {
  plants: PlantData[];
}

export default function TopPerformers({ plants }: TopPerformersProps) {
  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-divider bg-paper">
        <div className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-emerald-500" />
          <h3 className="font-semibold text-ink">Top Performers</h3>
        </div>
        <p className="text-xs text-ink-3 mt-1">Plants with highest model accuracy</p>
      </div>

      {/* Performers List */}
      <div className="divide-y divide-gray-100">
        {plants.map((plant, index) => {
          const isDemo = plant.status === 'demo';

          const PerformerContent = () => (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                  index === 0 ? 'bg-yellow-100 text-yellow-700' :
                  index === 1 ? 'bg-paper-2 text-ink-2' :
                  'bg-orange-100 text-orange-700'
                }`}>
                  {index + 1}
                </div>
                <div>
                  <div className="font-medium text-ink">{plant.plantName}</div>
                  <div className="text-xs text-ink-3">{plant.capacity_MW} MW - {plant.location}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {plant.metrics.avgR2 !== null && (
                  <div className="text-right">
                    <div className="text-lg font-bold text-signal-positive">
                      {(plant.metrics.avgR2 * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-ink-3">R2 Score</div>
                  </div>
                )}
                {!isDemo && (
                  <ChevronRight className="w-4 h-4 text-ink-3 ml-2" />
                )}
              </div>
            </div>
          );

          if (!isDemo) {
            return (
              <Link
                key={plant.plantId}
                href={`/demo/plant/${plant.plantId}`}
                className="block px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <PerformerContent />
              </Link>
            );
          }

          return (
            <div key={plant.plantId} className="px-5 py-3 opacity-60">
              <PerformerContent />
            </div>
          );
        })}
      </div>

      {/* View All Link */}
      {plants.length > 0 && (
        <div className="px-5 py-3 border-t border-divider bg-paper">
          <Link
            href="/demo/portfolio"
            className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
          >
            View all plants
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      )}
    </div>
  );
}
