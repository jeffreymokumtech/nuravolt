'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { StringData } from '@/types/mppt';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface StringComparisonChartProps {
  strings: StringData[];
}

export default function StringComparisonChart({ strings }: StringComparisonChartProps) {
  const option = useMemo(() => {
    if (!strings || strings.length === 0) return {};

    const categories = strings.map((s) => s.stringId);
    const faultedSet = new Set(
      strings.filter((s) => s.status === 'open_circuit').map((s) => s.stringId)
    );

    const powerData = strings.map((s) => ({
      value: s.power_kW,
      itemStyle: faultedSet.has(s.stringId)
        ? { color: '#EF4444' }
        : { color: '#3B82F6' },
    }));

    const voltageData = strings.map((s) => ({
      value: s.voltage_V,
      itemStyle: faultedSet.has(s.stringId)
        ? { color: '#EF4444' }
        : { color: '#F59E0B' },
    }));

    const currentData = strings.map((s) => ({
      value: s.current_A,
      itemStyle: faultedSet.has(s.stringId)
        ? { color: '#EF4444' }
        : { color: '#10B981' },
    }));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const stringId = params[0]?.axisValue || '';
          const isFaulted = faultedSet.has(stringId);
          let tooltip = `<strong>${stringId}</strong>`;
          if (isFaulted) {
            tooltip += ' <span style="color:#EF4444">(Open Circuit)</span>';
          }
          tooltip += '<br/>';
          params.forEach((p: any) => {
            if (p.value == null) return;
            const unit = p.seriesName === 'Power' ? ' kW' : p.seriesName === 'Voltage' ? ' V' : ' A';
            tooltip += `${p.marker} ${p.seriesName}: ${p.value}${unit}<br/>`;
          });
          return tooltip;
        },
      },
      legend: {
        data: ['Power', 'Voltage', 'Current'],
        bottom: 0,
        textStyle: { fontSize: 11 },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '15%',
        top: '8%',
        containLabel: true,
      },
      xAxis: {
        type: 'value',
      },
      yAxis: {
        type: 'category',
        data: categories,
        axisLabel: {
          fontSize: 11,
          formatter: (value: string) => {
            if (faultedSet.has(value)) return `{fault|${value}}`;
            return value;
          },
          rich: {
            fault: {
              color: '#EF4444',
              fontWeight: 'bold',
            },
          },
        },
      },
      series: [
        {
          name: 'Power',
          type: 'bar',
          data: powerData,
          barGap: '10%',
          label: {
            show: strings.length <= 4,
            position: 'right',
            fontSize: 10,
            formatter: (p: any) => `${p.value} kW`,
          },
        },
        {
          name: 'Voltage',
          type: 'bar',
          data: voltageData,
          label: {
            show: strings.length <= 4,
            position: 'right',
            fontSize: 10,
            formatter: (p: any) => `${p.value} V`,
          },
        },
        {
          name: 'Current',
          type: 'bar',
          data: currentData,
          label: {
            show: strings.length <= 4,
            position: 'right',
            fontSize: 10,
            formatter: (p: any) => `${p.value} A`,
          },
        },
      ],
    };
  }, [strings]);

  if (!strings || strings.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center h-[300px]">
        <p className="text-gray-500 text-sm">No string data available</p>
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height: 300, width: '100%' }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}
