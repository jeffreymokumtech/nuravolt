'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface TimelineData {
  dates: string[];
  inverters: string[];
  // Shape: data[dateIdx][inverterIdx]
  data: (number | null)[][];
  metadata: {
    aggregation: string;
    total_inverters: number;
    total_dates: number;
    date_range?: {
      start: string;
      end: string;
    };
  };
}

interface TimelineHeatmapResponse {
  daily: TimelineData;
  weekly: TimelineData;
}

interface CompactHeatmapProps {
  plantId: string;
  daysToShow?: number;
  height?: number;
}

type TimelineAggregation = 'daily' | 'weekly';
type AggregationMode = 'mean' | 'max' | 'median';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function weekStartMonday(dateStr: string): string {
  // Input dates are YYYY-MM-DD from generated dashboard JSON.
  // Normalize to Monday week start (UTC) for consistent grouping.
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7; // Mon->0, Tue->1, Sun->6
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

function aggregateWeeklyFromDaily(daily: TimelineData, mode: AggregationMode): TimelineData {
  const weekKeys: string[] = [];
  const weekIndexByKey = new Map<string, number>();
  const datesToWeekIdx: number[] = [];

  daily.dates.forEach((dateStr) => {
    const wk = weekStartMonday(dateStr);
    let idx = weekIndexByKey.get(wk);
    if (idx === undefined) {
      idx = weekKeys.length;
      weekKeys.push(wk);
      weekIndexByKey.set(wk, idx);
    }
    datesToWeekIdx.push(idx);
  });

  const weekCount = weekKeys.length;
  const inverterCount = daily.inverters.length;

  const weeklyMatrix: (number | null)[][] = [];
  for (let wkIdx = 0; wkIdx < weekCount; wkIdx++) {
    weeklyMatrix.push(new Array(inverterCount).fill(null));
  }

  for (let inverterIdx = 0; inverterIdx < inverterCount; inverterIdx++) {
    const buckets: number[][] = [];
    for (let wkIdx = 0; wkIdx < weekCount; wkIdx++) buckets.push([]);
    for (let dateIdx = 0; dateIdx < daily.dates.length; dateIdx++) {
      const v = daily.data?.[dateIdx]?.[inverterIdx];
      if (v === null || v === undefined) continue;
      buckets[datesToWeekIdx[dateIdx]].push(v);
    }

    for (let wkIdx = 0; wkIdx < weekCount; wkIdx++) {
      const values = buckets[wkIdx];
      if (values.length === 0) continue;
      let agg: number;
      if (mode === 'max') agg = Math.max(...values);
      else if (mode === 'median') agg = median(values);
      else agg = values.reduce((s, x) => s + x, 0) / values.length;
      weeklyMatrix[wkIdx][inverterIdx] = Math.round(agg * 100) / 100;
    }
  }

  return {
    dates: weekKeys,
    inverters: daily.inverters,
    data: weeklyMatrix,
    metadata: {
      ...daily.metadata,
      aggregation: 'weekly',
      total_dates: weekKeys.length,
      date_range: { start: weekKeys[0], end: weekKeys[weekKeys.length - 1] },
    },
  };
}

export default function CompactHeatmap({ plantId, daysToShow = 30, height = 360 }: CompactHeatmapProps) {
  const [loading, setLoading] = useState(true);
  const [timelineData, setTimelineData] = useState<TimelineHeatmapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timelineAggregation, setTimelineAggregation] = useState<TimelineAggregation>('daily');
  const [aggregationMode, setAggregationMode] = useState<AggregationMode>('mean');
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`${dataRoot}/digitaltwin/${plantId}/timeline_heatmap_data.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load heatmap data');
        return res.json();
      })
      .then((data) => {
        setTimelineData(data as TimelineHeatmapResponse);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [plantId]);

  // Process data for last N days
  const chartData = useMemo(() => {
    if (!timelineData) return null;

    const source =
      timelineAggregation === 'weekly'
        ? aggregateWeeklyFromDaily(timelineData.daily, aggregationMode)
        : timelineData.daily;

    const { dates, inverters, data } = source;
    if (!dates || !inverters || !data) return null;

    // Data shape: data[dateIdx][inverterIdx] (matches HeatmapSection + generated JSON)
    // Overview view: show full history by default (daysToShow <= 0), otherwise keep last N days/weeks.
    const periodsToShow =
      !daysToShow || daysToShow <= 0
        ? null
        : (timelineAggregation === 'weekly' ? Math.max(1, Math.ceil(daysToShow / 7)) : daysToShow);
    const startDateIdx = periodsToShow === null ? 0 : Math.max(0, dates.length - periodsToShow);
    const recentDates = dates.slice(startDateIdx);
    const recentDataByDate = data.slice(startDateIdx);

    const maxInverters = 80;
    const inverterStep = Math.max(1, Math.ceil(inverters.length / maxInverters));
    const sampledInverters: string[] = [];
    const sampledInverterIdxs: number[] = [];

    for (let inverterIdx = 0; inverterIdx < inverters.length; inverterIdx += inverterStep) {
      sampledInverters.push(inverters[inverterIdx]);
      sampledInverterIdxs.push(inverterIdx);
    }

    // Re-shape to data[inverterIdx][dateIdx] for ECharts heatmap series construction below
    const sampledData: (number | null)[][] = sampledInverterIdxs.map((inverterIdx) =>
      recentDataByDate.map((row) => row?.[inverterIdx] ?? null)
    );

    return {
      dates: recentDates,
      inverters: sampledInverters,
      data: sampledData,
    };
  }, [timelineData, daysToShow, timelineAggregation, aggregationMode]);

  const dataRange = useMemo(() => {
    const source = timelineData?.daily;
    if (!source?.dates?.length) return null;
    return { start: source.dates[0], end: source.dates[source.dates.length - 1] };
  }, [timelineData]);

  const staleInfo = useMemo(() => {
    if (!dataRange?.end) return null;
    const end = new Date(`${dataRange.end}T00:00:00Z`).getTime();
    if (Number.isNaN(end)) return null;
    const daysOld = Math.floor((Date.now() - end) / (1000 * 60 * 60 * 24));
    if (daysOld <= 14) return null;
    return { daysOld };
  }, [dataRange]);

  // Calculate summary stats
  const stats = useMemo(() => {
    if (!chartData) return null;

    let totalLoss = 0;
    let count = 0;
    let highLossCount = 0;
    let criticalCount = 0;

    chartData.data.forEach((row) => {
      row.forEach((value) => {
        if (value !== null && value >= 0) {
          totalLoss += value;
          count++;
          if (value > 15) highLossCount++;
          if (value > 20) criticalCount++;
        }
      });
    });

    return {
      avgLoss: count > 0 ? totalLoss / count : 0,
      highLossPercent: count > 0 ? (highLossCount / count) * 100 : 0,
      criticalCount,
    };
  }, [chartData]);

  // Build ECharts option
  const chartOption = useMemo(() => {
    if (!chartData) return {};

    // Flatten data for ECharts
    const heatmapData: [number, number, number | null][] = [];
    chartData.data.forEach((row, invIdx) => {
      row.forEach((value, dateIdx) => {
        heatmapData.push([dateIdx, invIdx, value]);
      });
    });

    // Format dates for x-axis
    const formatDate = (dateStr: string) => {
      const d = new Date(dateStr);
      if (timelineAggregation === 'weekly') {
        return `Wk ${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
      }
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    return {
      backgroundColor: 'transparent',
      tooltip: {
        position: 'top',
        formatter: (params: any) => {
          if (!params.value || params.value[2] === null) return '';
          const date = chartData.dates[params.value[0]];
          const inv = chartData.inverters[params.value[1]];
          const loss = params.value[2];
          return `<strong>${inv}</strong><br/>${date}<br/>Power Loss: ${loss.toFixed(1)}%`;
        },
      },
      grid: {
        left: 70,
        right: 50,
        top: 10,
        bottom: 70,
        containLabel: false,
      },
      xAxis: {
        type: 'category',
        data: chartData.dates.map(formatDate),
        splitArea: { show: false },
        axisLabel: {
          show: true,
          fontSize: 10,
          color: '#9ca3af',
          rotate: 45,
          interval: Math.max(0, Math.floor(chartData.dates.length / 10)),
        },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'category',
        data: chartData.inverters,
        splitArea: { show: false },
        axisLabel: {
          show: true,
          color: '#9ca3af',
          fontSize: 9,
          interval: Math.max(0, Math.floor(chartData.inverters.length / 12)),
        },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      visualMap: {
        show: true,
        min: 0,
        max: 30,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        textStyle: { color: '#6b7280', fontSize: 10 },
        inRange: {
          color: [
            '#10b981', // 0% - Green (normal)
            '#34d399', // 5%
            '#fbbf24', // 10% - Yellow (minor)
            '#f59e0b', // 15%
            '#f97316', // 20% - Orange (major)
            '#ef4444', // 25% - Red (critical)
            '#dc2626', // 30%+
          ],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: heatmapData,
          label: { show: false },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
          },
        },
      ],
      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: 0,
          start: !daysToShow || daysToShow <= 0 ? 0 : Math.max(0, 100 - (timelineAggregation === 'weekly' ? 50 : 35)),
          end: 100,
          bottom: 30,
          height: 18,
          textStyle: { color: '#6b7280' },
        },
        { type: 'inside', xAxisIndex: 0 },
        {
          type: 'slider',
          yAxisIndex: 0,
          start: 0,
          end: 100,
          right: 0,
          width: 14,
          textStyle: { color: '#6b7280' },
        },
        { type: 'inside', yAxisIndex: 0 },
      ],
    };
  }, [chartData, timelineAggregation, daysToShow]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6">
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error || !chartData) {
    return (
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold text-gray-900">Power Loss Heatmap</h3>
        </div>
        <div className="flex items-center justify-center text-gray-500" style={{ height: height - 60 }}>
          No heatmap data available
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Power Loss Heatmap</h3>
          <p className="text-xs text-gray-500">
            {timelineAggregation === 'weekly' ? 'Weekly' : 'Daily'}
            {timelineAggregation === 'weekly' ? ` · ${aggregationMode}` : ' · mean'}
            {' '}· {dataRange ? `${dataRange.start} → ${dataRange.end}` : 'Loading range…'} · {chartData.inverters.length} inverters
          </p>
          {staleInfo && (
            <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              Heatmap data ends {staleInfo.daysOld} days ago. If SCADA has newer data, re-run the digital twin/onboarding to regenerate `timeline_heatmap_data.json`.
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-lg p-1">
            <button
              type="button"
              onClick={() => {
                setTimelineAggregation('daily');
                setAggregationMode('mean');
              }}
              className={`px-2 py-1 text-xs rounded-md ${
                timelineAggregation === 'daily'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Daily
            </button>
            <button
              type="button"
              onClick={() => setTimelineAggregation('weekly')}
              className={`px-2 py-1 text-xs rounded-md ${
                timelineAggregation === 'weekly'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Weekly
            </button>
          </div>

          <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setAggregationMode('mean')}
              className={`px-2 py-1 text-xs rounded-md ${
                aggregationMode === 'mean'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
              title={timelineAggregation === 'daily' ? 'Daily values are shown as mean' : 'Weekly mean'}
            >
              Mean
            </button>
            <button
              type="button"
              disabled={timelineAggregation === 'daily'}
              onClick={() => setAggregationMode('max')}
              className={`px-2 py-1 text-xs rounded-md ${
                aggregationMode === 'max'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
              } ${timelineAggregation === 'daily' ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={timelineAggregation === 'daily' ? 'Aggregation applies to weekly rollup' : 'Weekly max'}
            >
              Max
            </button>
            <button
              type="button"
              disabled={timelineAggregation === 'daily'}
              onClick={() => setAggregationMode('median')}
              className={`px-2 py-1 text-xs rounded-md ${
                aggregationMode === 'median'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
              } ${timelineAggregation === 'daily' ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={timelineAggregation === 'daily' ? 'Aggregation applies to weekly rollup' : 'Weekly median'}
            >
              Median
            </button>
          </div>

          {stats && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">
                Avg: <span className={stats.avgLoss > 10 ? 'text-amber-600 font-medium' : 'text-emerald-600 font-medium'}>
                  {stats.avgLoss.toFixed(1)}%
                </span>
              </span>
              {stats.criticalCount > 0 && (
                <span className="text-red-600">
                  {stats.criticalCount} critical
                </span>
              )}
            </div>
          )}
          <Link
            href={`${prefix}/plant/${plantId}/faults#heatmap`}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Full view →
          </Link>
        </div>
      </div>

      <ReactECharts
        option={chartOption}
        style={{ height: height - 60, width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />

      {/* Color legend */}
      <div className="flex items-center justify-center gap-4 mt-1 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-emerald-500"></div>
          <span>0-10%</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-amber-500"></div>
          <span>10-15%</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-orange-500"></div>
          <span>15-20%</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-red-500"></div>
          <span>&gt;20%</span>
        </div>
      </div>
    </div>
  );
}
