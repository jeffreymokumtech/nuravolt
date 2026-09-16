'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { StringTimeseriesPoint } from '@/types/mppt';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface StringTimelineChartProps {
  data: StringTimeseriesPoint[];
  metric: 'voltage' | 'current';
}

export default function StringTimelineChart({ data, metric }: StringTimelineChartProps) {
  const option = useMemo(() => {
    if (!data || data.length === 0) return {};

    const sorted = [...data].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const timestamps = sorted.map((p) => {
      const d = new Date(p.timestamp);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }) + ' ' + d.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    });

    const isVoltage = metric === 'voltage';
    const values = sorted.map((p) => (isVoltage ? p.voltage_V : p.current_A));
    const unit = isVoltage ? 'V' : 'A';
    const label = isVoltage ? 'Voltage' : 'Current';
    const color = isVoltage ? '#f59e0b' : '#10b981';
    const areaTop = isVoltage ? 'rgba(245, 158, 11, 0.25)' : 'rgba(16, 185, 129, 0.25)';
    const areaBottom = isVoltage ? 'rgba(245, 158, 11, 0.03)' : 'rgba(16, 185, 129, 0.03)';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const p = params[0];
          return `<strong>${p.name}</strong><br/>${p.marker} ${label}: ${p.value} ${unit}`;
        },
      },
      grid: {
        left: 55,
        right: 20,
        top: 15,
        bottom: 70,
      },
      xAxis: {
        type: 'category',
        data: timestamps,
        axisLabel: {
          rotate: 40,
          color: '#6b7280',
          fontSize: 10,
          interval: Math.max(0, Math.floor(timestamps.length / 10) - 1),
        },
        axisLine: { lineStyle: { color: '#e5e7eb' } },
      },
      yAxis: {
        type: 'value',
        name: `${label} (${unit})`,
        nameTextStyle: { color: '#6b7280', fontSize: 11 },
        axisLabel: { color: '#6b7280', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        {
          type: 'slider',
          start: 0,
          end: 100,
          bottom: 8,
          height: 22,
          textStyle: { color: '#6b7280', fontSize: 10 },
          borderColor: '#e5e7eb',
          fillerColor: `${color}22`,
          handleStyle: { color, borderColor: color },
          backgroundColor: '#f9fafb',
        },
      ],
      series: [
        {
          name: label,
          type: 'line',
          data: values,
          smooth: true,
          symbol: 'none',
          lineStyle: { color, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: areaTop },
                { offset: 1, color: areaBottom },
              ],
            },
          },
        },
      ],
    };
  }, [data, metric]);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-gray-400 text-sm">
        No timeseries data available
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height: 280, width: '100%' }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}
