'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, RefreshCw, Activity } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { formatNumber, formatPower, formatMetric } from '@/utils/formatNumber';

interface PredictionData {
  timestamp: string;
  truePower: number;
  predictedPower: number;
  irradiance: number;
  predictionError: number;
  mape: number;
  isAnomaly?: boolean;
  anomalyScore?: number;
  performanceRatio?: number;
}

interface PredictionsChartProps {
  inverterId?: string;
  timeRange?: { start: string; end: string };
  height?: string;
  showMetrics?: boolean;
  showAnomalyDetection?: boolean;
  autoRefresh?: boolean;
}

export default function PredictionsChart({ 
  inverterId = 'all', 
  timeRange,
  height = '300px',
  showMetrics = true,
  showAnomalyDetection = true,
  autoRefresh = false
}: PredictionsChartProps) {
  const [data, setData] = useState<PredictionData[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [anomalies, setAnomalies] = useState<PredictionData[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    fetchPredictions();
  }, [inverterId, timeRange]);

  const fetchPredictions = async () => {
    try {
      const params = new URLSearchParams();
      if (inverterId && inverterId !== 'all') params.append('inverterId', inverterId);
      if (timeRange?.start) params.append('start', timeRange.start);
      if (timeRange?.end) params.append('end', timeRange.end);
      params.append('aggregation', 'hourly');

      const response = await fetch(`/api/predictions?${params}`);
      const result = await response.json();
      setData(result.data || []);

      // Fetch metrics
      const metricsResponse = await fetch('/api/predictions?metrics=true');
      const metricsResult = await metricsResponse.json();
      setMetrics(metricsResult.metrics);
    } catch (error) {
      console.error('Error fetching predictions:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate current performance
  const latestData = data[data.length - 1];
  const accuracy = latestData ? (100 - latestData.mape).toFixed(1) : '0';
  const trend = latestData?.predictionError > 0 ? 'over' : 'under';

  // Prepare chart data
  const chartData = data.slice(-48).map(d => ({
    timestamp: new Date(d.timestamp).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      month: 'short',
      day: 'numeric'
    }),
    actualPower: parseFloat(formatNumber(d.truePower, 3)),
    predictedPower: parseFloat(formatNumber(d.predictedPower, 3)),
    irradiance: parseFloat(formatNumber(d.irradiance, 1)),
    error: parseFloat(formatNumber(Math.abs(d.predictionError), 3)),
    fullTimestamp: d.timestamp
  }));

  const maxPower = Math.max(...data.map(d => Math.max(d.truePower, d.predictedPower)), 1);

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle>Predictions vs Actual</CardTitle>
            <CardDescription>
              {inverterId === 'all' ? 'All Inverters' : inverterId} - ML Model Performance
            </CardDescription>
          </div>
          {showMetrics && metrics && (
            <div className="flex gap-2">
              <Badge variant="outline">
                R² {formatMetric(metrics.overall.r2Score)}
              </Badge>
              <Badge variant={parseFloat(accuracy) > 90 ? 'default' : 'secondary'}>
                {formatNumber(accuracy, 1)}% Accurate
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center" style={{ height }}>
            <div className="text-gray-500">Loading predictions...</div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center" style={{ height }}>
            <div className="text-gray-500">No data available for the selected period</div>
          </div>
        ) : (
          <>
            {/* Recharts Interactive Chart */}
            <div style={{ height }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 5, right: 30, left: 20, bottom: 60 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis 
                    dataKey="timestamp" 
                    tick={{ fontSize: 12, fill: '#666' }}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    tick={{ fontSize: 12, fill: '#666' }}
                    tickFormatter={(value) => formatNumber(value, 2)}
                    label={{ value: 'Power (kW)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip 
                    formatter={(value: any, name: string) => [
                      formatPower(value * 1000), // Convert back to watts for display
                      name === 'actualPower' ? 'Actual Power' : 'Predicted Power'
                    ]}
                    labelFormatter={(label) => `Time: ${label}`}
                    contentStyle={{
                      backgroundColor: 'rgba(255, 255, 255, 0.95)',
                      border: '1px solid #ccc',
                      borderRadius: '6px',
                      boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
                    }}
                  />
                  <Legend 
                    wrapperStyle={{ paddingTop: '20px' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="actualPower" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    dot={{ fill: '#3b82f6', strokeWidth: 2, r: 3 }}
                    name="Actual Power"
                    connectNulls={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="predictedPower" 
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ fill: '#10b981', strokeWidth: 2, r: 3 }}
                    name="Predicted Power"
                    connectNulls={false}
                  />
                  {/* Reference line for zero */}
                  <ReferenceLine y={0} stroke="#666" strokeWidth={1} strokeDasharray="2 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            
            {/* Metrics Summary */}
            {showMetrics && metrics && (
              <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t">
                <div>
                  <p className="text-sm text-gray-500">Mean Error</p>
                  <p className="text-lg font-semibold">
                    {formatMetric(metrics.overall.mae)} kW
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">MAPE</p>
                  <p className="text-lg font-semibold">
                    {formatNumber(metrics.overall.mape, 1)}%
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Trend</p>
                  <div className="flex items-center gap-1">
                    {trend === 'over' ? (
                      <TrendingUp className="w-4 h-4 text-orange-500" />
                    ) : trend === 'under' ? (
                      <TrendingDown className="w-4 h-4 text-blue-500" />
                    ) : (
                      <Minus className="w-4 h-4 text-gray-500" />
                    )}
                    <span className="text-lg font-semibold capitalize">{trend}</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}