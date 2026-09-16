'use client';

import React, { useMemo } from 'react';
import { Wrench, AlertTriangle, Calendar, Info } from 'lucide-react';
import {
  LineChart,
  Line,
  Area,
  AreaChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ForecastDataPoint } from '@/types/soiling';

interface ForecastChartProps {
  forecast: ForecastDataPoint[];
  showConfidenceBands?: boolean;
  showCleaningEvents?: boolean;
  cleaningDates?: string[];
  height?: number;
  className?: string;
}

/**
 * ForecastChart - Interactive time series chart for soiling ratio forecasts
 *
 * Features:
 * - Daily soiling ratio predictions
 * - Confidence interval bands (upper/lower bounds)
 * - Cleaning event markers
 * - Interactive tooltips with detailed metrics
 * - Responsive design
 */
export function ForecastChart({
  forecast,
  showConfidenceBands = true,
  showCleaningEvents = true,
  cleaningDates = [],
  height = 400,
  className = '',
}: ForecastChartProps) {
  // Prepare data for Recharts
  const chartData = useMemo(() => {
    return forecast.map((point) => ({
      date: point.date,
      dateFormatted: new Date(point.date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      soilingRatio: point.soilingRatio,
      lowerBound: point.lowerBound,
      upperBound: point.upperBound,
      soilingLossPct: point.soilingLossPct,
      cleaningRecommended: point.cleaningRecommended,
    }));
  }, [forecast]);

  // Create cleaning event markers
  const cleaningEventDates = useMemo(() => {
    return cleaningDates.map((date) => new Date(date).toISOString().split('T')[0]);
  }, [cleaningDates]);

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white border border-gray-200 rounded-xl shadow-xl p-4 text-sm">
          <p className="font-black text-gray-900 mb-3 border-b border-gray-100 pb-2 flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-blue-600" />
            {data.dateFormatted}
          </p>
          <div className="space-y-2 font-bold uppercase tracking-tight">
            <div className="flex justify-between gap-6 items-center">
              <span className="text-gray-500 text-[10px]">Soiling Ratio:</span>
              <span className="text-blue-600 font-black">{data.soilingRatio.toFixed(4)}</span>
            </div>
            <div className="flex justify-between gap-6 items-center">
              <span className="text-gray-500 text-[10px]">Proj. Loss:</span>
              <span className="text-red-600 font-black">{data.soilingLossPct.toFixed(2)}%</span>
            </div>
            {showConfidenceBands && (
              <div className="pt-2 border-t border-gray-50">
                <p className="text-gray-400 text-[9px] font-black tracking-widest">95% Confidence Interval</p>
                <div className="flex justify-between gap-2 mt-1 text-[10px]">
                  <span className="text-gray-400">{data.lowerBound.toFixed(4)}</span>
                  <span className="text-gray-400 font-black">TO</span>
                  <span className="text-gray-400">{data.upperBound.toFixed(4)}</span>
                </div>
              </div>
            )}
            {data.cleaningRecommended && (
              <div className="mt-3 p-2 bg-amber-50 rounded-lg border border-amber-100 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-amber-700 text-[10px] font-black">Maintenance Advised</span>
              </div>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`bg-white rounded-2xl p-6 border border-gray-200 ${className}`}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={chartData}
          margin={{ top: 20, right: 30, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id="colorSR" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorConfidence" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#93C5FD" stopOpacity={0.1} />
              <stop offset="95%" stopColor="#93C5FD" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
          <XAxis
            dataKey="dateFormatted"
            tick={{ fontSize: 10, fill: '#94A3B8', fontWeight: '700' }}
            axisLine={{ stroke: '#F1F5F9' }}
            interval="preserveStartEnd"
            minTickGap={50}
          />
          <YAxis
            domain={[0.5, 1.05]}
            tick={{ fontSize: 10, fill: '#94A3B8', fontWeight: '700' }}
            axisLine={false}
            tickLine={false}
            label={{ 
              value: 'SOILING RATIO (%)', 
              angle: -90, 
              position: 'insideLeft',
              style: { textAnchor: 'middle', fill: '#94A3B8', fontSize: 10, fontWeight: '900', letterSpacing: '0.1em' },
              offset: -10
            }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend 
            verticalAlign="top" 
            align="right" 
            height={36}
            iconType="circle"
            iconSize={8}
            formatter={(value) => <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{value}</span>}
          />

          {/* Confidence bands */}
          {showConfidenceBands && (
            <>
              <Area
                type="monotone"
                dataKey="upperBound"
                stroke="none"
                fill="url(#colorConfidence)"
                name="Variance Range"
                animationDuration={2000}
              />
              <Area
                type="monotone"
                dataKey="lowerBound"
                stroke="none"
                fill="#ffffff"
                animationDuration={2000}
              />
            </>
          )}

          {/* Main soiling ratio line */}
          <Area
            type="monotone"
            dataKey="soilingRatio"
            stroke="#3B82F6"
            strokeWidth={3}
            fill="url(#colorSR)"
            name="SR Projection"
            animationDuration={1500}
          />

          {/* Cleaning threshold line */}
          <ReferenceLine
            y={0.97}
            stroke="#F59E0B"
            strokeDasharray="6 4"
            strokeWidth={2}
            label={{ 
              value: 'CRITICAL THRESHOLD (0.97)', 
              position: 'right', 
              fill: '#F59E0B', 
              fontSize: 9, 
              fontWeight: '900' 
            }}
          />

          {/* Cleaning event markers */}
          {showCleaningEvents &&
            cleaningEventDates.map((date, idx) => (
              <ReferenceLine
                key={idx}
                x={new Date(date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
                stroke="#10B981"
                strokeWidth={2}
                strokeDasharray="4 4"
                label={{
                  value: 'RECOVERY',
                  position: 'top',
                  fill: '#10B981',
                  fontSize: 9,
                  fontWeight: '900',
                }}
              />
            ))}
        </AreaChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="mt-8 pt-6 border-t border-gray-100 flex flex-wrap justify-center gap-8">
        <div className="flex items-center gap-2.5">
          <div className="w-3 h-3 rounded-full bg-blue-500 shadow-sm shadow-blue-100" />
          <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">SR Projection</span>
        </div>
        {showConfidenceBands && (
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full bg-blue-200 shadow-sm shadow-blue-50" />
            <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Confidence Range</span>
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-0.5 border-t-2 border-dashed border-orange-400" />
          <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Cleaning Threshold</span>
        </div>
        {showCleaningEvents && cleaningDates.length > 0 && (
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-0.5 border-t-2 border-dashed border-green-500" />
            <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Maintenance Node</span>
          </div>
        )}
      </div>
    </div>
  );
}
