'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, RefreshCw, Activity } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Scatter, ScatterChart } from 'recharts';
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

interface EnhancedPredictionsChartProps {
  inverterId?: string;
  timeRange?: { start: string; end: string };
  height?: string;
  showMetrics?: boolean;
  showAnomalyDetection?: boolean;
  autoRefresh?: boolean;
}

export default function EnhancedPredictionsChart({ 
  inverterId = 'all', 
  timeRange,
  height = '300px',
  showMetrics = true,
  showAnomalyDetection = true,
  autoRefresh = false
}: EnhancedPredictionsChartProps) {
  const [data, setData] = useState<PredictionData[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [anomalies, setAnomalies] = useState<PredictionData[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    fetchPredictions();
    
    if (autoRefresh) {
      const interval = setInterval(fetchPredictions, 30000); // Refresh every 30 seconds
      return () => clearInterval(interval);
    }
  }, [inverterId, timeRange, autoRefresh]);

  const fetchPredictions = async () => {
    try {
      const params = new URLSearchParams();
      if (inverterId && inverterId !== 'all') params.append('inverterId', inverterId);
      if (timeRange?.start) params.append('start', timeRange.start);
      if (timeRange?.end) params.append('end', timeRange.end);
      params.append('aggregation', 'hourly');

      const response = await fetch(`/api/predictions?${params}`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      
      // Process data for anomaly detection
      const processedData = processDataForAnomalyDetection(result.data || []);
      setData(processedData);
      
      // Extract anomalies
      const detectedAnomalies = processedData.filter(d => d.isAnomaly);
      setAnomalies(detectedAnomalies);

      // Fetch metrics
      const metricsResponse = await fetch('/api/predictions?metrics=true');
      
      if (!metricsResponse.ok) {
        console.warn('Failed to fetch metrics, using default values');
        setMetrics(null);
      } else {
        const metricsResult = await metricsResponse.json();
        setMetrics(metricsResult.metrics);
      }
      
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error fetching predictions:', error);
    } finally {
      setLoading(false);
    }
  };

  const processDataForAnomalyDetection = (rawData: any[]): PredictionData[] => {
    if (rawData.length === 0) return [];
    
    return rawData.map(point => {
      const truePower = point.true_power || point.truePower || 0;
      const predictedPower = point.predicted_power || point.predictedPower || 0;
      const predictionError = Math.abs(predictedPower - truePower);
      const performanceRatio = predictedPower > 0 ? truePower / predictedPower : 0;
      
      // Anomaly detection logic
      const isAnomaly = detectAnomaly(performanceRatio, predictionError, truePower, predictedPower);
      const anomalyScore = calculateAnomalyScore(performanceRatio, predictionError);
      
      return {
        timestamp: point.timestamp,
        truePower,
        predictedPower,
        irradiance: point.irradiance || 0,
        predictionError,
        mape: point.mape_pct || point.mape || 0,
        isAnomaly,
        anomalyScore,
        performanceRatio
      };
    });
  };

  const detectAnomaly = (performanceRatio: number, predictionError: number, truePower: number, predictedPower: number): boolean => {
    // Multiple criteria for anomaly detection
    const lowPerformance = performanceRatio < 0.7; // Performance ratio below 70%
    const highError = predictionError > Math.max(truePower, predictedPower) * 0.3; // Error > 30% of max power
    const zeroProduction = truePower === 0 && predictedPower > 0.1; // No production when expected
    const unexpectedHigh = truePower > predictedPower * 1.5 && truePower > 0.1; // Unexpectedly high production
    
    return lowPerformance || highError || zeroProduction || unexpectedHigh;
  };

  const calculateAnomalyScore = (performanceRatio: number, predictionError: number): number => {
    // Normalize anomaly score between 0 and 1
    const performanceScore = Math.max(0, 1 - performanceRatio);
    const errorScore = Math.min(1, predictionError / 1); // Normalize to 1kW
    
    return (performanceScore * 0.7 + errorScore * 0.3);
  };

  // Calculate current performance and anomaly statistics
  const latestData = data[data.length - 1];
  const accuracy = latestData ? (100 - latestData.mape).toFixed(1) : 0;
  const trend = latestData?.predictionError > 0 ? 'over' : 'under';
  const anomalyCount = anomalies.length;
  const recentAnomalies = anomalies.filter(a => {
    const anomalyTime = new Date(a.timestamp);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return anomalyTime > hourAgo;
  }).length;

  // Prepare chart data with anomaly information
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
    performanceRatio: parseFloat(formatNumber((d.performanceRatio || 0) * 100, 1)),
    isAnomaly: d.isAnomaly,
    anomalyScore: d.anomalyScore,
    fullTimestamp: d.timestamp
  }));

  const CustomDot = (props: any) => {
    const { cx, cy, payload } = props;
    if (payload.isAnomaly) {
      return (
        <circle
          cx={cx}
          cy={cy}
          r={5}
          fill="#ef4444"
          stroke="#dc2626"
          strokeWidth={2}
        />
      );
    }
    return null; // Let default dots show for non-anomalies
  };

  const maxPower = Math.max(...data.map(d => Math.max(d.truePower, d.predictedPower)), 1);

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Predictions vs Actual
              {showAnomalyDetection && anomalyCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {anomalyCount} Anomalies
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {inverterId === 'all' ? 'All Inverters' : inverterId} - ML Model Performance & Anomaly Detection
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {showMetrics && metrics && (
              <div className="flex gap-2">
                <Badge variant="outline">
                  R² {formatMetric(metrics.overall.r2Score)}
                </Badge>
                <Badge variant={parseFloat(String(accuracy)) > 90 ? 'default' : 'secondary'}>
                  {formatNumber(Number(accuracy), 1)}% Accurate
                </Badge>
                {recentAnomalies > 0 && (
                  <Badge variant="destructive">
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    {recentAnomalies} Recent
                  </Badge>
                )}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={fetchPredictions}
              disabled={loading}
              className="h-8"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center" style={{ height }}>
            <div className="text-gray-500">Loading predictions...</div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center" style={{ height }}>
            <div className="text-gray-500 mb-2">No data available for the selected period</div>
            <Button size="sm" variant="outline" onClick={fetchPredictions}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : (
          <>
            {/* Enhanced Recharts Interactive Chart */}
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
                      name.includes('Power') ? formatPower(value * 1000) : value,
                      name === 'actualPower' ? 'Actual Power' : 
                      name === 'predictedPower' ? 'Predicted Power' :
                      name === 'performanceRatio' ? 'Performance Ratio' : name
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
                    dot={<CustomDot />}
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
                  
                  {/* Reference lines for anomaly detection thresholds */}
                  <ReferenceLine y={0} stroke="#666" strokeWidth={1} strokeDasharray="2 2" />
                  {maxPower > 0 && (
                    <ReferenceLine 
                      y={maxPower * 0.7} 
                      stroke="#ef4444" 
                      strokeDasharray="3 3" 
                      label={{ value: "Anomaly Threshold", position: "top" }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            
            {/* Enhanced Metrics Summary */}
            {showMetrics && metrics && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-4 border-t">
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
                {showAnomalyDetection && (
                  <div>
                    <p className="text-sm text-gray-500">Anomalies Detected</p>
                    <div className="flex items-center gap-1">
                      <AlertTriangle className="w-4 h-4 text-red-500" />
                      <span className="text-lg font-semibold text-blue-700">{anomalyCount}</span>
                      <span className="text-xs text-gray-500">({recentAnomalies} recent)</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* Anomaly Summary */}
            {showAnomalyDetection && anomalies.length > 0 && (
              <div className="mt-4 p-3 bg-blue-50 border border-red-200 rounded-lg">
                <h4 className="font-medium text-red-800 mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Recent Anomalies Detected
                </h4>
                <div className="space-y-1">
                  {anomalies.slice(-3).map((anomaly, index) => {
                    const time = new Date(anomaly.timestamp).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit'
                    });
                    const severity = (anomaly.anomalyScore || 0) > 0.7 ? 'High' : (anomaly.anomalyScore || 0) > 0.4 ? 'Medium' : 'Low';
                    return (
                      <p key={index} className="text-sm text-red-700">
                        {time}: {formatPower(anomaly.truePower * 1000)} actual vs {formatPower(anomaly.predictedPower * 1000)} expected 
                        <span className="font-medium"> ({severity} severity)</span>
                      </p>
                    );
                  })}
                  {anomalies.length > 3 && (
                    <p className="text-xs text-blue-700">... and {anomalies.length - 3} more anomalies</p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}