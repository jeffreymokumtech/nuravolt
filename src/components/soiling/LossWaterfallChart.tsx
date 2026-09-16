'use client';

/**
 * IEA Loss Waterfall Chart
 * Shows loss disaggregation from reference to net energy.
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { InverterSoilingMetrics } from '@/types/soiling';

interface LossWaterfallChartProps {
  inverterData: InverterSoilingMetrics | null;
  loading?: boolean;
  height?: number | string;
}

export function LossWaterfallChart({
  inverterData,
  loading,
  height = 400,
}: LossWaterfallChartProps) {
  const options = useMemo(() => {
    if (!inverterData) return null;

    const { lossDisaggregation } = inverterData;
    const { percentages, energy_kWh } = lossDisaggregation;

    // Calculate loss amounts in kWh
    const refEnergy = energy_kWh.reference;
    const losses = [
      { name: 'Reference', value: refEnergy, isPositive: true },
      { name: 'Soiling', value: -(refEnergy * percentages.soiling / 100), loss: percentages.soiling },
      { name: 'Temperature', value: -(refEnergy * percentages.temperature / 100), loss: percentages.temperature },
      { name: 'Spectral', value: -(refEnergy * percentages.spectral / 100), loss: percentages.spectral },
      { name: 'Inverter', value: -(refEnergy * percentages.inverter / 100), loss: percentages.inverter },
      { name: 'Wiring/BOP', value: -(refEnergy * percentages.wiringBop / 100), loss: percentages.wiringBop },
      { name: 'Degradation', value: -(refEnergy * percentages.degradation / 100), loss: percentages.degradation },
      { name: 'Net Output', value: energy_kWh.net, isPositive: true },
    ];

    // Build waterfall data
    // For waterfall, we need: base (transparent), positive, negative
    let runningTotal = 0;
    const baseData: (number | '-')[] = [];
    const increaseData: (number | '-')[] = [];
    const decreaseData: (number | '-')[] = [];

    losses.forEach((item, index) => {
      if (index === 0) {
        // Reference (first bar)
        baseData.push(0);
        increaseData.push(item.value);
        decreaseData.push('-');
        runningTotal = item.value;
      } else if (index === losses.length - 1) {
        // Net output (last bar)
        baseData.push(0);
        increaseData.push(item.value);
        decreaseData.push('-');
      } else {
        // Loss items
        const lossValue = Math.abs(item.value);
        baseData.push(runningTotal - lossValue);
        increaseData.push('-');
        decreaseData.push(lossValue);
        runningTotal -= lossValue;
      }
    });

    return {
      title: {
        text: 'IEA Loss Disaggregation',
        subtext: inverterData.inverterId,
        left: 'center',
        textStyle: {
          fontSize: 14,
        },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'shadow',
        },
        formatter: (params: any) => {
          const item = losses[params[0].dataIndex];
          if (item.isPositive) {
            return `${item.name}: ${Math.abs(item.value).toFixed(0)} kWh`;
          }
          return `${item.name}: -${Math.abs(item.value).toFixed(0)} kWh (${item.loss?.toFixed(1)}%)`;
        },
      },
      grid: {
        left: '10%',
        right: '5%',
        bottom: '15%',
        top: '20%',
      },
      xAxis: {
        type: 'category',
        data: losses.map((l) => l.name),
        axisLabel: {
          rotate: 45,
          interval: 0,
        },
      },
      yAxis: {
        type: 'value',
        name: 'Energy (kWh)',
        axisLabel: {
          formatter: (val: number) => (val / 1000).toFixed(1) + 'k',
        },
      },
      series: [
        // Base (transparent)
        {
          name: 'Base',
          type: 'bar',
          stack: 'waterfall',
          itemStyle: {
            borderColor: 'transparent',
            color: 'transparent',
          },
          emphasis: {
            itemStyle: {
              borderColor: 'transparent',
              color: 'transparent',
            },
          },
          data: baseData,
        },
        // Increase (reference & net output)
        {
          name: 'Energy',
          type: 'bar',
          stack: 'waterfall',
          itemStyle: {
            color: '#10B981', // green
          },
          label: {
            show: true,
            position: 'top',
            formatter: (params: any) => {
              const val = params.value;
              if (val === '-' || val === 0) return '';
              return (val / 1000).toFixed(1) + 'k';
            },
          },
          data: increaseData,
        },
        // Decrease (losses)
        {
          name: 'Loss',
          type: 'bar',
          stack: 'waterfall',
          itemStyle: {
            color: '#EF4444', // red for soiling
          },
          label: {
            show: true,
            position: 'bottom',
            formatter: (params: any) => {
              const val = params.value;
              if (val === '-' || val === 0) return '';
              const lossItem = losses[params.dataIndex];
              return `-${lossItem.loss?.toFixed(1)}%`;
            },
          },
          data: decreaseData,
        },
      ],
    };
  }, [inverterData]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center bg-base-200 animate-pulse rounded-lg"
        style={{ height }}
      >
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!inverterData || !options) {
    return (
      <div
        className="flex items-center justify-center bg-base-200 rounded-lg"
        style={{ height }}
      >
        <span className="text-base-content/50">Select an inverter to view loss breakdown</span>
      </div>
    );
  }

  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-2">
        <ReactECharts
          option={options}
          style={{ height, width: '100%' }}
          notMerge={true}
          lazyUpdate={true}
        />
      </div>
    </div>
  );
}

export default LossWaterfallChart;
