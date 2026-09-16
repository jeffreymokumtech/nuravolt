'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { DispatchSchedule, DispatchSlot } from '@/types/bess';
import { formatCurrency } from '@/types/bess';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface DispatchScheduleChartProps {
  schedule: DispatchSchedule | null;
  slots: DispatchSlot[];
  nominalCapacityKwh?: number;
  maxWarrantyCycles?: number | null;
  loading?: boolean;
  height?: number;
}

export default function DispatchScheduleChart({
  schedule,
  slots,
  nominalCapacityKwh,
  maxWarrantyCycles,
  loading,
  height = 400,
}: DispatchScheduleChartProps) {
  const option = useMemo(() => {
    if (!slots || slots.length === 0) return {};

    const hours = slots.map((s) => `${s.hour}:00`);
    const chargeData = slots.map((s) => (s.action === 'charge' ? -s.chargeKw : 0));
    const dischargeData = slots.map((s) => (s.action === 'discharge' ? s.dischargeKw : 0));
    const socData = slots.map((s) => (s.soc * 100).toFixed(1));
    const priceData = slots.map((s) => s.priceEurMwh);

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          crossStyle: {
            color: '#999',
          },
        },
        formatter: (params: any) => {
          const hour = params[0].axisValue;
          let tooltip = `<strong>${hour}</strong><br/>`;
          params.forEach((param: any) => {
            const value = param.value;
            let unit = '';
            let displayValue = value;
            switch (param.seriesName) {
              case 'Charge':
                unit = 'kW';
                displayValue = Math.abs(value).toFixed(0);
                break;
              case 'Discharge':
                unit = 'kW';
                displayValue = value.toFixed(0);
                break;
              case 'SoC':
                unit = '%';
                break;
              case 'Price':
                unit = ' EUR/MWh';
                displayValue = value.toFixed(0);
                break;
            }
            tooltip += `${param.marker} ${param.seriesName}: ${displayValue}${unit}<br/>`;
          });
          return tooltip;
        },
      },
      legend: {
        data: ['Charge', 'Discharge', 'SoC', 'Price'],
        bottom: 0,
      },
      grid: {
        left: '3%',
        right: '8%',
        bottom: '15%',
        top: '10%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: hours,
        axisPointer: {
          type: 'shadow',
        },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Power (kW)',
          position: 'left',
          axisLabel: {
            formatter: '{value}',
          },
        },
        {
          type: 'value',
          name: 'SoC (%)',
          position: 'right',
          offset: 0,
          min: 0,
          max: 100,
          axisLabel: {
            formatter: '{value}%',
          },
        },
        {
          type: 'value',
          name: 'Price',
          position: 'right',
          offset: 60,
          axisLabel: {
            formatter: '{value}',
          },
        },
      ],
      series: [
        {
          name: 'Charge',
          type: 'bar',
          stack: 'power',
          data: chargeData,
          itemStyle: {
            color: '#3B82F6',
          },
        },
        {
          name: 'Discharge',
          type: 'bar',
          stack: 'power',
          data: dischargeData,
          itemStyle: {
            color: '#10B981',
          },
        },
        {
          name: 'SoC',
          type: 'line',
          yAxisIndex: 1,
          data: socData,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: {
            color: '#8B5CF6',
            width: 2,
          },
          itemStyle: {
            color: '#8B5CF6',
          },
        },
        {
          name: 'Price',
          type: 'line',
          yAxisIndex: 2,
          data: priceData,
          smooth: true,
          symbol: 'none',
          itemStyle: { color: '#F59E0B' },
          lineStyle: {
            color: '#F59E0B',
            width: 1,
            type: 'dashed',
          },
        },
      ],
    };
  }, [slots]);

  if (loading) {
    return (
      <div
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
        style={{ height }}
      >
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="h-full bg-gray-100 rounded" style={{ height: height - 100 }} />
        </div>
      </div>
    );
  }

  if (!schedule || slots.length === 0) {
    return (
      <div
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center"
        style={{ height }}
      >
        <p className="text-gray-500">No dispatch schedule available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">24-Hour Dispatch Schedule</h3>
          <p className="text-sm text-gray-500">
            {schedule.scheduleDate} | Optimizer: {schedule.optimizerType}
          </p>
          {(schedule.warrantyConstrained || schedule.maxCyclesConstrained) && (
            <span
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
              title="The optimizer limited this schedule to protect the warranty budget — revenue was deliberately left on the table to preserve battery life."
            >
              Warranty-constrained dispatch
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="px-3 py-1.5 bg-green-50 rounded-lg border border-green-200">
            <span className="text-xs text-green-600">Net Revenue</span>
            <p className="text-lg font-bold text-green-700">
              {formatCurrency(schedule.netRevenueEur)}
            </p>
          </div>
          <div className="px-3 py-1.5 bg-blue-50 rounded-lg border border-blue-200">
            <span className="text-xs text-blue-600">Cycles</span>
            <p className="text-lg font-bold text-blue-700">
              {schedule.expectedCycles.toFixed(2)}
            </p>
          </div>
        </div>
      </div>

      <ReactECharts
        option={option}
        style={{ height: height - 100, width: '100%' }}
        notMerge={true}
        lazyUpdate={true}
      />

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-200">
        <div className="text-center">
          <p className="text-sm text-gray-500">Expected Revenue</p>
          <p className="text-lg font-semibold text-gray-900">
            {formatCurrency(schedule.expectedRevenueEur)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-sm text-gray-500">Degradation Cost</p>
          <p className="text-lg font-semibold text-red-600">
            -{formatCurrency(schedule.degradationCostEur)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-sm text-gray-500">Net Revenue</p>
          <p className="text-lg font-semibold text-green-600">
            {formatCurrency(schedule.netRevenueEur)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-sm text-gray-500">Status</p>
          <p
            className={`text-lg font-semibold ${
              schedule.status === 'optimal' ? 'text-green-600' : 'text-amber-600'
            }`}
          >
            {schedule.status}
          </p>
        </div>
      </div>

      {/* Degradation Economics */}
      {nominalCapacityKwh && schedule.degradationCostEur > 0 && schedule.expectedCycles > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-3 pt-3 border-t border-gray-100">
          <div className="text-center">
            <p className="text-xs text-gray-400">Cost per Cycle</p>
            <p className="text-sm font-semibold text-gray-700">
              {formatCurrency(schedule.degradationCostEur / schedule.expectedCycles)}/cycle
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-400">Min Profitable Spread</p>
            <p className="text-sm font-semibold text-gray-700">
              {((schedule.degradationCostEur / schedule.expectedCycles) / (nominalCapacityKwh / 1000) + 5).toFixed(0)} EUR/MWh
            </p>
          </div>
          {maxWarrantyCycles && (
            <div className="text-center">
              <p className="text-xs text-gray-400">Warranted Cycles</p>
              <p className="text-sm font-semibold text-gray-700">
                {maxWarrantyCycles.toLocaleString()} FEC
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
