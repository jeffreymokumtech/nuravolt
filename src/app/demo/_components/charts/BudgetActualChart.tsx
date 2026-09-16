'use client';

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { MonthlyGeneration } from '@/types/portfolio';

interface BudgetActualChartProps {
  monthlyData: MonthlyGeneration[];
}

export default function BudgetActualChart({ monthlyData }: BudgetActualChartProps) {
  const chartOptions = useMemo(() => {
    const months = monthlyData.map((d) => d.month);
    const budgetValues = monthlyData.map((d) => d.budget_MWh);
    const actualValues = monthlyData.map((d) => d.actual_MWh);

    return {
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#E5E7EB',
        borderWidth: 1,
        textStyle: { color: '#374151', fontSize: 13 },
        formatter: (params: Array<{ seriesName: string; value: number; dataIndex: number; marker: string }>) => {
          if (!params || params.length === 0) return '';
          const idx = params[0].dataIndex;
          const budget = budgetValues[idx];
          const actual = actualValues[idx];
          const deviation = budget > 0
            ? ((actual - budget) / budget * 100).toFixed(1)
            : '0.0';
          const deviationColor = Number(deviation) >= 0 ? '#10B981' : '#EF4444';
          return `
            <div style="font-weight:600;margin-bottom:6px">${months[idx]}</div>
            ${params.map((p: { marker: string; seriesName: string; value: number }) =>
              `<div>${p.marker} ${p.seriesName}: <strong>${p.value.toLocaleString()} MWh</strong></div>`
            ).join('')}
            <div style="margin-top:4px;color:${deviationColor};font-weight:600">
              Deviation: ${Number(deviation) >= 0 ? '+' : ''}${deviation}%
            </div>
          `;
        },
      },
      legend: {
        data: ['Budget', 'Actual'],
        bottom: 0,
        textStyle: { fontSize: 12, color: '#6B7280' },
      },
      grid: {
        top: 16,
        right: 16,
        bottom: 40,
        left: 56,
        containLabel: false,
      },
      xAxis: {
        type: 'category' as const,
        data: months,
        axisLabel: { fontSize: 11, color: '#6B7280' },
        axisLine: { lineStyle: { color: '#E5E7EB' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        name: 'MWh',
        nameTextStyle: { fontSize: 11, color: '#9CA3AF', padding: [0, 0, 0, -20] },
        axisLabel: {
          fontSize: 11,
          color: '#6B7280',
          formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v),
        },
        splitLine: { lineStyle: { color: '#F3F4F6', type: 'dashed' as const } },
      },
      series: [
        {
          name: 'Budget',
          type: 'bar',
          data: budgetValues,
          barGap: '10%',
          barMaxWidth: 28,
          itemStyle: {
            color: '#3B82F6',
            borderRadius: [3, 3, 0, 0],
          },
        },
        {
          name: 'Actual',
          type: 'bar',
          data: actualValues,
          barMaxWidth: 28,
          itemStyle: {
            color: '#10B981',
            borderRadius: [3, 3, 0, 0],
          },
        },
      ],
    };
  }, [monthlyData]);

  return (
    <div className="bg-white rounded-xl border border-divider p-5">
      <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wide mb-4">
        Monthly Generation: Budget vs Actual
      </h3>
      <ReactECharts
        option={chartOptions}
        style={{ height: 350, width: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge
      />
    </div>
  );
}
