/**
 * WindKPIGrid - Key Performance Indicators for wind plant
 *
 * Features:
 * - Current output vs capacity
 * - Availability metrics
 * - Capacity factor
 * - Fleet health score
 * - Active faults summary
 */

'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Wind,
  Zap,
  Activity,
  Heart,
  AlertTriangle,
  Clock,
  TrendingUp,
} from 'lucide-react';
import type { WindPlantSummary } from '@/types/wind';
import { getHealthColor, formatPower } from '@/types/wind';

interface KPICardProps {
  title: string;
  value: string | number;
  unit?: string;
  subtitle?: string;
  icon: React.ElementType;
  iconColor?: string;
  trend?: { value: number; label: string };
  alert?: boolean;
}

function KPICard({
  title,
  value,
  unit,
  subtitle,
  icon: Icon,
  iconColor = '#6b7280',
  trend,
  alert,
}: KPICardProps) {
  return (
    <Card className={alert ? 'border-destructive/50' : ''}>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold">{value}</span>
              {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
            {trend && (
              <div className="flex items-center gap-1 mt-2">
                <TrendingUp
                  className={`h-3 w-3 ${
                    trend.value >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}
                />
                <span
                  className={`text-xs ${
                    trend.value >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  {trend.value >= 0 ? '+' : ''}
                  {trend.value}% {trend.label}
                </span>
              </div>
            )}
          </div>
          <div
            className="p-2 rounded-lg"
            style={{ backgroundColor: `${iconColor}15` }}
          >
            <Icon className="h-5 w-5" style={{ color: iconColor }} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface WindKPIGridProps {
  plant: WindPlantSummary;
}

export function WindKPIGrid({ plant }: WindKPIGridProps) {
  const healthColor = getHealthColor(plant.fleetHealthScore);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {/* Current Output */}
      <KPICard
        title="Current Output"
        value={plant.currentOutputMw.toFixed(1)}
        unit="MW"
        subtitle={`of ${plant.totalCapacityMw.toFixed(1)} MW capacity`}
        icon={Zap}
        iconColor="#f59e0b"
      />

      {/* Availability */}
      <KPICard
        title="Availability"
        value={(plant.availability * 100).toFixed(1)}
        unit="%"
        subtitle="Last 30 days"
        icon={Clock}
        iconColor="#3b82f6"
      />

      {/* Capacity Factor */}
      <KPICard
        title="Capacity Factor"
        value={(plant.capacityFactor * 100).toFixed(1)}
        unit="%"
        subtitle="Energy yield vs rated"
        icon={Activity}
        iconColor="#8b5cf6"
      />

      {/* Fleet Health */}
      <KPICard
        title="Fleet Health"
        value={plant.fleetHealthScore}
        unit="/100"
        subtitle={`${plant.turbineCount} turbines`}
        icon={Heart}
        iconColor={healthColor}
      />

      {/* Active Faults */}
      <KPICard
        title="Active Faults"
        value={plant.activeFaultCount}
        subtitle={
          plant.criticalAlertCount > 0
            ? `${plant.criticalAlertCount} critical`
            : 'None critical'
        }
        icon={AlertTriangle}
        iconColor={plant.activeFaultCount > 0 ? '#ef4444' : '#22c55e'}
        alert={plant.criticalAlertCount > 0}
      />

      {/* Turbine Model */}
      <KPICard
        title="Turbine Model"
        value={plant.turbineModel.split(' ')[0]}
        subtitle={plant.turbineModel}
        icon={Wind}
        iconColor="#6b7280"
      />
    </div>
  );
}

export default WindKPIGrid;
