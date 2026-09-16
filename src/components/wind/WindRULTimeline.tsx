/**
 * WindRULTimeline - Remaining Useful Life visualization
 *
 * Features:
 * - Horizontal bar chart showing RUL by component
 * - Color-coded by urgency/health
 * - Trend indicators (stable, degrading, rapid)
 * - Grouped by turbine
 */

'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Wrench,
  TrendingDown,
  TrendingUp,
  Minus,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import type { WindComponentRUL, RULTrend } from '@/types/wind';
import { getHealthColor, formatRUL, getComponentDisplayName } from '@/types/wind';

interface WindRULTimelineProps {
  predictions: WindComponentRUL[];
  maxDays?: number;
  groupByTurbine?: boolean;
}

const trendIcons: Record<RULTrend, { icon: React.ElementType; color: string }> = {
  STABLE: { icon: Minus, color: '#22c55e' },
  DEGRADING: { icon: TrendingDown, color: '#f59e0b' },
  RAPID_DEGRADATION: { icon: TrendingDown, color: '#ef4444' },
};

export function WindRULTimeline({
  predictions,
  maxDays = 500,
  groupByTurbine = true,
}: WindRULTimelineProps) {
  // Group predictions by turbine
  const groupedPredictions = useMemo(() => {
    if (!groupByTurbine) {
      return { All: predictions };
    }

    const groups: Record<string, WindComponentRUL[]> = {};
    predictions.forEach((p) => {
      if (!groups[p.turbineId]) {
        groups[p.turbineId] = [];
      }
      groups[p.turbineId].push(p);
    });

    // Sort each group by RUL
    Object.values(groups).forEach((group) => {
      group.sort((a, b) => a.estimatedRUL - b.estimatedRUL);
    });

    return groups;
  }, [predictions, groupByTurbine]);

  // Summary stats
  const summary = useMemo(() => {
    const critical = predictions.filter((p) => p.estimatedRUL < 90).length;
    const degrading = predictions.filter(
      (p) => p.trend === 'DEGRADING' || p.trend === 'RAPID_DEGRADATION'
    ).length;
    const avgHealth =
      predictions.length > 0
        ? predictions.reduce((sum, p) => sum + p.healthScore, 0) / predictions.length
        : 0;

    return { critical, degrading, avgHealth };
  }, [predictions]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Predictive Maintenance
          </CardTitle>
          <div className="flex items-center gap-4 text-sm">
            {summary.critical > 0 && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {summary.critical} Critical (&lt;90d)
              </Badge>
            )}
            {summary.degrading > 0 && (
              <Badge variant="outline" className="flex items-center gap-1 text-orange-600 border-orange-600">
                <TrendingDown className="h-3 w-3" />
                {summary.degrading} Degrading
              </Badge>
            )}
            <span className="text-muted-foreground">
              Avg Health: {summary.avgHealth.toFixed(0)}%
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {Object.entries(groupedPredictions).map(([turbineId, preds]) => (
            <div key={turbineId}>
              {groupByTurbine && (
                <h4 className="font-medium text-sm mb-3">{turbineId}</h4>
              )}
              <div className="space-y-3">
                {preds.map((pred) => {
                  const TrendIcon = trendIcons[pred.trend].icon;
                  const trendColor = trendIcons[pred.trend].color;
                  const healthColor = getHealthColor(pred.healthScore);
                  const progressValue = Math.min(
                    (pred.estimatedRUL / maxDays) * 100,
                    100
                  );
                  const isUrgent = pred.estimatedRUL < 90;

                  return (
                    <div
                      key={`${pred.turbineId}-${pred.component}`}
                      className={`p-3 rounded-lg border ${
                        isUrgent ? 'border-destructive/50 bg-destructive/5' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            {getComponentDisplayName(pred.component)}
                          </span>
                          <div className="flex items-center gap-1">
                            <TrendIcon
                              className="h-3 w-3"
                              style={{ color: trendColor }}
                            />
                            <span
                              className="text-xs"
                              style={{ color: trendColor }}
                            >
                              {pred.trend.replace('_', ' ')}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="flex items-center gap-1">
                              <Clock className="h-3 w-3 text-muted-foreground" />
                              <span
                                className={`font-semibold ${
                                  isUrgent ? 'text-destructive' : ''
                                }`}
                              >
                                {formatRUL(pred.estimatedRUL)}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {pred.confidence >= 0.8
                                ? 'High'
                                : pred.confidence >= 0.6
                                ? 'Medium'
                                : 'Low'}{' '}
                              confidence
                            </div>
                          </div>
                          <Badge
                            variant="outline"
                            style={{
                              borderColor: healthColor,
                              color: healthColor,
                            }}
                          >
                            {pred.healthScore}%
                          </Badge>
                        </div>
                      </div>

                      {/* Timeline bar */}
                      <div className="relative">
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${progressValue}%`,
                              backgroundColor: healthColor,
                            }}
                          />
                        </div>
                        {/* Threshold markers */}
                        <div
                          className="absolute top-0 h-2 w-0.5 bg-destructive"
                          style={{ left: `${(90 / maxDays) * 100}%` }}
                          title="90 days - Critical threshold"
                        />
                        <div
                          className="absolute top-0 h-2 w-0.5 bg-orange-500"
                          style={{ left: `${(180 / maxDays) * 100}%` }}
                          title="180 days - Warning threshold"
                        />
                      </div>

                      {/* Degradation rate */}
                      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                        <span>
                          Degradation: {(pred.degradationRate * 100).toFixed(2)}%/day
                        </span>
                        <span>
                          Model: {pred.modelVersion}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-between mt-6 pt-4 border-t text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className="w-0.5 h-3 bg-destructive" />
              <span>90d Critical</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-0.5 h-3 bg-orange-500" />
              <span>180d Warning</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <Minus className="h-3 w-3 text-green-600" />
              <span>Stable</span>
            </div>
            <div className="flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-orange-500" />
              <span>Degrading</span>
            </div>
            <div className="flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-red-500" />
              <span>Rapid</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default WindRULTimeline;
