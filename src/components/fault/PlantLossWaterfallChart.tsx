'use client';

/**
 * Comprehensive Plant Loss Waterfall Chart
 * Shows all loss sources: soiling, curtailment, degradation, temperature, faults
 */

import React, { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { motion } from 'framer-motion';
import type { FaultSummary } from '@/types/faults';

export interface PlantLossData {
  referenceEnergy_kWh: number;
  netEnergy_kWh: number;
  losses: {
    soiling_kWh: number;
    soiling_pct: number;
    curtailment_kWh: number;
    curtailment_pct: number;
    degradation_kWh: number;
    degradation_pct: number;
    temperature_kWh: number;
    temperature_pct: number;
    spectral_kWh?: number;       // IEA: Air mass / spectral effects
    spectral_pct?: number;
    inverter_kWh: number;
    inverter_pct: number;
    wiring_bop_kWh?: number;     // IEA: Wiring & BOP losses (~2%)
    wiring_bop_pct?: number;
    faults_reactive_kWh: number;
    faults_reactive_pct: number;
    faults_predictive_kWh: number;
    faults_predictive_pct: number;
  };
}

interface PlantLossWaterfallChartProps {
  lossData: PlantLossData | null;
  faultSummary?: FaultSummary | null;
  title?: string;
  subtitle?: string;
  loading?: boolean;
  height?: number | string;
  showPieChart?: boolean;
  showFilters?: boolean;
}

// Loss category type for filters
type LossCategory = 'temperature' | 'spectral' | 'soiling' | 'inverter' | 'wiring_bop' | 'degradation' | 'curtailment' | 'faults_reactive' | 'faults_predictive';

// Color palette for different loss types (IEA PVPS Task 13 compliant)
const LOSS_COLORS = {
  temperature: '#EC4899',    // pink
  spectral: '#D946EF',       // fuchsia (air mass / spectral effects)
  soiling: '#F59E0B',        // amber
  inverter: '#14B8A6',       // teal
  wiring_bop: '#06B6D4',     // cyan (wiring & BOP)
  degradation: '#6366F1',    // indigo
  curtailment: '#8B5CF6',    // purple
  faults_reactive: '#EF4444', // red
  faults_predictive: '#F97316', // orange
  reference: '#10B981',      // green
  net: '#22C55E',            // green-500
};

export function PlantLossWaterfallChart({
  lossData,
  faultSummary,
  title = 'Plant Loss Disaggregation',
  subtitle,
  loading,
  height = 450,
  showPieChart = true,
  showFilters = true,
}: PlantLossWaterfallChartProps) {
  // Filter state for loss categories
  const [enabledCategories, setEnabledCategories] = useState<Set<LossCategory>>(
    new Set(['temperature', 'spectral', 'soiling', 'inverter', 'wiring_bop', 'degradation', 'curtailment', 'faults_reactive', 'faults_predictive'])
  );

  const toggleCategory = (category: LossCategory) => {
    setEnabledCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleAll = (enable: boolean) => {
    if (enable) {
      setEnabledCategories(new Set(['temperature', 'spectral', 'soiling', 'inverter', 'wiring_bop', 'degradation', 'curtailment', 'faults_reactive', 'faults_predictive']));
    } else {
      setEnabledCategories(new Set());
    }
  };

  // Merge fault summary data if provided
  const mergedLossData = useMemo(() => {
    if (!lossData) return null;

    // If we have fault summary, use those values
    if (faultSummary) {
      const refEnergy = lossData.referenceEnergy_kWh;
      return {
        ...lossData,
        losses: {
          ...lossData.losses,
          faults_reactive_kWh: faultSummary.current_loss_kwh,
          faults_reactive_pct: (faultSummary.current_loss_kwh / refEnergy) * 100,
          faults_predictive_kWh: faultSummary.projected_loss_kwh,
          faults_predictive_pct: (faultSummary.projected_loss_kwh / refEnergy) * 100,
        },
      };
    }
    return lossData;
  }, [lossData, faultSummary]);

  const waterfallOptions = useMemo(() => {
    if (!mergedLossData) return null;

    const { referenceEnergy_kWh, losses } = mergedLossData;

    // Build loss items for waterfall (IEA PVPS Task 13 order)
    // Reference → Temperature → Spectral → Soiling → Inverter → Wiring/BOP → Degradation → Curtailment → Faults → Net
    const allLossItems = [
      { name: 'Reference\nEnergy', value: referenceEnergy_kWh, isPositive: true, color: LOSS_COLORS.reference, category: null as LossCategory | null },
      { name: 'Temperature', value: -losses.temperature_kWh, pct: losses.temperature_pct, color: LOSS_COLORS.temperature, category: 'temperature' as LossCategory },
      { name: 'Spectral', value: -(losses.spectral_kWh || 0), pct: losses.spectral_pct || 0, color: LOSS_COLORS.spectral, category: 'spectral' as LossCategory },
      { name: 'Soiling', value: -losses.soiling_kWh, pct: losses.soiling_pct, color: LOSS_COLORS.soiling, category: 'soiling' as LossCategory },
      { name: 'Inverter', value: -losses.inverter_kWh, pct: losses.inverter_pct, color: LOSS_COLORS.inverter, category: 'inverter' as LossCategory },
      { name: 'Wiring\n& BOP', value: -(losses.wiring_bop_kWh || 0), pct: losses.wiring_bop_pct || 0, color: LOSS_COLORS.wiring_bop, category: 'wiring_bop' as LossCategory },
      { name: 'Degradation', value: -losses.degradation_kWh, pct: losses.degradation_pct, color: LOSS_COLORS.degradation, category: 'degradation' as LossCategory },
      { name: 'Curtailment', value: -losses.curtailment_kWh, pct: losses.curtailment_pct, color: LOSS_COLORS.curtailment, category: 'curtailment' as LossCategory },
      { name: 'Active\nFaults', value: -losses.faults_reactive_kWh, pct: losses.faults_reactive_pct, color: LOSS_COLORS.faults_reactive, category: 'faults_reactive' as LossCategory },
      { name: 'Predicted\nFaults', value: -losses.faults_predictive_kWh, pct: losses.faults_predictive_pct, color: LOSS_COLORS.faults_predictive, category: 'faults_predictive' as LossCategory },
    ];

    // Filter by enabled categories and recalculate net output
    const filteredLossItems = allLossItems.filter(item =>
      item.isPositive || (item.category && enabledCategories.has(item.category) && Math.abs(item.value) > 0)
    );

    // Calculate net output based on filtered losses
    const totalFilteredLoss = filteredLossItems
      .filter(item => !item.isPositive)
      .reduce((sum, item) => sum + Math.abs(item.value), 0);
    const netOutput = referenceEnergy_kWh - totalFilteredLoss;

    // Add net output to the end
    const lossItems = [
      ...filteredLossItems,
      { name: 'Net\nOutput', value: netOutput, isPositive: true, color: LOSS_COLORS.net, category: null as LossCategory | null },
    ];

    // Build waterfall data arrays
    let runningTotal = 0;
    const categories: string[] = [];
    const baseData: number[] = [];
    const barData: number[] = [];
    const barColors: string[] = [];

    lossItems.forEach((item, index) => {
      categories.push(item.name);

      if (index === 0) {
        // Reference (first bar)
        baseData.push(0);
        barData.push(item.value);
        barColors.push(item.color);
        runningTotal = item.value;
      } else if (index === lossItems.length - 1) {
        // Net output (last bar)
        baseData.push(0);
        barData.push(item.value);
        barColors.push(item.color);
      } else {
        // Loss items
        const lossValue = Math.abs(item.value);
        runningTotal -= lossValue;
        baseData.push(runningTotal);
        barData.push(lossValue);
        barColors.push(item.color);
      }
    });

    return {
      title: {
        text: title,
        subtext: subtitle,
        left: 'center',
        textStyle: { fontSize: 16, fontWeight: 'bold' },
        subtextStyle: { fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const dataIndex = params[0]?.dataIndex ?? params[1]?.dataIndex;
          const item = lossItems[dataIndex];
          if (!item) return '';

          if (item.isPositive) {
            return `<strong>${item.name.replace('\n', ' ')}</strong><br/>` +
                   `${(item.value / 1000).toFixed(1)} MWh`;
          }
          return `<strong>${item.name.replace('\n', ' ')}</strong><br/>` +
                 `Loss: ${(Math.abs(item.value) / 1000).toFixed(1)} MWh<br/>` +
                 `${item.pct?.toFixed(2)}% of reference`;
        },
      },
      grid: {
        left: '8%',
        right: '5%',
        bottom: '18%',
        top: '18%',
      },
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: {
          rotate: 0,
          interval: 0,
          fontSize: 10,
        },
      },
      yAxis: {
        type: 'value',
        name: 'Energy (MWh)',
        nameLocation: 'middle',
        nameGap: 50,
        axisLabel: {
          formatter: (val: number) => (val / 1000).toFixed(0),
        },
      },
      series: [
        // Base (transparent - creates waterfall effect)
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
        // Actual bars with per-item colors
        {
          name: 'Value',
          type: 'bar',
          stack: 'waterfall',
          itemStyle: {
            color: (params: any) => barColors[params.dataIndex],
            borderRadius: [4, 4, 0, 0],
          },
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            formatter: (params: any) => {
              const item = lossItems[params.dataIndex];
              if (item.isPositive) {
                return `${(item.value / 1000).toFixed(1)}`;
              }
              return `-${item.pct?.toFixed(1)}%`;
            },
          },
          data: barData,
        },
      ],
    };
  }, [mergedLossData, title, subtitle, enabledCategories]);

  const pieOptions = useMemo(() => {
    if (!mergedLossData || !showPieChart) return null;

    const { losses } = mergedLossData;

    // Only include non-zero losses that are enabled (IEA order)
    const pieData = [
      { name: 'Temperature', value: losses.temperature_kWh, color: LOSS_COLORS.temperature, category: 'temperature' as LossCategory },
      { name: 'Spectral', value: losses.spectral_kWh || 0, color: LOSS_COLORS.spectral, category: 'spectral' as LossCategory },
      { name: 'Soiling', value: losses.soiling_kWh, color: LOSS_COLORS.soiling, category: 'soiling' as LossCategory },
      { name: 'Inverter', value: losses.inverter_kWh, color: LOSS_COLORS.inverter, category: 'inverter' as LossCategory },
      { name: 'Wiring & BOP', value: losses.wiring_bop_kWh || 0, color: LOSS_COLORS.wiring_bop, category: 'wiring_bop' as LossCategory },
      { name: 'Degradation', value: losses.degradation_kWh, color: LOSS_COLORS.degradation, category: 'degradation' as LossCategory },
      { name: 'Curtailment', value: losses.curtailment_kWh, color: LOSS_COLORS.curtailment, category: 'curtailment' as LossCategory },
      { name: 'Active Faults', value: losses.faults_reactive_kWh, color: LOSS_COLORS.faults_reactive, category: 'faults_reactive' as LossCategory },
      { name: 'Predicted Faults', value: losses.faults_predictive_kWh, color: LOSS_COLORS.faults_predictive, category: 'faults_predictive' as LossCategory },
    ].filter(d => d.value > 0 && enabledCategories.has(d.category));

    const totalLoss = pieData.reduce((sum, d) => sum + d.value, 0);

    return {
      title: {
        text: 'Loss Distribution',
        left: 'center',
        textStyle: { fontSize: 14, fontWeight: 'bold' },
      },
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          return `<strong>${params.name}</strong><br/>` +
                 `${(params.value / 1000).toFixed(1)} MWh<br/>` +
                 `${params.percent.toFixed(1)}% of losses`;
        },
      },
      legend: {
        orient: 'vertical',
        right: '5%',
        top: 'middle',
        itemWidth: 12,
        itemHeight: 12,
        textStyle: { fontSize: 11 },
      },
      series: [
        {
          name: 'Losses',
          type: 'pie',
          radius: ['40%', '70%'],
          center: ['40%', '55%'],
          avoidLabelOverlap: true,
          itemStyle: {
            borderRadius: 4,
            borderColor: '#fff',
            borderWidth: 2,
          },
          label: {
            show: false,
          },
          emphasis: {
            label: {
              show: true,
              fontSize: 12,
              fontWeight: 'bold',
            },
          },
          data: pieData.map(d => ({
            name: d.name,
            value: d.value,
            itemStyle: { color: d.color },
          })),
        },
      ],
      graphic: [
        {
          type: 'text',
          left: '35%',
          top: '48%',
          style: {
            text: `${(totalLoss / 1000).toFixed(0)}`,
            fontSize: 24,
            fontWeight: 'bold',
            fill: '#1f2937',
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: '35%',
          top: '58%',
          style: {
            text: 'MWh Total',
            fontSize: 11,
            fill: '#6b7280',
            textAlign: 'center',
          },
        },
      ],
    };
  }, [mergedLossData, showPieChart, enabledCategories]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center bg-gray-100 animate-pulse rounded-xl"
        style={{ height }}
      >
        <div className="text-gray-400">Loading loss data...</div>
      </div>
    );
  }

  if (!mergedLossData || !waterfallOptions) {
    return (
      <div
        className="flex items-center justify-center bg-gray-100 rounded-xl"
        style={{ height }}
      >
        <span className="text-gray-500">No loss data available</span>
      </div>
    );
  }

  // Category filter buttons configuration
  const categoryFilters: { category: LossCategory; label: string; color: string }[] = [
    { category: 'temperature', label: 'Temperature', color: LOSS_COLORS.temperature },
    { category: 'spectral', label: 'Spectral', color: LOSS_COLORS.spectral },
    { category: 'soiling', label: 'Soiling', color: LOSS_COLORS.soiling },
    { category: 'inverter', label: 'Inverter', color: LOSS_COLORS.inverter },
    { category: 'wiring_bop', label: 'Wiring & BOP', color: LOSS_COLORS.wiring_bop },
    { category: 'degradation', label: 'Degradation', color: LOSS_COLORS.degradation },
    { category: 'curtailment', label: 'Curtailment', color: LOSS_COLORS.curtailment },
    { category: 'faults_reactive', label: 'Active Faults', color: LOSS_COLORS.faults_reactive },
    { category: 'faults_predictive', label: 'Predicted Faults', color: LOSS_COLORS.faults_predictive },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" data-tour="loss-waterfall">
      {/* Filter Controls */}
      {showFilters && (
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500 mr-2">Filter losses:</span>
            <div className="flex gap-1 mr-2">
              <button
                onClick={() => toggleAll(true)}
                className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded transition-colors"
              >
                All
              </button>
              <button
                onClick={() => toggleAll(false)}
                className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors"
              >
                None
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categoryFilters.map(({ category, label, color }) => {
                const isEnabled = enabledCategories.has(category);
                return (
                  <motion.button
                    key={category}
                    onClick={() => toggleCategory(category)}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                      isEnabled
                        ? 'text-white shadow-sm'
                        : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                    }`}
                    style={{
                      backgroundColor: isEnabled ? color : undefined,
                    }}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${isEnabled ? 'bg-white/80' : ''}`}
                      style={{ backgroundColor: isEnabled ? undefined : color }}
                    />
                    {label}
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className={`grid ${showPieChart ? 'grid-cols-1 lg:grid-cols-5' : 'grid-cols-1'}`}>
        {/* Waterfall Chart - takes 3 columns */}
        <div className={showPieChart ? 'lg:col-span-3' : ''}>
          <ReactECharts
            option={waterfallOptions}
            style={{ height, width: '100%' }}
            notMerge={true}
            lazyUpdate={true}
          />
        </div>

        {/* Pie Chart - takes 2 columns */}
        {showPieChart && pieOptions && (
          <div className="lg:col-span-2 border-l border-gray-200">
            <ReactECharts
              option={pieOptions}
              style={{ height, width: '100%' }}
              notMerge={true}
              lazyUpdate={true}
            />
          </div>
        )}
      </div>

      {/* Legend bar - now interactive */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
        <div className="flex flex-wrap gap-3 justify-center text-xs">
          {categoryFilters.map(({ category, label, color }) => {
            const isEnabled = enabledCategories.has(category);
            return (
              <button
                key={category}
                onClick={() => toggleCategory(category)}
                className={`flex items-center gap-1.5 transition-opacity ${
                  isEnabled ? 'opacity-100' : 'opacity-40'
                }`}
              >
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: color }}
                />
                <span className="text-gray-600">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default PlantLossWaterfallChart;
