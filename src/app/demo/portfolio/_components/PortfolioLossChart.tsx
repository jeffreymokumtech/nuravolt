'use client';

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { formatCurrency } from '@/utils/riskScoring';
import type { PortfolioFinancialSummary } from '@/types/portfolio';

interface PortfolioLossChartProps {
  summary: PortfolioFinancialSummary;
}

export default function PortfolioLossChart({ summary }: PortfolioLossChartProps) {
  const options = useMemo(() => {
    const totalRevenue = summary.total_annual_revenue_eur;
    const soiling = summary.total_soiling_loss_eur;
    const faults = summary.total_fault_loss_eur;
    const degradation = summary.total_degradation_loss_eur;
    const curtailment = summary.total_curtailment_loss_eur;
    const netRevenue = totalRevenue - soiling - faults - degradation - curtailment;

    const categories = [
      'Total Revenue',
      'Soiling',
      'Faults',
      'Degradation',
      'Curtailment',
      'Net Revenue',
    ];

    // Waterfall: transparent base stacks below the visible bar
    // For losses, the base is the running total after the loss
    const runningTotals = [
      0, // Total Revenue starts at 0
      totalRevenue - soiling, // after soiling loss
      totalRevenue - soiling - faults, // after faults loss
      totalRevenue - soiling - faults - degradation, // after degradation loss
      totalRevenue - soiling - faults - degradation - curtailment, // after curtailment loss
      0, // Net Revenue starts at 0
    ];

    const visibleValues = [
      totalRevenue,
      soiling,
      faults,
      degradation,
      curtailment,
      netRevenue,
    ];

    const barColors = [
      '#3b82f6', // Total Revenue - blue-500
      '#f59e0b', // Soiling - amber-500
      '#ef4444', // Faults - red-500
      '#6366f1', // Degradation - indigo-500
      '#0ea5e9', // Curtailment - sky-500
      '#10b981', // Net Revenue - emerald-500
    ];

    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        textStyle: { color: '#1e293b', fontSize: 13 },
        formatter: (params: Array<{ name: string; seriesIndex: number; value: number; marker: string }>) => {
          const visibleParam = params.find((p) => p.seriesIndex === 1);
          if (!visibleParam) return '';
          const idx = categories.indexOf(visibleParam.name);
          const value = visibleValues[idx];
          const isLoss = idx >= 1 && idx <= 4;
          return `
            <div style="font-weight:700;margin-bottom:4px">${visibleParam.name}</div>
            <div style="display:flex;align-items:center;gap:6px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background-color:${barColors[idx]}"></span>
              <span style="font-weight:600">${isLoss ? '-' : ''}${formatCurrency(value)}</span>
            </div>
          `;
        },
      },
      grid: {
        left: '2%',
        right: '2%',
        bottom: '5%',
        top: '12%',
        containLabel: true,
      },
      xAxis: {
        type: 'category' as const,
        data: categories,
        axisLabel: {
          fontSize: 10,
          fontWeight: '600',
          color: '#64748b',
          interval: 0,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#f1f5f9' } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          fontSize: 10,
          fontWeight: '500',
          color: '#64748b',
          formatter: (val: number) => formatCurrency(val),
        },
        splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
      },
      series: [
        {
          name: 'Base',
          type: 'bar' as const,
          stack: 'waterfall',
          itemStyle: {
            color: 'transparent',
            borderColor: 'transparent',
          },
          emphasis: { itemStyle: { color: 'transparent', borderColor: 'transparent' } },
          data: runningTotals,
        },
        {
          name: 'Value',
          type: 'bar' as const,
          stack: 'waterfall',
          barWidth: '40%',
          label: {
            show: true,
            position: 'top' as const,
            fontSize: 10,
            fontWeight: '700',
            color: '#475569',
            formatter: (params: { dataIndex: number }) => {
              const idx = params.dataIndex;
              const isLoss = idx >= 1 && idx <= 4;
              return `${isLoss ? '-' : ''}${formatCurrency(visibleValues[idx])}`;
            },
          },
          itemStyle: {
            color: (params: { dataIndex: number }) => barColors[params.dataIndex],
            borderRadius: [4, 4, 4, 4],
          },
          data: visibleValues,
        },
      ],
    };
  }, [summary]);

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
      <h3 className="font-semibold text-ink mb-4">Portfolio Loss Disaggregation</h3>
      <ReactECharts option={options} style={{ height: 380 }} />
    </div>
  );
}
