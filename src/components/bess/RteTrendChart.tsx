'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { DailyCyclingMetrics } from '@/types/bess';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/**
 * Round-trip efficiency over time. RTE decay is one of the earliest signals
 * of cell or thermal problems and a warranty term in its own right, but it
 * was recorded (BessCycleRecord.round_trip_efficiency) and never charted.
 */
export default function RteTrendChart({
  records,
  minRte,
  height = 280,
}: {
  records: DailyCyclingMetrics[];
  /** Warranty minimum RTE (0-1), drawn as a red floor when provided. */
  minRte?: number | null;
  height?: number;
}) {
  const withRte = useMemo(
    () => records.filter((r) => r.roundTripEfficiency > 0),
    [records]
  );

  const option = useMemo(() => {
    if (withRte.length === 0) return {};
    const values = withRte.map((r) => Number((r.roundTripEfficiency * 100).toFixed(2)));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}%` },
      legend: { bottom: 0, data: ['Round-trip efficiency', '30d mean'] },
      grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
      xAxis: {
        type: 'category',
        data: withRte.map((r) => r.date),
        axisLabel: { rotate: 45, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        name: 'RTE (%)',
        min: (val: { min: number }) => Math.floor(Math.min(val.min, (minRte ?? 1) * 100) - 2),
        max: 100,
        axisLabel: { formatter: '{value}%' },
      },
      series: [
        {
          name: 'Round-trip efficiency',
          type: 'line',
          data: values,
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          itemStyle: { color: '#10B981' },
          lineStyle: { color: '#10B981', width: 2 },
          ...(minRte
            ? {
                markLine: {
                  silent: true,
                  lineStyle: { color: '#EF4444', type: 'dashed', width: 2 },
                  label: { position: 'end', formatter: 'Warranty min: {c}%', color: '#EF4444' },
                  data: [{ yAxis: Number((minRte * 100).toFixed(1)) }],
                },
              }
            : {}),
        },
        {
          name: '30d mean',
          type: 'line',
          data: values.map(() => Number(mean.toFixed(2))),
          symbol: 'none',
          lineStyle: { color: '#9CA3AF', type: 'dotted', width: 1.5 },
          itemStyle: { color: '#9CA3AF' },
        },
      ],
    };
  }, [withRte, minRte]);

  if (withRte.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center" style={{ height }}>
        <p className="text-gray-500">No round-trip efficiency history available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Round-Trip Efficiency Trend</h3>
      <ReactECharts option={option} style={{ height: height - 60, width: '100%' }} notMerge lazyUpdate />
    </div>
  );
}
