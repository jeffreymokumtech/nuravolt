/**
 * SeasonalForecastChart - Visualize seasonal soiling forecast with confidence bands
 *
 * Features:
 * - Line chart with 95% confidence interval band
 * - Cleaning recommendation markers
 * - Optional seasonal mean overlay
 * - Responsive design with tooltips
 */

'use client';

import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
  Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';

interface ForecastDataPoint {
  date: string;
  day_of_year: number;
  month: number;
  month_name: string;
  sr_forecast: number;
  sr_lower_95: number;
  sr_upper_95: number;
  sr_seasonal_mean?: number;
  rain_probability: number;
  rain_mm_expected: number;
  is_rain_event: boolean;
  monthly_soiling_rate: number;
}

interface CleaningRecommendation {
  date: string;
  sr_at_cleaning: number;
  reason: string;
  expected_recovery: number;
  priority: string;
}

interface SeasonalForecastChartProps {
  forecast: ForecastDataPoint[];
  cleaningRecommendations?: CleaningRecommendation[];
  height?: number;
  showSeasonalMean?: boolean;
  showConfidenceBands?: boolean;
}

export function SeasonalForecastChart({
  forecast,
  cleaningRecommendations = [],
  height = 400,
  showSeasonalMean = false,
  showConfidenceBands = true,
}: SeasonalForecastChartProps) {
  // Prepare chart data
  const chartData = useMemo(() => {
    return forecast.map((f) => ({
      date: f.date,
      dateFormatted: format(parseISO(f.date), 'MMM d'),
      sr_forecast: f.sr_forecast * 100,
      sr_lower: f.sr_lower_95 * 100,
      sr_upper: f.sr_upper_95 * 100,
      sr_seasonal_mean: f.sr_seasonal_mean ? f.sr_seasonal_mean * 100 : undefined,
      rain_probability: f.rain_probability * 100,
      month_name: f.month_name,
      confidence_band: [f.sr_lower_95 * 100, f.sr_upper_95 * 100],
    }));
  }, [forecast]);

  // Create cleaning markers lookup
  const cleaningDatesSet = useMemo(() => {
    return new Set(cleaningRecommendations.map((c) => c.date));
  }, [cleaningRecommendations]);

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const cleaning = cleaningRecommendations.find((c) => c.date === data.date);

      return (
        <div className="bg-white p-3 border border-gray-200 rounded-lg shadow-lg text-sm">
          <p className="font-semibold text-gray-900 mb-2">
            {format(parseISO(data.date), 'EEEE, MMMM d, yyyy')}
          </p>
          <div className="space-y-1">
            <p className="text-blue-600">
              Forecast SR: <strong>{data.sr_forecast.toFixed(1)}%</strong>
            </p>
            {showConfidenceBands && (
              <p className="text-gray-500 text-xs">
                95% CI: {data.sr_lower.toFixed(1)}% - {data.sr_upper.toFixed(1)}%
              </p>
            )}
            {showSeasonalMean && data.sr_seasonal_mean && (
              <p className="text-purple-600">
                Seasonal Mean: {data.sr_seasonal_mean.toFixed(1)}%
              </p>
            )}
            <p className="text-cyan-600">
              Rain Probability: {data.rain_probability.toFixed(0)}%
            </p>
            {cleaning && (
              <div className="mt-2 pt-2 border-t border-gray-200">
                <p className="text-orange-600 font-semibold">Cleaning Recommended</p>
                <p className="text-gray-600 text-xs">{cleaning.reason}</p>
              </div>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="dateFormatted"
            tick={{ fontSize: 11, fill: '#6b7280' }}
            interval={Math.floor(chartData.length / 12)}
            tickLine={false}
          />
          <YAxis
            domain={[
              (dataMin: number) => Math.max(Math.floor(dataMin) - 2, 60),
              102,
            ]}
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickFormatter={(value) => `${value}%`}
            width={50}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend />

          {/* 95% Confidence Band */}
          {showConfidenceBands && (
            <Area
              type="monotone"
              dataKey="confidence_band"
              fill="#3b82f6"
              fillOpacity={0.15}
              stroke="none"
              name="95% CI"
            />
          )}

          {/* Seasonal Mean */}
          {showSeasonalMean && (
            <Line
              type="monotone"
              dataKey="sr_seasonal_mean"
              stroke="#8b5cf6"
              strokeWidth={1}
              strokeDasharray="5 5"
              dot={false}
              name="Seasonal Mean"
            />
          )}

          {/* Main Forecast Line */}
          <Line
            type="monotone"
            dataKey="sr_forecast"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: '#3b82f6' }}
            name="SR Forecast"
          />

          {/* Cleaning Markers */}
          {cleaningRecommendations.map((rec) => {
            const dataPoint = chartData.find((d) => d.date === rec.date);
            if (!dataPoint) return null;
            return (
              <ReferenceDot
                key={rec.date}
                x={dataPoint.dateFormatted}
                y={rec.sr_at_cleaning * 100}
                r={6}
                fill="#f97316"
                stroke="#fff"
                strokeWidth={2}
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend for cleaning markers */}
      {cleaningRecommendations.length > 0 && (
        <div className="flex items-center justify-center gap-6 mt-2 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-orange-500" />
            <span>Cleaning Recommended ({cleaningRecommendations.length})</span>
          </div>
        </div>
      )}
    </div>
  );
}
