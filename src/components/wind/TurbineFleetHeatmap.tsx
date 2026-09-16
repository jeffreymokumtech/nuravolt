/**
 * TurbineFleetHeatmap - Visual grid of turbine health status
 *
 * Features:
 * - Color-coded health tiles for each turbine
 * - Status indicators and fault counts
 * - Click to select turbine for details
 * - Responsive grid layout
 */

'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Wind,
  AlertTriangle,
  CheckCircle2,
  Pause,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import type { WindTurbine, TurbineHealthSummary, TurbineStatus } from '@/types/wind';
import { getHealthColor, getStatusColor, formatRUL } from '@/types/wind';

interface TurbineWithHealth extends WindTurbine {
  health: TurbineHealthSummary | null;
}

interface TurbineFleetHeatmapProps {
  turbines: TurbineWithHealth[];
  selectedTurbineId?: string | null;
  onTurbineSelect?: (turbineId: string) => void;
}

const statusIcons: Record<TurbineStatus, React.ElementType> = {
  OPERATING: Wind,
  IDLE: Pause,
  MAINTENANCE: Wrench,
  FAULT: XCircle,
  CURTAILED: Zap,
  OFFLINE: AlertTriangle,
};

export function TurbineFleetHeatmap({
  turbines,
  selectedTurbineId,
  onTurbineSelect,
}: TurbineFleetHeatmapProps) {
  // Calculate fleet summary
  const summary = useMemo(() => {
    const operating = turbines.filter(
      (t) => t.health?.status === 'OPERATING'
    ).length;
    const faults = turbines.reduce(
      (sum, t) => sum + (t.health?.activeFaults || 0),
      0
    );
    const avgHealth =
      turbines.length > 0
        ? turbines.reduce((sum, t) => sum + (t.health?.overallHealth || 0), 0) /
          turbines.length
        : 0;

    return { operating, faults, avgHealth };
  }, [turbines]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Wind className="h-5 w-5" />
            Turbine Fleet
          </CardTitle>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">
              {summary.operating}/{turbines.length} Operating
            </span>
            {summary.faults > 0 && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {summary.faults} Active Faults
              </Badge>
            )}
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Avg Health:</span>
              <span
                className="font-semibold"
                style={{ color: getHealthColor(summary.avgHealth) }}
              >
                {summary.avgHealth.toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {turbines.map((turbine) => {
            const health = turbine.health;
            const isSelected = selectedTurbineId === turbine.id;
            const StatusIcon = health
              ? statusIcons[health.status]
              : Wind;
            const healthColor = health
              ? getHealthColor(health.overallHealth)
              : '#6b7280';
            const statusColor = health
              ? getStatusColor(health.status)
              : '#6b7280';

            return (
              <button
                key={turbine.id}
                onClick={() => onTurbineSelect?.(turbine.id)}
                className={cn(
                  'relative p-4 rounded-lg border-2 transition-all duration-200',
                  'hover:shadow-md hover:scale-[1.02]',
                  'focus:outline-none focus:ring-2 focus:ring-primary',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card'
                )}
              >
                {/* Health indicator bar */}
                <div
                  className="absolute top-0 left-0 right-0 h-1 rounded-t-md"
                  style={{ backgroundColor: healthColor }}
                />

                {/* Turbine name and status */}
                <div className="flex items-center justify-between mb-3 mt-1">
                  <span className="font-semibold text-sm">{turbine.name}</span>
                  <StatusIcon
                    className="h-4 w-4"
                    style={{ color: statusColor }}
                  />
                </div>

                {/* Health score */}
                <div className="text-center mb-3">
                  <div
                    className="text-3xl font-bold"
                    style={{ color: healthColor }}
                  >
                    {health?.overallHealth ?? '--'}
                  </div>
                  <div className="text-xs text-muted-foreground">Health Score</div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Availability</div>
                    <div className="font-medium">
                      {health
                        ? `${(health.availability * 100).toFixed(1)}%`
                        : '--'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Cap. Factor</div>
                    <div className="font-medium">
                      {health
                        ? `${(health.capacityFactor * 100).toFixed(1)}%`
                        : '--'}
                    </div>
                  </div>
                </div>

                {/* Alerts */}
                {health && (health.activeFaults > 0 || health.lowestRUL) && (
                  <div className="mt-3 pt-2 border-t space-y-1">
                    {health.activeFaults > 0 && (
                      <div className="flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="h-3 w-3" />
                        {health.activeFaults} Active Fault
                        {health.activeFaults > 1 ? 's' : ''}
                      </div>
                    )}
                    {health.lowestRUL && health.lowestRUL.days < 120 && (
                      <div className="flex items-center gap-1 text-xs text-orange-600">
                        <Wrench className="h-3 w-3" />
                        RUL: {formatRUL(health.lowestRUL.days)}
                      </div>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-6 mt-6 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span>Healthy (90+)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-lime-500" />
            <span>Good (75-89)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <span>Fair (60-74)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-orange-500" />
            <span>Poor (40-59)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span>Critical (&lt;40)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default TurbineFleetHeatmap;
