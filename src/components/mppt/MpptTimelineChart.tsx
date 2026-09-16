'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { MpptTimeseriesPoint } from '@/types/mppt';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface MpptTimelineChartProps {
  data: MpptTimeseriesPoint[];
  mpptId: string;
}

export default function MpptTimelineChart({ data, mpptId }: MpptTimelineChartProps) {
  const option = useMemo(() => {
    if (!data || data.length === 0) return {};

    const timestamps = data.map((d) => d.timestamp);
    const voltageValues = data.map((d) => d.voltage_V);
    const currentValues = data.map((d) => d.current_A);

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const ts = params[0]?.axisValue || '';
          let tooltip = `<strong>${ts}</strong><br/>`;
          params.forEach((p: any) => {
            if (p.value == null) return;
            const unit = p.seriesName === 'Voltage' ? ' V' : ' A';
            tooltip += `${p.marker} ${p.seriesName}: ${p.value}${unit}<br/>`;
          });
          // Show power from the original data if available
          const idx = params[0]?.dataIndex;
          if (idx != null && data[idx]) {
            tooltip += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#8B5CF6;margin-right:4px"></span> Power: ${data[idx].power_kW} kW<br/>`;
          }
          return tooltip;
        },
      },
      legend: {
        data: ['Voltage', 'Current'],
        bottom: 30,
        textStyle: { fontSize: 11 },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '20%',
        top: '10%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: timestamps,
        axisLabel: {
          rotate: 30,
          fontSize: 10,
          formatter: (value: string) => {
            // Show shortened timestamp if it looks like ISO
            if (value.includes('T')) {
              return value.split('T')[1]?.substring(0, 5) || value;
            }
            return value;
          },
        },
        boundaryGap: false,
      },
      yAxis: [
        {
          type: 'value',
          name: 'Voltage (V)',
          nameTextStyle: { color: '#3B82F6', fontSize: 11 },
          axisLabel: {
            formatter: '{value} V',
            fontSize: 10,
            color: '#3B82F6',
          },
          splitLine: {
            lineStyle: { type: 'dashed', color: '#E5E7EB' },
          },
        },
        {
          type: 'value',
          name: 'Current (A)',
          nameTextStyle: { color: '#10B981', fontSize: 11 },
          axisLabel: {
            formatter: '{value} A',
            fontSize: 10,
            color: '#10B981',
          },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        {
          type: 'slider',
          bottom: 5,
          height: 20,
          borderColor: '#D1D5DB',
          fillerColor: 'rgba(59, 130, 246, 0.15)',
          handleStyle: { color: '#3B82F6' },
        },
      ],
      series: [
        {
          name: 'Voltage',
          type: 'line',
          data: voltageValues,
          yAxisIndex: 0,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#3B82F6', width: 2 },
          itemStyle: { color: '#3B82F6' },
        },
        {
          name: 'Current',
          type: 'line',
          data: currentValues,
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#10B981', width: 2 },
          itemStyle: { color: '#10B981' },
        },
      ],
    };
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center h-[400px]">
        <p className="text-gray-500 text-sm">No timeseries data for {mpptId}</p>
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height: 400, width: '100%' }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}
