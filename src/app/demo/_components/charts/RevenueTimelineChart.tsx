'use client';

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { MonthlyGeneration } from '@/types/portfolio';

interface RevenueTimelineChartProps {
  monthlyData: MonthlyGeneration[];
  ppaPrice: number;
}

function formatEur(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `\u20AC${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `\u20AC${(value / 1_000).toFixed(0)}K`;
  }
  return `\u20AC${value.toFixed(0)}`;
}

export default function RevenueTimelineChart({ monthlyData, ppaPrice }: RevenueTimelineChartProps) {
  const chartOptions = useMemo(() => {
    const months = monthlyData.map((d) => d.month);

    // Build cumulative revenue arrays
    const cumulativeExpected: number[] = [];
    const cumulativeActual: number[] = [];
    let runningExpected = 0;
    let runningActual = 0;

    for (const d of monthlyData) {
      runningExpected += d.budget_MWh * ppaPrice;
      runningActual += d.actual_MWh * ppaPrice;
      cumulativeExpected.push(Math.round(runningExpected));
      cumulativeActual.push(Math.round(runningActual));
    }

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
          const expected = cumulativeExpected[idx];
          const actual = cumulativeActual[idx];
          const gap = actual - expected;
          const gapColor = gap >= 0 ? '#10B981' : '#EF4444';
          return `
            <div style="font-weight:600;margin-bottom:6px">${months[idx]}</div>
            ${params.map((p: { marker: string; seriesName: string; value: number }) =>
              `<div>${p.marker} ${p.seriesName}: <strong>${formatEur(p.value)}</strong></div>`
            ).join('')}
            <div style="margin-top:4px;color:${gapColor};font-weight:600">
              Gap: ${gap >= 0 ? '+' : ''}${formatEur(gap)}
            </div>
          `;
        },
      },
      legend: {
        data: ['Expected Revenue', 'Actual Revenue'],
        bottom: 0,
        textStyle: { fontSize: 12, color: '#6B7280' },
      },
      grid: {
        top: 16,
        right: 16,
        bottom: 40,
        left: 64,
        containLabel: false,
      },
      xAxis: {
        type: 'category' as const,
        data: months,
        boundaryGap: false,
        axisLabel: { fontSize: 11, color: '#6B7280' },
        axisLine: { lineStyle: { color: '#E5E7EB' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          fontSize: 11,
          color: '#6B7280',
          formatter: (v: number) => formatEur(v),
        },
        splitLine: { lineStyle: { color: '#F3F4F6', type: 'dashed' as const } },
      },
      series: [
        {
          name: 'Expected Revenue',
          type: 'line',
          data: cumulativeExpected,
          smooth: true,
          symbol: 'none',
          lineStyle: {
            color: '#3B82F6',
            width: 2,
            type: 'dashed' as const,
          },
          itemStyle: { color: '#3B82F6' },
          areaStyle: undefined,
        },
        {
          name: 'Actual Revenue',
          type: 'line',
          data: cumulativeActual,
          smooth: true,
          symbol: 'none',
          lineStyle: {
            color: '#10B981',
            width: 2,
          },
          itemStyle: { color: '#10B981' },
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(16, 185, 129, 0.25)' },
                { offset: 1, color: 'rgba(16, 185, 129, 0.02)' },
              ],
            },
          },
        },
      ],
      visualMap: {
        show: false,
        seriesIndex: 1,
        pieces: cumulativeActual.map((actual, i) => {
          const expected = cumulativeExpected[i];
          return actual >= expected
            ? { gte: i, lt: i + 1, color: '#10B981' }
            : { gte: i, lt: i + 1, color: '#EF4444' };
        }),
      },
    };
  }, [monthlyData, ppaPrice]);

  return (
    <div className="bg-white rounded-xl border border-divider p-5">
      <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wide mb-4">
        Cumulative Revenue vs Budget
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
