'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { SoHHistoryPoint, CapacityTest } from '@/types/bess';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface SoHHistoryChartProps {
  data: SoHHistoryPoint[];
  capacityTests?: CapacityTest[];
  warrantyThreshold?: number;
  installationDate?: string | null;
  warrantyYears?: number | null;
  capacityGuaranteePct?: number | null;
  loading?: boolean;
  height?: number;
  /** Extend a linear SoH trend forward (months). 0 disables. Default 36. */
  projectionMonths?: number;
}

export default function SoHHistoryChart({
  data,
  capacityTests = [],
  warrantyThreshold = 0.7,
  installationDate,
  warrantyYears,
  capacityGuaranteePct,
  loading,
  height = 300,
  projectionMonths = 36,
}: SoHHistoryChartProps) {
  const option = useMemo(() => {
    if (!data || data.length === 0) {
      return {};
    }

    let dates = data.map((d) => d.date);
    const sohValues = data.map((d) => Number((d.soh * 100).toFixed(2)));

    // Forward SoH projection: least-squares fit over the observed history,
    // extended monthly. Where it crosses the warranty threshold is the
    // estimated breach date — the number an asset manager actually wants.
    let projValues: (number | null)[] = [];
    let breachIndex = -1;
    const doProjection = projectionMonths > 0 && data.length >= 5;
    if (doProjection) {
      const t0 = new Date(dates[0]).getTime();
      const xs = data.map((d) => (new Date(d.date).getTime() - t0) / 86_400_000);
      const ys = data.map((d) => d.soh * 100);
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      const denom = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      const slope = denom > 0 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / denom : 0;
      const lastX = xs[n - 1];
      const lastY = ys[n - 1];
      const thresholdPct = warrantyThreshold * 100;

      projValues = new Array(n - 1).fill(null);
      projValues.push(Number(lastY.toFixed(2)));
      const lastDate = new Date(dates[n - 1]);
      for (let m = 1; m <= projectionMonths; m++) {
        const d = new Date(lastDate);
        d.setMonth(d.getMonth() + m);
        dates = [...dates, d.toISOString().slice(0, 10)];
        const x = lastX + m * 30.44;
        const y = lastY + slope * (x - lastX);
        projValues.push(Number(y.toFixed(2)));
        if (breachIndex < 0 && slope < 0 && y <= thresholdPct) {
          breachIndex = n - 1 + m;
        }
      }
    }

    // Build warranty degradation curve if we have the data
    const hasWarrantyCurve = !!(installationDate && warrantyYears && capacityGuaranteePct);
    // capacityGuaranteePct comes as decimal (e.g. 0.70), convert to percentage
    const guaranteePct = capacityGuaranteePct
      ? (capacityGuaranteePct <= 1 ? capacityGuaranteePct * 100 : capacityGuaranteePct)
      : 70;
    let warrantyCurveValues: number[] = [];
    if (hasWarrantyCurve) {
      const startDate = new Date(installationDate!);
      const endDate = new Date(installationDate!);
      endDate.setFullYear(endDate.getFullYear() + warrantyYears!);

      warrantyCurveValues = dates.map((dateStr) => {
        const d = new Date(dateStr);
        const totalMs = endDate.getTime() - startDate.getTime();
        const elapsedMs = d.getTime() - startDate.getTime();
        const progress = Math.max(0, Math.min(1, elapsedMs / totalMs));
        return Number((100 - (100 - guaranteePct) * progress).toFixed(2));
      });
    }

    // Mark capacity test points with larger symbols in the SoH data
    const symbolSizes = data.map((d) => (d.isCapacityTest ? 10 : 4));
    const itemColors = data.map((d) => (d.isCapacityTest ? '#8B5CF6' : '#3B82F6'));

    const series: any[] = [
      {
        name: 'SoH',
        type: 'line',
        data: sohValues,
        smooth: true,
        symbol: 'circle',
        symbolSize: (value: number, params: any) => symbolSizes[params.dataIndex] || 4,
        lineStyle: {
          color: '#3B82F6',
          width: 2,
        },
        itemStyle: {
          color: (params: any) => itemColors[params.dataIndex] || '#3B82F6',
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
              { offset: 1, color: 'rgba(59, 130, 246, 0.05)' },
            ],
          },
        },
        // Only use flat markLine if we don't have the degradation curve
        ...(!hasWarrantyCurve
          ? {
              markLine: {
                silent: true,
                lineStyle: {
                  color: '#EF4444',
                  type: 'dashed',
                  width: 2,
                },
                label: {
                  position: 'end',
                  formatter: 'Warranty: {c}%',
                  color: '#EF4444',
                },
                data: [
                  {
                    name: 'Warranty Threshold',
                    yAxis: warrantyThreshold * 100,
                  },
                ],
              },
            }
          : {}),
      },
    ];

    // Add warranty degradation curve as a second series
    if (hasWarrantyCurve && warrantyCurveValues.length > 0) {
      series.push({
        name: 'Warranty Guarantee',
        type: 'line',
        data: warrantyCurveValues,
        smooth: false,
        symbol: 'none',
        // Match legend marker to line colour.
        itemStyle: { color: '#EF4444' },
        lineStyle: {
          color: '#EF4444',
          width: 2,
          type: 'dashed',
        },
      });
    }

    // Forward projection series (dashed, with the estimated breach marked).
    if (doProjection && projValues.length > 0) {
      series.push({
        name: 'Projected SoH',
        type: 'line',
        data: projValues,
        smooth: false,
        symbol: 'none',
        itemStyle: { color: '#0EA5E9' },
        lineStyle: { color: '#0EA5E9', width: 2, type: 'dotted' },
        ...(breachIndex >= 0
          ? {
              markPoint: {
                symbol: 'pin',
                symbolSize: 40,
                itemStyle: { color: '#EF4444' },
                label: { fontSize: 9, color: '#fff', formatter: 'EOL' },
                data: [
                  {
                    name: 'Est. warranty breach',
                    coord: [dates[breachIndex], projValues[breachIndex]],
                  },
                ],
              },
            }
          : {}),
      });
    }

    const legendData = [
      ...(hasWarrantyCurve ? ['SoH', 'Warranty Guarantee'] : ['SoH', 'Warranty Threshold']),
      ...(doProjection ? ['Projected SoH'] : []),
    ];

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const date = params[0]?.axisValue || '';
          let tooltip = `<strong>${date}</strong><br/>`;
          params.forEach((param: any) => {
            if (!param || param.value == null) return;
            if (param.seriesName === 'SoH') {
              tooltip += `${param.marker} Actual SoH: ${param.value}%<br/>`;
            } else if (param.seriesName === 'Warranty Guarantee') {
              tooltip += `${param.marker} Warranty Min: ${param.value}%<br/>`;
            }
          });
          return tooltip;
        },
      },
      legend: {
        data: legendData,
        bottom: 0,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '15%',
        top: '10%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          rotate: 45,
          fontSize: 10,
        },
      },
      yAxis: {
        type: 'value',
        name: 'SoH (%)',
        min: hasWarrantyCurve
          ? Math.max(60, Math.floor(guaranteePct - 5))
          : (warrantyThreshold - 0.1) * 100,
        max: 100,
        axisLabel: {
          formatter: '{value}%',
        },
      },
      series,
    };
  }, [data, warrantyThreshold, installationDate, warrantyYears, capacityGuaranteePct, projectionMonths]);

  if (loading) {
    return (
      <div
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
        style={{ height }}
      >
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="h-full bg-gray-100 rounded" style={{ height: height - 80 }} />
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center"
        style={{ height }}
      >
        <p className="text-gray-500">No SoH history available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">State of Health History</h3>
        {capacityTests.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="w-3 h-3 rounded-full bg-purple-500 inline-block" />
            <span>{capacityTests.length} capacity tests</span>
          </div>
        )}
      </div>
      <ReactECharts
        option={option}
        style={{ height: height - 60, width: '100%' }}
        notMerge={true}
        lazyUpdate={true}
      />
    </div>
  );
}
