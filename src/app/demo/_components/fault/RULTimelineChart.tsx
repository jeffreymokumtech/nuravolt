'use client';

/**
 * RUL Timeline Chart - Gantt-style visualization of Remaining Useful Life predictions
 * Shows days-to-fault for each equipment/fault pair with urgency-based coloring
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { RULPrediction, FaultUrgency } from '@/types/faults';

interface RULTimelineChartProps {
  predictions: RULPrediction[] | null | undefined;
  loading?: boolean;
  height?: number;
  maxDays?: number;
}

// Urgency colors matching the UrgencyCards
const URGENCY_COLORS: Record<FaultUrgency, string> = {
  urgent: '#EF4444',    // red-500
  soon: '#F97316',      // orange-500
  planned: '#3B82F6',   // blue-500
  monitoring: '#6B7280', // gray-500
};

const URGENCY_BG_COLORS: Record<FaultUrgency, string> = {
  urgent: '#FEE2E2',    // red-100
  soon: '#FFEDD5',      // orange-100
  planned: '#DBEAFE',   // blue-100
  monitoring: '#F3F4F6', // gray-100
};

export default function RULTimelineChart({
  predictions,
  loading,
  height = 350,
  maxDays = 90,
}: RULTimelineChartProps) {

  const chartOptions = useMemo(() => {
    if (!predictions || predictions.length === 0) return null;

    // Sort by days_to_fault (most urgent first)
    const sortedPredictions = [...predictions].sort((a, b) => a.days_to_fault - b.days_to_fault);

    // Create labels for Y-axis (equipment: fault type)
    const yAxisData = sortedPredictions.map(p =>
      `${p.inverter_id}: ${p.display_name}`
    );

    // Create bar data with urgency colors
    const barData = sortedPredictions.map(p => ({
      value: p.days_to_fault,
      itemStyle: {
        color: URGENCY_COLORS[p.urgency],
        borderRadius: [0, 4, 4, 0],
      },
      // Store extra data for tooltip
      prediction: p,
    }));

    // Create urgency zone markers
    const markLines = [
      { xAxis: 3, label: { formatter: 'Urgent', position: 'start' }, lineStyle: { color: '#EF4444', type: 'dashed' } },
      { xAxis: 7, label: { formatter: 'Soon', position: 'start' }, lineStyle: { color: '#F97316', type: 'dashed' } },
      { xAxis: 30, label: { formatter: 'Planned', position: 'start' }, lineStyle: { color: '#3B82F6', type: 'dashed' } },
    ];

    return {
      title: {
        text: 'RUL Predictions Timeline',
        subtext: 'Days until predicted maintenance required',
        left: 'center',
        textStyle: { fontSize: 16, fontWeight: 'bold' },
        subtextStyle: { fontSize: 12, color: '#6B7280' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const data = params[0];
          if (!data || !data.data?.prediction) return '';

          const p = data.data.prediction as RULPrediction;
          const confidencePct = (p.confidence * 100).toFixed(0);
          const currentVal = p.current_value !== null
            ? `${p.current_value.toFixed(1)} ${p.unit}`
            : 'N/A';

          return `
            <div style="min-width: 220px;">
              <div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">
                ${p.inverter_id}: ${p.display_name}
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #6B7280;">Days to fault:</span>
                <span style="font-weight: 600; color: ${URGENCY_COLORS[p.urgency]};">${p.days_to_fault}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #6B7280;">Confidence:</span>
                <span style="font-weight: 500;">${confidencePct}%</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #6B7280;">Current value:</span>
                <span style="font-weight: 500;">${currentVal}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #6B7280;">Threshold:</span>
                <span style="font-weight: 500;">${p.threshold} ${p.unit}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #6B7280;">Revenue at risk:</span>
                <span style="font-weight: 500; color: #DC2626;">€${p.revenue_at_risk_eur.toLocaleString()}</span>
              </div>
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #374151;">
                <strong>Action:</strong> ${p.recommended_action}
              </div>
            </div>
          `;
        },
      },
      grid: {
        left: '22%',
        right: '5%',
        bottom: '15%',
        top: '18%',
      },
      xAxis: {
        type: 'value',
        name: 'Days',
        nameLocation: 'middle',
        nameGap: 25,
        max: maxDays,
        min: 0,
        axisLabel: {
          fontSize: 11,
        },
        splitLine: {
          lineStyle: { color: '#F3F4F6' },
        },
      },
      yAxis: {
        type: 'category',
        data: yAxisData,
        axisLabel: {
          fontSize: 11,
          width: 150,
          overflow: 'truncate',
          ellipsis: '...',
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#E5E7EB' } },
      },
      series: [
        {
          name: 'Days to Fault',
          type: 'bar',
          data: barData,
          barWidth: '60%',
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            formatter: (params: any) => `${params.value}d`,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', width: 1.5 },
            label: {
              show: true,
              position: 'start',
              fontSize: 9,
              color: '#9CA3AF',
            },
            data: markLines,
          },
        },
      ],
      // Visual urgency zones as background rectangles
      visualMap: {
        show: false,
        pieces: [
          { gte: 0, lt: 3, color: URGENCY_COLORS.urgent },
          { gte: 3, lt: 7, color: URGENCY_COLORS.soon },
          { gte: 7, lt: 30, color: URGENCY_COLORS.planned },
          { gte: 30, color: URGENCY_COLORS.monitoring },
        ],
      },
    };
  }, [predictions, maxDays]);

  if (loading) {
    return (
      <div
        className="bg-white rounded-xl border border-divider animate-pulse flex items-center justify-center"
        style={{ height }}
      >
        <div className="text-ink-3">Loading RUL predictions...</div>
      </div>
    );
  }

  if (!predictions || predictions.length === 0 || !chartOptions) {
    return (
      <div
        className="bg-white rounded-xl border border-divider flex items-center justify-center"
        style={{ height }}
      >
        <div className="text-center">
          <div className="text-ink-3 mb-2">No RUL predictions available</div>
          <div className="text-xs text-gray-300">RUL models analyze equipment degradation patterns</div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      <ReactECharts
        option={chartOptions}
        style={{ height, width: '100%' }}
        notMerge={true}
        lazyUpdate={true}
      />

      {/* Urgency legend */}
      <div className="px-4 py-3 bg-paper border-t border-divider">
        <div className="flex flex-wrap gap-4 justify-center text-xs">
          {[
            { label: 'Urgent (< 3 days)', color: URGENCY_COLORS.urgent, bg: URGENCY_BG_COLORS.urgent },
            { label: 'Soon (3-7 days)', color: URGENCY_COLORS.soon, bg: URGENCY_BG_COLORS.soon },
            { label: 'Planned (7-30 days)', color: URGENCY_COLORS.planned, bg: URGENCY_BG_COLORS.planned },
            { label: 'Monitoring (> 30 days)', color: URGENCY_COLORS.monitoring, bg: URGENCY_BG_COLORS.monitoring },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1.5">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-ink-2">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
