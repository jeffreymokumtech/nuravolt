'use client';

import { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Info, AlertCircle } from 'lucide-react';
import type { Fault, ReactiveFault, PredictiveFault } from '@/types/faults';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

// Fault category configuration for dynamic chart labels and timelines
type FaultCategory = 'performance' | 'thermal' | 'electrical' | 'availability' | 'grid' | 'tracker' | 'predictive' | 'digital_twin';

interface FaultCategoryConfig {
  category: FaultCategory;
  chartTitle: string;
  primaryMetric: { label: string; unit: string };
  secondaryMetric?: { label: string; unit: string };
  timelineDays: number;
  thresholdType: 'upper' | 'lower' | 'range';
  color: string;
  description: string;
}

const FAULT_CATEGORY_CONFIG: Record<FaultCategory, FaultCategoryConfig> = {
  performance: {
    category: 'performance',
    chartTitle: 'PR Deviation Trend',
    primaryMetric: { label: 'PR Deviation', unit: '%' },
    secondaryMetric: { label: 'Power Loss', unit: 'kW' },
    timelineDays: 30,
    thresholdType: 'lower',
    color: '#f59e0b',
    description: 'Performance ratio deviation from expected clean baseline',
  },
  thermal: {
    category: 'thermal',
    chartTitle: 'Temperature Trend',
    primaryMetric: { label: 'Temperature', unit: '°C' },
    secondaryMetric: { label: 'Power Loss', unit: 'kW' },
    timelineDays: 7,
    thresholdType: 'upper',
    color: '#ef4444',
    description: 'Equipment temperature trending toward operational limits',
  },
  electrical: {
    category: 'electrical',
    chartTitle: 'DC Voltage Trend',
    primaryMetric: { label: 'DC Voltage', unit: 'V' },
    secondaryMetric: { label: 'Power Loss', unit: 'kW' },
    timelineDays: 14,
    thresholdType: 'range',
    color: '#8b5cf6',
    description: 'Electrical parameter deviation from normal operating range',
  },
  availability: {
    category: 'availability',
    chartTitle: 'Availability Trend',
    primaryMetric: { label: 'Availability', unit: '%' },
    secondaryMetric: { label: 'Power Loss', unit: 'kW' },
    timelineDays: 7,
    thresholdType: 'lower',
    color: '#6b7280',
    description: 'Equipment availability and communication status',
  },
  grid: {
    category: 'grid',
    chartTitle: 'Power Output Trend',
    primaryMetric: { label: 'Power Output', unit: 'kW' },
    secondaryMetric: { label: 'Setpoint', unit: 'kW' },
    timelineDays: 7,
    thresholdType: 'upper',
    color: '#3b82f6',
    description: 'Grid-related constraints affecting power output',
  },
  tracker: {
    category: 'tracker',
    chartTitle: 'Tracking Angle Trend',
    primaryMetric: { label: 'Tracking Angle', unit: '°' },
    secondaryMetric: { label: 'Expected Angle', unit: '°' },
    timelineDays: 3,
    thresholdType: 'range',
    color: '#10b981',
    description: 'Solar tracker positioning and alignment',
  },
  predictive: {
    category: 'predictive',
    chartTitle: 'Remaining Useful Life',
    primaryMetric: { label: 'Days to Failure', unit: 'days' },
    secondaryMetric: { label: 'Confidence', unit: '%' },
    timelineDays: 90,
    thresholdType: 'lower',
    color: '#ec4899',
    description: 'Predicted equipment failure timeline based on degradation trends',
  },
  digital_twin: {
    category: 'digital_twin',
    chartTitle: 'Actual vs Expected Power',
    primaryMetric: { label: 'Power Loss', unit: 'kW' },
    secondaryMetric: { label: 'Expected Power', unit: 'kW' },
    timelineDays: 30,
    thresholdType: 'lower',
    color: '#d946ef',
    description: 'Digital twin detected power output significantly below physics-based expectation. No specific fault rule matched, requires field investigation.',
  },
};

// Map fault types to categories
function getFaultCategory(faultType: string): FaultCategory {
  const ft = faultType.toLowerCase();

  // Thermal faults
  if (ft.includes('thermal') || ft.includes('temperature') || ft.includes('overtemperature') || ft.includes('cooling') || ft.includes('hotspot')) {
    return 'thermal';
  }
  // Electrical/DC faults
  if (ft.includes('dc_') || ft.includes('string_open') || ft.includes('string_mismatch') || ft.includes('mppt') || ft.includes('overvoltage') || ft.includes('undervoltage') || ft.includes('voltage')) {
    return 'electrical';
  }
  // Availability/Communication faults
  if (ft.includes('communication') || ft.includes('offline') || ft.includes('partial')) {
    return 'availability';
  }
  // Grid/Curtailment faults
  if (ft.includes('grid') || ft.includes('curtailment') || ft.includes('clipping') || ft.includes('export') || ft.includes('frequency')) {
    return 'grid';
  }
  // Tracker faults
  if (ft.includes('tracker') || ft.includes('stuck') || ft.includes('misaligned')) {
    return 'tracker';
  }
  // Digital twin residual (unclassified)
  if (ft.includes('unclassified')) {
    return 'digital_twin';
  }
  // Predictive faults (RUL)
  if (ft.includes('rul_') || ft.includes('predicted') || ft.includes('remaining_useful_life')) {
    return 'predictive';
  }
  // Default: Performance (soiling, degradation, underperformance)
  return 'performance';
}

interface FaultDataTrackProps {
  fault: Fault;
  plantId: string;
  height?: number;
  daysBack?: number;
}

interface SensorDataPoint {
  timestamp: string;
  value: number;
}

interface SensorHistoryData {
  equipment_id: string;
  fault_type: string;
  sensor_type: string;
  unit: string;
  data: SensorDataPoint[];
  threshold: number;
  metadata: {
    min: number;
    max: number;
    mean: number;
    count: number;
  };
}

// Type guards
function isReactiveFault(fault: Fault): fault is ReactiveFault {
  return 'severity' in fault && 'duration_minutes' in fault;
}


/**
 * Get unit and label based on fault category (fallback when API data unavailable)
 */
function getMetricInfo(fault: Fault): { label: string; unit: string; category: FaultCategory } {
  const category = getFaultCategory(fault.fault_type);
  const config = FAULT_CATEGORY_CONFIG[category];
  return {
    label: config.primaryMetric.label,
    unit: config.primaryMetric.unit,
    category,
  };
}

/**
 * Get explanatory note based on fault category
 */
function getDataNote(faultType: string): string | null {
  const category = getFaultCategory(faultType);
  return FAULT_CATEGORY_CONFIG[category].description;
}

export default function FaultDataTrack({ fault, plantId, height = 250, daysBack = 30 }: FaultDataTrackProps) {
  const [sensorData, setSensorData] = useState<SensorHistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isReactive = isReactiveFault(fault);

  // Extract equipment ID from fault
  const equipmentId = isReactive
    ? (fault as ReactiveFault).equipment_id
    : (fault as PredictiveFault).equipment_id;

  // Fetch real sensor data from API
  useEffect(() => {
    const fetchSensorData = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(
          `/api/faults/sensor-history?plantId=${encodeURIComponent(plantId)}&equipmentId=${encodeURIComponent(equipmentId)}&faultType=${encodeURIComponent(fault.fault_type)}&daysBack=${daysBack}`
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(errorData.error || `Failed to fetch sensor data: ${response.statusText}`);
        }

        const data: SensorHistoryData = await response.json();
        setSensorData(data);
      } catch (err) {
        console.error('Error fetching sensor data:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        // NO FALLBACK to simulated data - only show real data
      } finally {
        setLoading(false);
      }
    };

    fetchSensorData();
  }, [fault, plantId, equipmentId, daysBack]);

  // Get metric info and category config for display
  const { metricInfo, categoryConfig } = useMemo(() => {
    const category = getFaultCategory(fault.fault_type);
    const config = FAULT_CATEGORY_CONFIG[category];

    if (sensorData) {
      return {
        metricInfo: {
          label: sensorData.sensor_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          unit: sensorData.unit,
          category,
        },
        categoryConfig: config,
      };
    }
    return {
      metricInfo: getMetricInfo(fault),
      categoryConfig: config,
    };
  }, [sensorData, fault]);

  const chartOptions = useMemo(() => {
    // Only render chart with real data - no fallback to simulated data
    if (!sensorData) {
      return null;
    }

    const timestamps = sensorData.data.map(d =>
      new Date(d.timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    );
    const values = sensorData.data.map(d => d.value);
    const thresholdLine = sensorData.data.map(() => sensorData.threshold);

    // Find fault index (closest timestamp to fault occurrence)
    const faultTime = isReactive
      ? new Date(fault.timestamp_start)
      : new Date((fault as PredictiveFault).estimated_date);

    let faultIndex = 0;
    let minDiff = Infinity;
    sensorData.data.forEach((point, idx) => {
      const diff = Math.abs(new Date(point.timestamp).getTime() - faultTime.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        faultIndex = idx;
      }
    });

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || params.length === 0) return '';
          const time = params[0].name;
          let result = `<strong>${time}</strong><br/>`;
          params.forEach((p: any) => {
            if (p.value !== null && p.seriesName !== 'Threshold') {
              result += `${p.marker} ${p.seriesName}: ${p.value?.toFixed(2)} ${metricInfo.unit}<br/>`;
            }
          });
          result += `<span style="color: #ef4444;">Threshold: ${sensorData.threshold} ${metricInfo.unit}</span>`;
          return result;
        },
      },
      legend: {
        data: [metricInfo.label, 'Threshold'],
        top: 0,
        textStyle: { fontSize: 11, color: '#6b7280' },
      },
      grid: {
        left: 60,
        right: 20,
        top: 40,
        bottom: 80,
      },
      xAxis: {
        type: 'category',
        data: timestamps,
        axisLabel: {
          rotate: 45,
          fontSize: 10,
          color: '#6b7280',
          interval: Math.floor(timestamps.length / 10),
        },
        axisLine: { lineStyle: { color: '#e5e7eb' } },
      },
      yAxis: {
        type: 'value',
        name: metricInfo.unit ? `${metricInfo.label} (${metricInfo.unit})` : metricInfo.label,
        nameTextStyle: { fontSize: 11, color: '#6b7280' },
        axisLabel: { fontSize: 10, color: '#6b7280' },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      // Ensure legend dots match the actual line colours.
      color: [categoryConfig.color, '#ef4444'],
      series: [
        {
          name: metricInfo.label,
          type: 'line',
          data: values,
          smooth: true,
          symbol: 'none',
          itemStyle: { color: categoryConfig.color },
          lineStyle: { color: categoryConfig.color, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${categoryConfig.color}4D` }, // 30% opacity
                { offset: 1, color: `${categoryConfig.color}0D` }, // 5% opacity
              ],
            },
          },
          markPoint: {
            data: [
              {
                name: 'Fault',
                coord: [timestamps[faultIndex], values[faultIndex]],
                symbol: 'pin',
                symbolSize: 40,
                itemStyle: { color: '#ef4444' },
                label: { show: true, formatter: 'Fault', color: '#fff', fontSize: 10 },
              }
            ],
          },
        },
        {
          name: 'Threshold',
          type: 'line',
          data: thresholdLine,
          symbol: 'none',
          itemStyle: { color: '#ef4444' },
          lineStyle: {
            color: '#ef4444',
            width: 2,
            type: 'dashed',
          },
        },
      ],
    };
  }, [fault, sensorData, metricInfo, categoryConfig, isReactive]);

  return (
    <div className="bg-paper rounded-lg border border-divider p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: categoryConfig.color }}
          />
          <h4 className="text-sm font-semibold text-ink-2">{categoryConfig.chartTitle}</h4>
        </div>
        <span className="text-xs text-ink-3">
          {sensorData ? `${categoryConfig.timelineDays}-day trend` : 'Real sensor data only'}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="flex flex-col items-center gap-2">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span className="text-xs text-ink-3">Loading sensor data...</span>
          </div>
        </div>
      ) : !sensorData ? (
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="flex flex-col items-center gap-2 text-center">
            <svg className="w-12 h-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span className="text-sm text-ink-3 font-medium">No Sensor Data Available</span>
            <span className="text-xs text-ink-3 max-w-xs">
              Real-time sensor history will be displayed here when data is available for this equipment.
            </span>
          </div>
        </div>
      ) : (
        <>
          <ReactECharts
            option={chartOptions}
            style={{ height, width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />

          {/* Metadata display for real data */}
          {sensorData && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-divider">
              <div className="flex items-center gap-4 text-xs text-ink-2">
                <div>
                  <span className="font-semibold">Min:</span> {sensorData.metadata.min.toFixed(2)} {sensorData.unit}
                </div>
                <div>
                  <span className="font-semibold">Mean:</span> {sensorData.metadata.mean.toFixed(2)} {sensorData.unit}
                </div>
                <div>
                  <span className="font-semibold">Max:</span> {sensorData.metadata.max.toFixed(2)} {sensorData.unit}
                </div>
                <div>
                  <span className="font-semibold">Data Points:</span> {sensorData.metadata.count.toLocaleString()}
                </div>
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center justify-center gap-4 mt-2 text-xs text-ink-3">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 rounded" style={{ backgroundColor: categoryConfig.color }}></div>
              <span>{metricInfo.label}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-red-500 rounded" style={{ borderStyle: 'dashed' }}></div>
              <span>Threshold</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-signal-critical/10 rounded"></div>
              <span>Fault Period</span>
            </div>
          </div>

                {/* Data explanation note for certain fault types */}
                {getDataNote(fault.fault_type) && (
                  <div className="mt-2 text-xs text-blue-700 bg-blue-50 px-3 py-2 rounded border border-blue-200 flex items-start gap-2">
                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <p><strong>Data:</strong> {getDataNote(fault.fault_type)}</p>
                  </div>
                )}
          
                {/* Error message when no real data available */}
                {error && (
                  <div className="mt-2 text-xs text-signal-warning bg-signal-warning/10 px-3 py-2 rounded border border-signal-warning/20 flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <p><strong>Note:</strong> Could not load sensor data ({error}).</p>
                  </div>
                )}        </>
      )}
    </div>
  );
}
