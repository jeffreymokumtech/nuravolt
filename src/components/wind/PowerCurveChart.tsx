/**
 * PowerCurveChart - Wind turbine power curve visualization
 *
 * Features:
 * - Expected vs actual power by wind speed bin
 * - Confidence bands showing standard deviation
 * - Performance index indicator
 * - Interactive tooltips
 */

'use client';

import { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';
import type { PowerCurveAnalysis, PowerCurvePoint } from '@/types/wind';

interface ChartDataPoint {
  windSpeed: number;
  expected: number;
  actual: number;
  upper: number;
  lower: number;
  sampleCount: number;
  deficit: number;
  deficitPct: number;
}

interface PowerCurveChartProps {
  analysis: PowerCurveAnalysis;
  height?: number;
  showConfidenceBands?: boolean;
}

export function PowerCurveChart({
  analysis,
  height = 400,
  showConfidenceBands = true,
}: PowerCurveChartProps) {
  // Transform data for chart
  const chartData: ChartDataPoint[] = useMemo(() => {
    return analysis.points.map((point) => {
      const deficit = point.expectedPower - point.actualPower;
      const deficitPct = point.expectedPower > 0
        ? (deficit / point.expectedPower) * 100
        : 0;

      return {
        windSpeed: point.windSpeedBin,
        expected: point.expectedPower,
        actual: point.actualPower,
        upper: point.actualPower + point.stdDev,
        lower: Math.max(0, point.actualPower - point.stdDev),
        sampleCount: point.sampleCount,
        deficit,
        deficitPct,
      };
    });
  }, [analysis.points]);

  // Performance indicator
  const performanceColor = useMemo(() => {
    if (analysis.performanceIndex >= 0.98) return 'text-green-600';
    if (analysis.performanceIndex >= 0.95) return 'text-lime-600';
    if (analysis.performanceIndex >= 0.90) return 'text-yellow-600';
    if (analysis.performanceIndex >= 0.85) return 'text-orange-600';
    return 'text-red-600';
  }, [analysis.performanceIndex]);

  const anomalyBadge = useMemo(() => {
    if (analysis.anomalyScore < 0.1) return { variant: 'secondary' as const, text: 'Normal' };
    if (analysis.anomalyScore < 0.25) return { variant: 'outline' as const, text: 'Minor Deviation' };
    if (analysis.anomalyScore < 0.4) return { variant: 'default' as const, text: 'Moderate Anomaly' };
    return { variant: 'destructive' as const, text: 'High Anomaly' };
  }, [analysis.anomalyScore]);

  const title = analysis.turbineId
    ? `Power Curve - ${analysis.turbineId}`
    : 'Power Curve - Fleet Average';

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {title}
          </CardTitle>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">Performance:</span>
              <span className={`text-lg font-bold ${performanceColor}`}>
                {(analysis.performanceIndex * 100).toFixed(1)}%
              </span>
              {analysis.performanceIndex >= 0.95 ? (
                <TrendingUp className="h-4 w-4 text-green-600" />
              ) : (
                <TrendingDown className="h-4 w-4 text-orange-600" />
              )}
            </div>
            <Badge variant={anomalyBadge.variant}>{anomalyBadge.text}</Badge>
          </div>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground mt-1">
          <span>Cut-in: {analysis.cutInSpeed} m/s</span>
          <span>Rated: {analysis.ratedSpeed} m/s</span>
          <span>Cut-out: {analysis.cutOutSpeed} m/s</span>
          <span>Rated Power: {analysis.ratedPower} kW</span>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={chartData}
            margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="windSpeed"
              label={{ value: 'Wind Speed (m/s)', position: 'bottom', offset: -5 }}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              label={{
                value: 'Power (kW)',
                angle: -90,
                position: 'insideLeft',
                offset: 10,
              }}
              tick={{ fontSize: 11 }}
              domain={[0, analysis.ratedPower * 1.1]}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0].payload as ChartDataPoint;
                return (
                  <div className="bg-background border rounded-lg shadow-lg p-3 text-sm">
                    <p className="font-semibold mb-2">Wind Speed: {label} m/s</p>
                    <div className="space-y-1">
                      <p className="text-blue-600">
                        Expected: {data.expected.toFixed(0)} kW
                      </p>
                      <p className="text-green-600">
                        Actual: {data.actual.toFixed(0)} kW
                      </p>
                      <p className={data.deficit > 0 ? 'text-orange-600' : 'text-green-600'}>
                        Deficit: {data.deficit.toFixed(0)} kW ({data.deficitPct.toFixed(1)}%)
                      </p>
                      <p className="text-muted-foreground">
                        Samples: {data.sampleCount.toLocaleString()}
                      </p>
                    </div>
                  </div>
                );
              }}
            />
            <Legend />

            {/* Confidence bands */}
            {showConfidenceBands && (
              <Area
                type="monotone"
                dataKey="upper"
                stroke="none"
                fill="#22c55e"
                fillOpacity={0.1}
                name="Upper Bound"
                legendType="none"
              />
            )}
            {showConfidenceBands && (
              <Area
                type="monotone"
                dataKey="lower"
                stroke="none"
                fill="#ffffff"
                fillOpacity={1}
                name="Lower Bound"
                legendType="none"
              />
            )}

            {/* Expected power curve */}
            <Line
              type="monotone"
              dataKey="expected"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              name="Expected Power"
            />

            {/* Actual power curve */}
            <Line
              type="monotone"
              dataKey="actual"
              stroke="#22c55e"
              strokeWidth={2}
              dot={{ r: 3, fill: '#22c55e' }}
              name="Actual Power"
            />

            {/* Reference lines */}
            <ReferenceLine
              x={analysis.cutInSpeed}
              stroke="#94a3b8"
              strokeDasharray="5 5"
              label={{ value: 'Cut-in', position: 'top', fontSize: 10 }}
            />
            <ReferenceLine
              x={analysis.ratedSpeed}
              stroke="#94a3b8"
              strokeDasharray="5 5"
              label={{ value: 'Rated', position: 'top', fontSize: 10 }}
            />
            <ReferenceLine
              y={analysis.ratedPower}
              stroke="#f59e0b"
              strokeDasharray="3 3"
              label={{ value: 'Rated Power', position: 'right', fontSize: 10 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export default PowerCurveChart;
