'use client';

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { PlantFinancials } from '@/types/portfolio';
import { formatCurrency } from '@/utils/riskScoring';

interface LossAttributionChartProps {
  financials: PlantFinancials;
  assetType: 'SOLAR' | 'WIND' | 'BESS';
}

const LOSS_COLORS: Record<string, string> = {
  Soiling: '#f59e0b',    // Amber
  Faults: '#ef4444',     // Red
  Degradation: '#6366f1', // Indigo
  Curtailment: '#0ea5e9', // Sky
};

export default function LossAttributionChart({ financials, assetType }: LossAttributionChartProps) {
  const chartOptions = useMemo(() => {
    const segments: Array<{ name: string; value: number; itemStyle: { color: string } }> = [];

    if (assetType === 'SOLAR' && financials.soiling_loss_eur > 0) {
      segments.push({
        name: 'Soiling',
        value: financials.soiling_loss_eur,
        itemStyle: { color: LOSS_COLORS.Soiling },
      });
    }

    if (financials.fault_loss_eur > 0) {
      segments.push({
        name: 'Faults',
        value: financials.fault_loss_eur,
        itemStyle: { color: LOSS_COLORS.Faults },
      });
    }

    if (financials.degradation_loss_eur > 0) {
      segments.push({
        name: 'Degradation',
        value: financials.degradation_loss_eur,
        itemStyle: { color: LOSS_COLORS.Degradation },
      });
    }

    if (financials.curtailment_loss_eur > 0) {
      segments.push({
        name: 'Curtailment',
        value: financials.curtailment_loss_eur,
        itemStyle: { color: LOSS_COLORS.Curtailment },
      });
    }

    // If all losses are zero, show a placeholder
    if (segments.length === 0) {
      segments.push({
        name: 'No Losses',
        value: 1,
        itemStyle: { color: '#E5E7EB' },
      });
    }

    const totalLoss = financials.total_loss_eur;

    return {
      tooltip: {
        trigger: 'item' as const,
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#E5E7EB',
        borderWidth: 1,
        textStyle: { color: '#374151', fontSize: 13 },
        formatter: (params: { name: string; value: number; percent: number; marker: string }) => {
          return `
            <div>${params.marker} <strong>${params.name}</strong></div>
            <div style="margin-top:4px">${formatCurrency(params.value)}</div>
            <div style="color:#6B7280">${params.percent.toFixed(1)}% of total</div>
          `;
        },
      },
      legend: {
        orient: 'horizontal' as const,
        bottom: 0,
        left: 'center' as const,
        textStyle: { fontSize: 12, color: '#6B7280' },
        itemWidth: 12,
        itemHeight: 12,
        itemGap: 20,
      },
      graphic: [
        {
          type: 'text' as const,
          left: 'center',
          top: '44%',
          style: {
            text: formatCurrency(totalLoss),
            fontSize: 18,
            fontWeight: '800' as const,
            fill: '#1e293b',
            textAlign: 'center' as const,
            textVerticalAlign: 'middle' as const,
          },
        },
        {
          type: 'text' as const,
          left: 'center',
          top: '52%',
          style: {
            text: 'TOTAL LOSS',
            fontSize: 9,
            fontWeight: '700' as const,
            fill: '#64748b',
            textAlign: 'center' as const,
            textVerticalAlign: 'middle' as const,
          },
        },
      ],
      series: [
        {
          type: 'pie',
          radius: ['35%', '65%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0,0,0,0.15)',
            },
          },
          data: segments,
        },
      ],
    };
  }, [financials, assetType]);

  return (
    <div className="bg-white rounded-xl border border-divider p-5">
      <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wide mb-4">
        Loss Attribution
      </h3>
      <ReactECharts
        option={chartOptions}
        style={{ height: 320, width: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge
      />
    </div>
  );
}
