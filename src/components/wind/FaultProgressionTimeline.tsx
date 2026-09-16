/**
 * FaultProgressionTimeline - Shows temperature/metric progression leading to a fault
 *
 * Features:
 * - Days-to-failure countdown visualization
 * - Temperature trend leading up to fault
 * - NBM residual z-score overlay
 * - Lead time comparison (detected vs labeled)
 * - Visual distinction for ground-truth events
 */

'use client';

import { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Clock, TrendingUp, CheckCircle, Target } from 'lucide-react';
import type {
  WindFault,
  LabeledFaultEvent,
  FaultSource,
} from '@/types/wind';

interface ProgressionDataPoint {
  daysToFailure: number;
  date: string;
  temperature: number;
  normalTemp: number;
  residual: number;
  zScore: number;
  isAnomaly: boolean;
}

interface FaultProgressionTimelineProps {
  labeledEvent: LabeledFaultEvent;
  detectedFault?: WindFault;
  temperatureData?: ProgressionDataPoint[];
  height?: number;
}

export function FaultProgressionTimeline({
  labeledEvent,
  detectedFault,
  temperatureData,
  height = 350,
}: FaultProgressionTimelineProps) {
  // Generate synthetic progression data if not provided
  const progressionData: ProgressionDataPoint[] = useMemo(() => {
    if (temperatureData) return temperatureData;

    // Generate 30 days of data leading up to the fault
    const points: ProgressionDataPoint[] = [];
    const eventStart = new Date(labeledEvent.eventStart);
    const durationDays = labeledEvent.careMetadata?.durationDays || 14;

    // Normal operating temperature
    const baseTemp = 55;
    const normalVariance = 3;

    for (let i = 30; i >= -durationDays; i--) {
      const date = new Date(eventStart);
      date.setDate(date.getDate() - i);

      // Temperature rises as we approach the fault
      let tempIncrease = 0;
      let residual = 0;

      if (i <= 20 && i > 0) {
        // Gradual increase starting 20 days before
        tempIncrease = ((20 - i) / 20) * 15;
        residual = tempIncrease * 0.8;
      } else if (i <= 0) {
        // Fault period - high temperature
        tempIncrease = 18 + Math.random() * 5;
        residual = tempIncrease + 2;
      }

      const temperature =
        baseTemp + tempIncrease + (Math.random() - 0.5) * normalVariance;
      const normalTemp = baseTemp + (Math.random() - 0.5) * 2;
      const zScore = residual / 3.5; // Threshold at 2.5

      points.push({
        daysToFailure: i,
        date: date.toISOString().split('T')[0],
        temperature: Math.round(temperature * 10) / 10,
        normalTemp: Math.round(normalTemp * 10) / 10,
        residual: Math.round(residual * 10) / 10,
        zScore: Math.round(zScore * 100) / 100,
        isAnomaly: zScore > 2.5,
      });
    }

    return points;
  }, [temperatureData, labeledEvent]);

  // Calculate lead time if detected fault exists
  const leadTimeDays = useMemo(() => {
    if (!detectedFault?.detectedAt) return null;

    const detectedDate = new Date(detectedFault.detectedAt);
    const eventDate = new Date(labeledEvent.eventStart);
    const diffMs = eventDate.getTime() - detectedDate.getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
  }, [detectedFault, labeledEvent]);

  // Find first anomaly point for detection marker
  const firstAnomalyIdx = progressionData.findIndex((p) => p.isAnomaly);
  const detectionPoint = firstAnomalyIdx >= 0 ? progressionData[firstAnomalyIdx] : null;

  // Severity color
  const severityColors: Record<string, string> = {
    CRITICAL: '#dc2626',
    HIGH: '#ea580c',
    MEDIUM: '#ca8a04',
    LOW: '#2563eb',
  };
  const severityColor = severityColors[labeledEvent.faultType.severity] || '#6b7280';

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-orange-500" />
              Fault Progression Timeline
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {labeledEvent.faultType.name} - {labeledEvent.turbineId}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge
              variant="secondary"
              className="bg-purple-100 text-purple-700"
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              Ground Truth
            </Badge>
            <Badge
              variant="outline"
              style={{ borderColor: severityColor, color: severityColor }}
            >
              {labeledEvent.faultType.severity}
            </Badge>
          </div>
        </div>

        {/* Lead time indicator */}
        {leadTimeDays !== null && leadTimeDays > 0 && (
          <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-green-600" />
              <span className="text-sm font-medium text-green-700">
                Early Detection Success
              </span>
            </div>
            <p className="text-lg font-bold text-green-700 mt-1">
              Detected {leadTimeDays} days before failure
            </p>
            <p className="text-xs text-green-600 mt-1">
              ML model identified anomaly on{' '}
              {detectedFault?.detectedAt &&
                new Date(detectedFault.detectedAt).toLocaleDateString()}
            </p>
          </div>
        )}
      </CardHeader>

      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={progressionData}
            margin={{ top: 20, right: 30, left: 10, bottom: 10 }}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="daysToFailure"
              tick={{ fontSize: 10 }}
              tickFormatter={(value) =>
                value === 0 ? 'Failure' : value > 0 ? `${value}d` : ''
              }
              label={{
                value: 'Days to Failure',
                position: 'bottom',
                offset: -5,
                fontSize: 11,
              }}
              reversed
            />

            {/* Left Y-axis for Temperature */}
            <YAxis
              yAxisId="left"
              orientation="left"
              tick={{ fontSize: 10 }}
              domain={['dataMin - 5', 'dataMax + 5']}
              label={{
                value: 'Temperature (°C)',
                angle: -90,
                position: 'insideLeft',
                fontSize: 11,
              }}
            />

            {/* Right Y-axis for Z-Score */}
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10 }}
              domain={[0, 'dataMax + 1']}
              label={{
                value: 'Z-Score',
                angle: 90,
                position: 'insideRight',
                fontSize: 11,
              }}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0].payload as ProgressionDataPoint;

                return (
                  <div className="bg-background border rounded-lg shadow-lg p-3 text-sm">
                    <p className="font-semibold mb-2">
                      {data.daysToFailure > 0
                        ? `${data.daysToFailure} days before failure`
                        : data.daysToFailure === 0
                        ? 'Day of failure'
                        : `${Math.abs(data.daysToFailure)} days after start`}
                    </p>
                    <p className="text-xs text-muted-foreground mb-2">
                      {data.date}
                    </p>
                    <div className="space-y-1">
                      <p className="text-orange-600">
                        Temp: {data.temperature}°C
                      </p>
                      <p className="text-green-600">
                        Normal: {data.normalTemp}°C
                      </p>
                      <p className="text-blue-600">
                        Residual: {data.residual}°C
                      </p>
                      <p
                        className={
                          data.isAnomaly ? 'text-red-600 font-bold' : 'text-gray-600'
                        }
                      >
                        Z-Score: {data.zScore.toFixed(2)}
                        {data.isAnomaly && ' ⚠️ ANOMALY'}
                      </p>
                    </div>
                  </div>
                );
              }}
            />
            <Legend />

            {/* Fault period area */}
            <ReferenceArea
              x1={0}
              x2={-(labeledEvent.careMetadata?.durationDays || 14)}
              yAxisId="left"
              fill="#ef4444"
              fillOpacity={0.1}
              stroke="#ef4444"
              strokeOpacity={0.3}
            />

            {/* Detection threshold line */}
            <ReferenceLine
              y={2.5}
              yAxisId="right"
              stroke="#ef4444"
              strokeDasharray="5 5"
              label={{
                value: 'Anomaly Threshold (z=2.5)',
                position: 'right',
                fontSize: 10,
                fill: '#ef4444',
              }}
            />

            {/* Failure marker */}
            <ReferenceLine
              x={0}
              stroke="#dc2626"
              strokeWidth={2}
              label={{
                value: 'Failure',
                position: 'top',
                fontSize: 11,
                fill: '#dc2626',
              }}
            />

            {/* Detection marker (if early detection) */}
            {detectionPoint && leadTimeDays !== null && leadTimeDays > 0 && (
              <ReferenceLine
                x={detectionPoint.daysToFailure}
                stroke="#22c55e"
                strokeWidth={2}
                strokeDasharray="5 5"
                label={{
                  value: 'ML Detected',
                  position: 'top',
                  fontSize: 10,
                  fill: '#22c55e',
                }}
              />
            )}

            {/* Normal temperature baseline */}
            <Line
              type="monotone"
              dataKey="normalTemp"
              yAxisId="left"
              stroke="#94a3b8"
              strokeWidth={1}
              strokeDasharray="3 3"
              dot={false}
              name="Normal Baseline"
            />

            {/* Actual temperature */}
            <Line
              type="monotone"
              dataKey="temperature"
              yAxisId="left"
              stroke="#f97316"
              strokeWidth={2}
              dot={{ r: 2, fill: '#f97316' }}
              activeDot={{ r: 5 }}
              name="Temperature"
            />

            {/* Z-Score bars */}
            <Bar
              dataKey="zScore"
              yAxisId="right"
              fill="#3b82f6"
              fillOpacity={0.5}
              name="Z-Score"
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* Event description */}
        <div className="mt-4 p-3 bg-slate-50 rounded-lg border">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="h-4 w-4 mt-0.5"
              style={{ color: severityColor }}
            />
            <div>
              <p className="text-sm font-medium text-slate-700">
                {labeledEvent.description}
              </p>
              <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                <span>
                  <Clock className="h-3 w-3 inline mr-1" />
                  Duration: {labeledEvent.careMetadata?.durationDays || 'N/A'} days
                </span>
                <span>
                  Dataset: {labeledEvent.datasetId}
                </span>
                <span>
                  Features: {labeledEvent.careMetadata?.features || 86}
                </span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default FaultProgressionTimeline;
