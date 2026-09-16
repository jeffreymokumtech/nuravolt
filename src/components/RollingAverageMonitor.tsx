'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  TrendingUp, 
  TrendingDown,
  Activity,
  RefreshCw,
  Calendar,
  BarChart3,
  Target
} from 'lucide-react';
import { formatNumber, formatPower, formatPercentage } from '@/utils/formatNumber';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

interface RollingAverageData {
  period: string;
  timestamp: string;
  actualPower: number;
  expectedPower: number;
  performanceRatio: number;
  rollingAvg24h: number;
  rollingAvg7d: number;
  rollingAvg30d: number;
}

interface PerformanceMetrics {
  current: {
    power: number;
    performanceRatio: number;
    trend24h: number;
    trend7d: number;
  };
  averages: {
    avg24h: number;
    avg7d: number;
    avg30d: number;
  };
  alerts: {
    underperforming24h: boolean;
    underperforming7d: boolean;
    criticalThreshold: boolean;
  };
}

interface RollingAverageMonitorProps {
  inverterId?: string;
  timeRange?: { start: string; end: string };
  height?: string;
}

export default function RollingAverageMonitor({ 
  inverterId = 'all', 
  timeRange,
  height = '300px' 
}: RollingAverageMonitorProps) {
  const [data, setData] = useState<RollingAverageData[]>([]);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<'24h' | '7d' | '30d'>('24h');

  useEffect(() => {
    fetchRollingAverageData();
  }, [inverterId, timeRange, selectedPeriod]);

  const fetchRollingAverageData = async () => {
    try {
      setLoading(true);
      
      // Fetch predictions data for rolling average calculation
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
      
      if (result.data && result.data.length > 0) {
        const rollingData = calculateRollingAverages(result.data);
        setData(rollingData);
        setMetrics(calculatePerformanceMetrics(rollingData));
      } else {
        // Generate mock data for demonstration
        const mockData = generateMockRollingData();
        setData(mockData);
        setMetrics(calculatePerformanceMetrics(mockData));
      }
    } catch (error) {
      console.error('Error fetching rolling average data:', error);
      // Generate mock data as fallback
      const mockData = generateMockRollingData();
      setData(mockData);
      setMetrics(calculatePerformanceMetrics(mockData));
    } finally {
      setLoading(false);
    }
  };

  const calculateRollingAverages = (rawData: any[]): RollingAverageData[] => {
    const sortedData = rawData.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return sortedData.map((point, index) => {
      const currentTime = new Date(point.timestamp);
      
      // Calculate rolling averages
      const rollingAvg24h = calculateRollingAverage(sortedData, index, 24);
      const rollingAvg7d = calculateRollingAverage(sortedData, index, 24 * 7);
      const rollingAvg30d = calculateRollingAverage(sortedData, index, 24 * 30);

      return {
        period: currentTime.toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit',
          minute: '2-digit'
        }),
        timestamp: point.timestamp,
        actualPower: point.true_power || point.truePower || 0,
        expectedPower: point.predicted_power || point.predictedPower || 0,
        performanceRatio: (point.true_power || point.truePower || 0) / (point.predicted_power || point.predictedPower || 1),
        rollingAvg24h,
        rollingAvg7d,
        rollingAvg30d
      };
    });
  };

  const calculateRollingAverage = (data: any[], currentIndex: number, windowHours: number): number => {
    const currentTime = new Date(data[currentIndex].timestamp);
    const windowStart = new Date(currentTime.getTime() - windowHours * 60 * 60 * 1000);
    
    const windowData = data
      .slice(0, currentIndex + 1)
      .filter(point => new Date(point.timestamp) >= windowStart);
    
    if (windowData.length === 0) return 0;
    
    const sum = windowData.reduce((acc, point) => acc + (point.true_power || point.truePower || 0), 0);
    return sum / windowData.length;
  };

  const calculatePerformanceMetrics = (data: RollingAverageData[]): PerformanceMetrics => {
    if (data.length === 0) {
      return {
        current: { power: 0, performanceRatio: 0, trend24h: 0, trend7d: 0 },
        averages: { avg24h: 0, avg7d: 0, avg30d: 0 },
        alerts: { underperforming24h: false, underperforming7d: false, criticalThreshold: false }
      };
    }

    const latest = data[data.length - 1];
    const previous24h = data.length > 24 ? data[data.length - 25] : data[0];
    const previous7d = data.length > 168 ? data[data.length - 169] : data[0];

    const trend24h = ((latest.rollingAvg24h - previous24h.rollingAvg24h) / previous24h.rollingAvg24h) * 100;
    const trend7d = ((latest.rollingAvg7d - previous7d.rollingAvg7d) / previous7d.rollingAvg7d) * 100;

    return {
      current: {
        power: latest.actualPower,
        performanceRatio: latest.performanceRatio,
        trend24h: isFinite(trend24h) ? trend24h : 0,
        trend7d: isFinite(trend7d) ? trend7d : 0
      },
      averages: {
        avg24h: latest.rollingAvg24h,
        avg7d: latest.rollingAvg7d,
        avg30d: latest.rollingAvg30d
      },
      alerts: {
        underperforming24h: latest.actualPower < latest.rollingAvg24h * 0.9,
        underperforming7d: latest.actualPower < latest.rollingAvg7d * 0.9,
        criticalThreshold: latest.performanceRatio < 0.7
      }
    };
  };

  const generateMockRollingData = (): RollingAverageData[] => {
    const data: RollingAverageData[] = [];
    const now = new Date();
    const baselinePower = 45;

    for (let i = 168; i >= 0; i--) { // Last 7 days
      const timestamp = new Date(now.getTime() - i * 60 * 60 * 1000);
      const hour = timestamp.getHours();
      
      // Solar production curve
      let powerMultiplier = 0;
      if (hour >= 6 && hour <= 18) {
        const hourProgress = (hour - 6) / 12;
        powerMultiplier = Math.sin(hourProgress * Math.PI);
      }

      const actualPower = baselinePower * powerMultiplier * (0.8 + Math.random() * 0.4);
      const expectedPower = baselinePower * powerMultiplier * (0.9 + Math.random() * 0.2);
      
      // Add some performance degradation over time
      const degradationFactor = 1 - (i * 0.001);
      
      data.push({
        period: timestamp.toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit',
          minute: '2-digit'
        }),
        timestamp: timestamp.toISOString(),
        actualPower: actualPower * degradationFactor,
        expectedPower: expectedPower,
        performanceRatio: (actualPower * degradationFactor) / expectedPower,
        rollingAvg24h: actualPower * degradationFactor * 0.95,
        rollingAvg7d: actualPower * degradationFactor * 0.92,
        rollingAvg30d: actualPower * degradationFactor * 0.90
      });
    }

    return data;
  };

  const chartData = data.slice(-48).map(d => ({
    period: d.period,
    actualPower: parseFloat(formatNumber(d.actualPower, 2)),
    expectedPower: parseFloat(formatNumber(d.expectedPower, 2)),
    rollingAvg24h: parseFloat(formatNumber(d.rollingAvg24h, 2)),
    rollingAvg7d: parseFloat(formatNumber(d.rollingAvg7d, 2)),
    performanceRatio: parseFloat(formatNumber(d.performanceRatio * 100, 1))
  }));

  const getSelectedAverageKey = () => {
    switch (selectedPeriod) {
      case '24h': return 'rollingAvg24h';
      case '7d': return 'rollingAvg7d';
      default: return 'rollingAvg24h';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Rolling Average Performance
            </CardTitle>
            <CardDescription>
              {inverterId === 'all' ? 'Plant-wide' : inverterId} performance trends and anomaly detection
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-gray-100 rounded-lg p-1">
              {(['24h', '7d', '30d'] as const).map((period) => (
                <Button
                  key={period}
                  size="sm"
                  variant={selectedPeriod === period ? 'default' : 'ghost'}
                  onClick={() => setSelectedPeriod(period)}
                  className="h-7 text-xs"
                >
                  {period}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchRollingAverageData}
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
            <RefreshCw className="h-6 w-6 animate-spin text-gray-400 mr-2" />
            <span className="text-gray-500">Loading performance data...</span>
          </div>
        ) : (
          <>
            {/* Performance Metrics Summary */}
            {metrics && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-xs text-blue-600 flex items-center gap-1">
                    <Activity className="h-3 w-3" />
                    Current Power
                  </p>
                  <p className="font-semibold text-lg">
                    {formatPower(metrics.current.power * 1000)}
                  </p>
                </div>

                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-xs text-blue-500 flex items-center gap-1">
                    <Target className="h-3 w-3" />
                    Performance Ratio
                  </p>
                  <p className="font-semibold text-lg">
                    {formatPercentage(metrics.current.performanceRatio * 100)}
                  </p>
                </div>

                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-xs text-blue-400">24h Average</p>
                  <p className="font-semibold text-lg">
                    {formatPower(metrics.averages.avg24h * 1000)}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    {metrics.current.trend24h >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-green-500" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-500" />
                    )}
                    <span className={`text-xs ${metrics.current.trend24h >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {formatPercentage(Math.abs(metrics.current.trend24h))}
                    </span>
                  </div>
                </div>

                <div className="bg-blue-50 p-3 rounded-lg">
                  <p className="text-xs text-blue-600">7d Average</p>
                  <p className="font-semibold text-lg">
                    {formatPower(metrics.averages.avg7d * 1000)}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    {metrics.current.trend7d >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-green-500" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-500" />
                    )}
                    <span className={`text-xs ${metrics.current.trend7d >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {formatPercentage(Math.abs(metrics.current.trend7d))}
                    </span>
                  </div>
                </div>

                <div className="bg-gray-50 p-3 rounded-lg">
                  <p className="text-xs text-gray-600">30d Average</p>
                  <p className="font-semibold text-lg">
                    {formatPower(metrics.averages.avg30d * 1000)}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    {metrics.alerts.criticalThreshold && (
                      <Badge variant="destructive" className="text-xs">
                        Critical
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Performance Alerts */}
            {metrics && (metrics.alerts.underperforming24h || metrics.alerts.underperforming7d || metrics.alerts.criticalThreshold) && (
              <div className="mb-4 p-3 bg-blue-50 border border-red-200 rounded-lg">
                <h4 className="font-medium text-red-800 mb-2">Performance Alerts:</h4>
                <div className="space-y-1">
                  {metrics.alerts.criticalThreshold && (
                    <p className="text-sm text-red-700">🚨 Critical: Performance ratio below 70%</p>
                  )}
                  {metrics.alerts.underperforming24h && (
                    <p className="text-sm text-red-700">⚠️ Current power is 10%+ below 24h rolling average</p>
                  )}
                  {metrics.alerts.underperforming7d && (
                    <p className="text-sm text-red-700">📉 Current power is 10%+ below 7d rolling average</p>
                  )}
                </div>
              </div>
            )}

            {/* Rolling Average Chart */}
            <div style={{ height }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis 
                    dataKey="period" 
                    tick={{ fontSize: 12, fill: '#666' }}
                    angle={-45}
                    textAnchor="end"
                    height={80}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    tick={{ fontSize: 12, fill: '#666' }}
                    label={{ value: 'Power (kW)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip 
                    formatter={(value: any, name: string) => [
                      formatPower(value * 1000),
                      name.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())
                    ]}
                    labelFormatter={(label) => `Time: ${label}`}
                  />
                  <Legend />
                  
                  <Line 
                    type="monotone" 
                    dataKey="actualPower" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    name="Actual Power"
                    dot={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="expectedPower" 
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    name="Expected Power"
                    dot={false}
                  />
                  <Line 
                    type="monotone" 
                    dataKey={getSelectedAverageKey()} 
                    stroke="#f59e0b" 
                    strokeWidth={3}
                    name={`${selectedPeriod} Rolling Average`}
                    dot={false}
                  />
                  
                  {/* Alert thresholds */}
                  {metrics && (
                    <>
                      <ReferenceLine 
                        y={metrics.averages[selectedPeriod === '24h' ? 'avg24h' : selectedPeriod === '7d' ? 'avg7d' : 'avg30d'] * 0.9} 
                        stroke="#ef4444" 
                        strokeDasharray="2 2" 
                        label="Alert Threshold (-10%)"
                      />
                      <ReferenceLine 
                        y={metrics.averages[selectedPeriod === '24h' ? 'avg24h' : selectedPeriod === '7d' ? 'avg7d' : 'avg30d'] * 0.7} 
                        stroke="#dc2626" 
                        strokeDasharray="4 4" 
                        label="Critical Threshold (-30%)"
                      />
                    </>
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}