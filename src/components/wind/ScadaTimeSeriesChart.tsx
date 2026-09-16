/**
 * ScadaTimeSeriesChart - Wind turbine SCADA time-series visualization
 *
 * Features:
 * - Multi-signal overlay with configurable visibility
 * - Labeled fault event markers
 * - Anomaly highlighting with z-score indicators
 * - Zoom and pan controls
 * - Resolution selector (10min, hourly, daily)
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
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
  ReferenceArea,
  Brush,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Activity,
  Thermometer,
  Wind,
  Zap,
  AlertTriangle,
  Clock,
  RotateCcw,
  ZoomIn,
} from 'lucide-react';
import type {
  ScadaTimeSeriesResponse,
  WindScadaPoint,
  LabeledFaultEvent,
} from '@/types/wind';

interface SignalConfig {
  key: keyof WindScadaPoint;
  label: string;
  color: string;
  unit: string;
  yAxisId: 'left' | 'right';
  icon: typeof Activity;
  category: 'power' | 'temperature' | 'wind' | 'rpm';
}

const SIGNAL_CONFIGS: SignalConfig[] = [
  {
    key: 'activePower',
    label: 'Active Power',
    color: '#22c55e',
    unit: 'kW',
    yAxisId: 'left',
    icon: Zap,
    category: 'power',
  },
  {
    key: 'windSpeed',
    label: 'Wind Speed',
    color: '#3b82f6',
    unit: 'm/s',
    yAxisId: 'right',
    icon: Wind,
    category: 'wind',
  },
  {
    key: 'gearboxOilTemp',
    label: 'Gearbox Oil Temp',
    color: '#f97316',
    unit: '°C',
    yAxisId: 'right',
    icon: Thermometer,
    category: 'temperature',
  },
  {
    key: 'gearboxBearingTemp',
    label: 'Gearbox Bearing Temp',
    color: '#ef4444',
    unit: '°C',
    yAxisId: 'right',
    icon: Thermometer,
    category: 'temperature',
  },
  {
    key: 'generatorBearingTempDE',
    label: 'Gen Bearing DE',
    color: '#8b5cf6',
    unit: '°C',
    yAxisId: 'right',
    icon: Thermometer,
    category: 'temperature',
  },
  {
    key: 'generatorBearingTempNDE',
    label: 'Gen Bearing NDE',
    color: '#a855f7',
    unit: '°C',
    yAxisId: 'right',
    icon: Thermometer,
    category: 'temperature',
  },
  {
    key: 'mainBearingTemp',
    label: 'Main Bearing Temp',
    color: '#ec4899',
    unit: '°C',
    yAxisId: 'right',
    icon: Thermometer,
    category: 'temperature',
  },
  {
    key: 'rotorRpm',
    label: 'Rotor RPM',
    color: '#06b6d4',
    unit: 'rpm',
    yAxisId: 'right',
    icon: Activity,
    category: 'rpm',
  },
];

interface ScadaTimeSeriesChartProps {
  data: ScadaTimeSeriesResponse;
  height?: number;
  defaultSignals?: string[];
  onDateRangeChange?: (start: string, end: string) => void;
}

export function ScadaTimeSeriesChart({
  data,
  height = 500,
  defaultSignals = ['activePower', 'windSpeed', 'gearboxBearingTemp'],
  onDateRangeChange,
}: ScadaTimeSeriesChartProps) {
  const [visibleSignals, setVisibleSignals] = useState<Set<string>>(
    new Set(defaultSignals)
  );
  const [zoomArea, setZoomArea] = useState<{
    refAreaLeft?: string;
    refAreaRight?: string;
  }>({});
  const [zoomedDomain, setZoomedDomain] = useState<{
    left?: number;
    right?: number;
  }>({});

  // Transform data for chart
  const chartData = useMemo(() => {
    return data.points.map((point, index) => ({
      ...point,
      index,
      time: new Date(point.timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    }));
  }, [data.points]);

  // Map labeled events to chart indices
  const eventMarkers = useMemo(() => {
    if (!data.labeledEvents?.length) return [];

    return data.labeledEvents.map((event) => {
      const startTime = new Date(event.eventStart).getTime();
      const endTime = new Date(event.eventEnd).getTime();

      const startIdx = chartData.findIndex(
        (p) => new Date(p.timestamp).getTime() >= startTime
      );
      const endIdx = chartData.findIndex(
        (p) => new Date(p.timestamp).getTime() >= endTime
      );

      return {
        ...event,
        startIdx: startIdx >= 0 ? startIdx : 0,
        endIdx: endIdx >= 0 ? endIdx : chartData.length - 1,
      };
    });
  }, [data.labeledEvents, chartData]);

  // Map anomaly highlights to indices
  const anomalyMarkers = useMemo(() => {
    if (!data.anomalyHighlights?.length) return [];

    return data.anomalyHighlights.map((anomaly) => {
      const startTime = new Date(anomaly.start).getTime();
      const endTime = new Date(anomaly.end).getTime();

      const startIdx = chartData.findIndex(
        (p) => new Date(p.timestamp).getTime() >= startTime
      );
      const endIdx = chartData.findIndex(
        (p) => new Date(p.timestamp).getTime() >= endTime
      );

      return {
        ...anomaly,
        startIdx: startIdx >= 0 ? startIdx : 0,
        endIdx: endIdx >= 0 ? endIdx : chartData.length - 1,
      };
    });
  }, [data.anomalyHighlights, chartData]);

  // Toggle signal visibility
  const toggleSignal = useCallback((signalKey: string) => {
    setVisibleSignals((prev) => {
      const next = new Set(prev);
      if (next.has(signalKey)) {
        next.delete(signalKey);
      } else {
        next.add(signalKey);
      }
      return next;
    });
  }, []);

  // Reset zoom
  const resetZoom = useCallback(() => {
    setZoomedDomain({});
    setZoomArea({});
  }, []);

  // Handle zoom selection
  const handleMouseDown = useCallback(
    (e: { activeLabel?: string }) => {
      if (e.activeLabel) {
        setZoomArea({ refAreaLeft: e.activeLabel });
      }
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: { activeLabel?: string }) => {
      if (zoomArea.refAreaLeft && e.activeLabel) {
        setZoomArea((prev) => ({ ...prev, refAreaRight: e.activeLabel }));
      }
    },
    [zoomArea.refAreaLeft]
  );

  const handleMouseUp = useCallback(() => {
    if (zoomArea.refAreaLeft && zoomArea.refAreaRight) {
      const left = chartData.findIndex((p) => p.time === zoomArea.refAreaLeft);
      const right = chartData.findIndex((p) => p.time === zoomArea.refAreaRight);

      if (left !== -1 && right !== -1) {
        const [minIdx, maxIdx] = [Math.min(left, right), Math.max(left, right)];
        setZoomedDomain({ left: minIdx, right: maxIdx });

        // Notify parent of date range change
        if (onDateRangeChange && chartData[minIdx] && chartData[maxIdx]) {
          onDateRangeChange(
            chartData[minIdx].timestamp,
            chartData[maxIdx].timestamp
          );
        }
      }
    }
    setZoomArea({});
  }, [zoomArea, chartData, onDateRangeChange]);

  // Get visible signal configs
  const visibleConfigs = SIGNAL_CONFIGS.filter((c) =>
    visibleSignals.has(c.key)
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5" />
            SCADA Time-Series - {data.turbineId}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {data.resolution}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {data.points.length.toLocaleString()} points
            </Badge>
            {zoomedDomain.left !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                onClick={resetZoom}
                className="h-7 px-2"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset Zoom
              </Button>
            )}
          </div>
        </div>

        {/* Signal toggles */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {SIGNAL_CONFIGS.map((config) => (
            <Button
              key={config.key}
              variant={visibleSignals.has(config.key) ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleSignal(config.key)}
              className="h-7 text-xs"
              style={{
                backgroundColor: visibleSignals.has(config.key)
                  ? config.color
                  : undefined,
                borderColor: config.color,
                color: visibleSignals.has(config.key) ? 'white' : config.color,
              }}
            >
              <config.icon className="h-3 w-3 mr-1" />
              {config.label}
            </Button>
          ))}
        </div>

        {/* Labeled events legend */}
        {eventMarkers.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t">
            <span className="text-xs text-muted-foreground">Labeled Events:</span>
            {eventMarkers.map((event) => (
              <Badge
                key={event.id}
                variant="secondary"
                className="text-xs bg-purple-100 text-purple-700"
              >
                <AlertTriangle className="h-3 w-3 mr-1" />
                {event.faultType.name}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent>
        <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
          <ZoomIn className="h-3 w-3" />
          Click and drag to zoom into a region
        </div>

        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={chartData}
            margin={{ top: 10, right: 60, left: 10, bottom: 10 }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
              domain={
                zoomedDomain.left !== undefined
                  ? [zoomedDomain.left, zoomedDomain.right]
                  : undefined
              }
            />

            {/* Left Y-axis for Power */}
            <YAxis
              yAxisId="left"
              orientation="left"
              tick={{ fontSize: 10 }}
              label={{
                value: 'Power (kW)',
                angle: -90,
                position: 'insideLeft',
                fontSize: 11,
              }}
            />

            {/* Right Y-axis for other signals */}
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10 }}
              label={{
                value: 'Temp (°C) / Speed (m/s)',
                angle: 90,
                position: 'insideRight',
                fontSize: 11,
              }}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0].payload as WindScadaPoint & { time: string };

                return (
                  <div className="bg-background border rounded-lg shadow-lg p-3 text-xs max-w-xs">
                    <p className="font-semibold mb-2">{label}</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {payload.map((entry) => {
                        const config = SIGNAL_CONFIGS.find(
                          (c) => c.key === entry.dataKey
                        );
                        if (!config) return null;
                        return (
                          <div
                            key={entry.dataKey}
                            className="flex justify-between gap-2"
                          >
                            <span style={{ color: config.color }}>
                              {config.label}:
                            </span>
                            <span className="font-mono">
                              {typeof entry.value === 'number'
                                ? entry.value.toFixed(1)
                                : entry.value}{' '}
                              {config.unit}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value) => {
                const config = SIGNAL_CONFIGS.find((c) => c.label === value);
                return config ? `${value} (${config.unit})` : value;
              }}
            />

            {/* Labeled event regions */}
            {eventMarkers.map((event) => (
              <ReferenceArea
                key={event.id}
                x1={chartData[event.startIdx]?.time}
                x2={chartData[event.endIdx]?.time}
                yAxisId="left"
                fill="#8b5cf6"
                fillOpacity={0.15}
                stroke="#8b5cf6"
                strokeOpacity={0.3}
              />
            ))}

            {/* Anomaly highlight regions */}
            {anomalyMarkers.map((anomaly, idx) => (
              <ReferenceArea
                key={`anomaly-${idx}`}
                x1={chartData[anomaly.startIdx]?.time}
                x2={chartData[anomaly.endIdx]?.time}
                yAxisId="left"
                fill="#ef4444"
                fillOpacity={0.1}
                stroke="#ef4444"
                strokeOpacity={0.3}
              />
            ))}

            {/* Zoom selection area */}
            {zoomArea.refAreaLeft && zoomArea.refAreaRight && (
              <ReferenceArea
                x1={zoomArea.refAreaLeft}
                x2={zoomArea.refAreaRight}
                yAxisId="left"
                fill="#3b82f6"
                fillOpacity={0.3}
              />
            )}

            {/* Signal lines */}
            {visibleConfigs.map((config) => (
              <Line
                key={config.key}
                type="monotone"
                dataKey={config.key}
                yAxisId={config.yAxisId}
                stroke={config.color}
                strokeWidth={1.5}
                dot={false}
                name={config.label}
                connectNulls
              />
            ))}

            {/* Brush for overview navigation */}
            <Brush
              dataKey="time"
              height={30}
              stroke="#3b82f6"
              fill="#f1f5f9"
              startIndex={zoomedDomain.left}
              endIndex={zoomedDomain.right}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* Anomaly summary */}
        {anomalyMarkers.length > 0 && (
          <div className="mt-4 p-3 bg-red-50 rounded-lg border border-red-200">
            <div className="flex items-center gap-2 text-sm font-medium text-red-700 mb-2">
              <AlertTriangle className="h-4 w-4" />
              {anomalyMarkers.length} Anomaly Period{anomalyMarkers.length > 1 ? 's' : ''} Detected
            </div>
            <div className="flex flex-wrap gap-2">
              {anomalyMarkers.slice(0, 5).map((anomaly, idx) => (
                <Badge key={idx} variant="outline" className="text-xs text-red-600">
                  {anomaly.signal}: z-score {anomaly.zScore.toFixed(1)}
                </Badge>
              ))}
              {anomalyMarkers.length > 5 && (
                <Badge variant="secondary" className="text-xs">
                  +{anomalyMarkers.length - 5} more
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ScadaTimeSeriesChart;
