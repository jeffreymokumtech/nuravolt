"use client";

import React, { useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Area, AreaChart } from 'recharts';
import { Target, BarChart3, TrendingUp, Droplets } from 'lucide-react';

/**
 * Backtest Dashboard Component
 *
 * Displays comprehensive backtesting results for soiling prediction models
 * across multiple forecast horizons (7d, 30d, 90d, 365d).
 *
 * Critical Requirement:
 * "I need the soiling intel to show my accuracy in a backtest of estimating
 * soiling rates. I want to do this accuracy estimated for the entire year ahead,
 * as it's important for the cleaning recommendation."
 *
 * Features:
 * - Accuracy metrics for each forecast horizon
 * - Time-series visualization of predictions vs actuals
 * - Cleaning recommendation accuracy (precision/recall)
 * - Confidence intervals
 * - Directional accuracy
 * - Comparative horizon analysis
 */

interface BacktestMetrics {
  horizon_days: number;
  n_validation_runs: number;
  mean_mae: number;
  std_mae: number;
  mean_rmse: number;
  std_rmse: number;
  mean_r2: number;
  std_r2: number;
  mean_mape: number;
  std_mape: number;
  mean_directional_accuracy?: number;
  mean_cleaning_precision?: number;
  mean_cleaning_recall?: number;
  interpretation: {
    mae: string;
    r2: string;
    cleaning?: string;
  };
}

interface BacktestData {
  plant_id: string;
  horizons: {
    [key: string]: BacktestMetrics;
  };
  backtest_config: {
    forecast_horizons: number[];
    window_type: string;
    min_training_days: number;
    validation_frequency: string;
  };
}

interface BacktestPrediction {
  timestamp: string;
  prediction: number;
  actual: number;
  error: number;
  train_start: string;
  train_end: string;
  forecast_start: string;
}

interface BacktestDashboardProps {
  backtestData: BacktestData;
  predictions?: { [horizon: string]: BacktestPrediction[] };
  loading?: boolean;
}

export function BacktestDashboard({
  backtestData,
  predictions,
  loading = false,
}: BacktestDashboardProps) {
  const [selectedHorizon, setSelectedHorizon] = useState<string>('365d');
  const [activeTab, setActiveTab] = useState<'overview' | 'predictions' | 'cleaning'>('overview');

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="loading loading-spinner loading-lg text-primary"></div>
      </div>
    );
  }

  // Prepare data for horizon comparison chart
  const horizonComparisonData = Object.entries(backtestData.horizons).map(([horizon, metrics]) => ({
    horizon: horizon.replace('d', ' Days'),
    mae: metrics.mean_mae,
    mae_error: metrics.std_mae,
    r2: metrics.mean_r2,
    r2_error: metrics.std_r2,
    mape: metrics.mean_mape,
  }));

  // Get metrics for selected horizon
  const selectedMetrics = backtestData.horizons[selectedHorizon];

  // Prepare predictions data for time series chart
  const predictionChartData = predictions?.[selectedHorizon]?.map(pred => ({
    timestamp: new Date(pred.timestamp).toLocaleDateString(),
    actual: pred.actual,
    prediction: pred.prediction,
    error: Math.abs(pred.error),
  })) || [];

  // Calculate cleaning F1-score if available
  const cleaningF1Score = selectedMetrics?.mean_cleaning_precision && selectedMetrics?.mean_cleaning_recall
    ? (2 * (selectedMetrics.mean_cleaning_precision * selectedMetrics.mean_cleaning_recall)) /
      (selectedMetrics.mean_cleaning_precision + selectedMetrics.mean_cleaning_recall)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20">
        <div className="card-body">
          <h2 className="card-title text-2xl flex items-center gap-2">
            <Target className="w-6 h-6 text-primary" />
            Forecast Accuracy Backtesting
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            Rolling-window validation across multiple forecast horizons to validate soiling prediction accuracy.
            Critical for reliable cleaning recommendations and annual planning.
          </p>

          {/* Configuration Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="stat bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <div className="stat-title text-xs">Plant ID</div>
              <div className="stat-value text-lg">{backtestData.plant_id}</div>
            </div>
            <div className="stat bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <div className="stat-title text-xs">Window Type</div>
              <div className="stat-value text-lg capitalize">{backtestData.backtest_config.window_type}</div>
            </div>
            <div className="stat bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <div className="stat-title text-xs">Min Training</div>
              <div className="stat-value text-lg">{backtestData.backtest_config.min_training_days}d</div>
            </div>
            <div className="stat bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <div className="stat-title text-xs">Validation Freq</div>
              <div className="stat-value text-lg capitalize">{backtestData.backtest_config.validation_frequency}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs tabs-boxed bg-base-200">
        <button
          className={`tab flex items-center gap-2 ${activeTab === 'overview' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <BarChart3 className="w-4 h-4" />
          Overview
        </button>
        <button
          className={`tab flex items-center gap-2 ${activeTab === 'predictions' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('predictions')}
        >
          <TrendingUp className="w-4 h-4" />
          Predictions
        </button>
        <button
          className={`tab flex items-center gap-2 ${activeTab === 'cleaning' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('cleaning')}
        >
          <Droplets className="w-4 h-4" />
          Cleaning Accuracy
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Horizon Comparison Chart */}
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h3 className="card-title">Accuracy Across Forecast Horizons</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Comparison of forecast accuracy (MAE and R²) across different time horizons
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* MAE Comparison */}
                <div>
                  <h4 className="font-semibold mb-2 text-center">Mean Absolute Error (MAE)</h4>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={horizonComparisonData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="horizon" />
                      <YAxis label={{ value: 'MAE', angle: -90, position: 'insideLeft' }} />
                      <Tooltip
                        formatter={(value: number) => value.toFixed(6)}
                        contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
                      />
                      <Bar dataKey="mae" fill="#3B82F6" name="MAE" />
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="text-xs text-center text-gray-500 mt-2">
                    Lower is better. Target: MAE &lt; 0.03 for reliable forecasts
                  </p>
                </div>

                {/* R² Comparison */}
                <div>
                  <h4 className="font-semibold mb-2 text-center">R² Score</h4>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={horizonComparisonData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="horizon" />
                      <YAxis domain={[0, 1]} label={{ value: 'R²', angle: -90, position: 'insideLeft' }} />
                      <Tooltip
                        formatter={(value: number) => value.toFixed(4)}
                        contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
                      />
                      <Bar dataKey="r2" fill="#10B981" name="R²" />
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="text-xs text-center text-gray-500 mt-2">
                    Higher is better. Target: R² &gt; 0.8 for reliable forecasts
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Detailed Metrics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Object.entries(backtestData.horizons).map(([horizon, metrics]) => (
              <div
                key={horizon}
                className={`card shadow-lg cursor-pointer transition-all ${
                  selectedHorizon === horizon
                    ? 'bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900 dark:to-purple-900 ring-2 ring-blue-500'
                    : 'bg-base-100 hover:shadow-xl'
                }`}
                onClick={() => setSelectedHorizon(horizon)}
              >
                <div className="card-body p-4">
                  <h3 className="card-title text-lg">{horizon.replace('d', ' Days')}</h3>
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs text-gray-600 dark:text-gray-400">MAE</p>
                      <p className="text-lg font-bold">
                        {metrics.mean_mae.toFixed(6)} <span className="text-xs font-normal">±{metrics.std_mae.toFixed(6)}</span>
                      </p>
                      <p className="text-xs text-gray-500">{metrics.interpretation.mae}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 dark:text-gray-400">R² Score</p>
                      <p className="text-lg font-bold">
                        {metrics.mean_r2.toFixed(4)} <span className="text-xs font-normal">±{metrics.std_r2.toFixed(4)}</span>
                      </p>
                      <p className="text-xs text-gray-500">{metrics.interpretation.r2}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 dark:text-gray-400">MAPE</p>
                      <p className="text-lg font-bold">{metrics.mean_mape.toFixed(2)}%</p>
                    </div>
                    <div className="divider my-1"></div>
                    <p className="text-xs text-gray-600">
                      {metrics.n_validation_runs} validation runs
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 365-Day Forecast Highlight */}
          {backtestData.horizons['365d'] && (
            <div className="alert alert-info shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <div>
                <h3 className="font-bold">365-Day Forecast Accuracy (Critical for Annual Planning)</h3>
                <div className="text-sm">
                  <p>
                    <strong>MAE:</strong> {backtestData.horizons['365d'].mean_mae.toFixed(6)}
                    {' '}({backtestData.horizons['365d'].interpretation.mae})
                  </p>
                  <p>
                    <strong>R²:</strong> {backtestData.horizons['365d'].mean_r2.toFixed(4)}
                    {' '}({backtestData.horizons['365d'].interpretation.r2})
                  </p>
                  {backtestData.horizons['365d'].interpretation.cleaning && (
                    <p>
                      <strong>Cleaning Recommendations:</strong> {backtestData.horizons['365d'].interpretation.cleaning}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'predictions' && selectedMetrics && predictions?.[selectedHorizon] && (
        <div className="space-y-6">
          {/* Horizon Selector */}
          <div className="flex gap-2">
            {Object.keys(backtestData.horizons).map((horizon) => (
              <button
                key={horizon}
                className={`btn btn-sm ${selectedHorizon === horizon ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setSelectedHorizon(horizon)}
              >
                {horizon.replace('d', ' Days')}
              </button>
            ))}
          </div>

          {/* Predictions vs Actuals Chart */}
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h3 className="card-title">Predictions vs Actuals - {selectedHorizon.replace('d', ' Days')} Forecast</h3>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={predictionChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="timestamp"
                    angle={-45}
                    textAnchor="end"
                    height={80}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0.75, 1.0]}
                    label={{ value: 'Soiling Ratio', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip
                    formatter={(value: number) => value.toFixed(4)}
                    contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
                  />
                  <Legend />
                  <ReferenceLine y={0.97} stroke="orange" strokeDasharray="3 3" label="Cleaning Threshold" />
                  <Line type="monotone" dataKey="actual" stroke="black" strokeWidth={2} name="Actual" dot={false} />
                  <Line type="monotone" dataKey="prediction" stroke="#3B82F6" strokeWidth={2} name="Predicted" dot={false} />
                </LineChart>
              </ResponsiveContainer>

              {/* Metrics Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                <div className="stat bg-base-200 rounded-lg">
                  <div className="stat-title text-xs">MAE</div>
                  <div className="stat-value text-lg">{selectedMetrics.mean_mae.toFixed(6)}</div>
                  <div className="stat-desc">±{selectedMetrics.std_mae.toFixed(6)}</div>
                </div>
                <div className="stat bg-base-200 rounded-lg">
                  <div className="stat-title text-xs">RMSE</div>
                  <div className="stat-value text-lg">{selectedMetrics.mean_rmse.toFixed(6)}</div>
                  <div className="stat-desc">±{selectedMetrics.std_rmse.toFixed(6)}</div>
                </div>
                <div className="stat bg-base-200 rounded-lg">
                  <div className="stat-title text-xs">R² Score</div>
                  <div className="stat-value text-lg">{selectedMetrics.mean_r2.toFixed(4)}</div>
                  <div className="stat-desc">±{selectedMetrics.std_r2.toFixed(4)}</div>
                </div>
                <div className="stat bg-base-200 rounded-lg">
                  <div className="stat-title text-xs">MAPE</div>
                  <div className="stat-value text-lg">{selectedMetrics.mean_mape.toFixed(2)}%</div>
                  <div className="stat-desc">±{selectedMetrics.std_mape.toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* Error Distribution */}
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h3 className="card-title">Prediction Error Distribution</h3>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={predictionChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="timestamp"
                    angle={-45}
                    textAnchor="end"
                    height={80}
                    interval="preserveStartEnd"
                  />
                  <YAxis label={{ value: 'Absolute Error', angle: -90, position: 'insideLeft' }} />
                  <Tooltip
                    formatter={(value: number) => value.toFixed(6)}
                    contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
                  />
                  <Area type="monotone" dataKey="error" stroke="#EF4444" fill="#EF4444" fillOpacity={0.3} name="Error" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'cleaning' && selectedMetrics && (
        <div className="space-y-6">
          {/* Horizon Selector */}
          <div className="flex gap-2">
            {Object.keys(backtestData.horizons).map((horizon) => (
              <button
                key={horizon}
                className={`btn btn-sm ${selectedHorizon === horizon ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setSelectedHorizon(horizon)}
              >
                {horizon.replace('d', ' Days')}
              </button>
            ))}
          </div>

          {/* Cleaning Recommendation Accuracy */}
          {selectedMetrics.mean_cleaning_precision !== undefined && selectedMetrics.mean_cleaning_recall !== undefined ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Precision */}
              <div className="card bg-gradient-to-br from-green-50 to-blue-50 dark:from-green-900/20 dark:to-blue-900/20 shadow-xl">
                <div className="card-body">
                  <h3 className="card-title text-lg">Precision</h3>
                  <div className="text-4xl font-bold text-green-600">
                    {(selectedMetrics.mean_cleaning_precision * 100).toFixed(1)}%
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    How many recommended cleanings were correct (within 7 days of actual cleaning)
                  </p>
                  <div className="mt-2">
                    <progress
                      className="progress progress-success w-full"
                      value={selectedMetrics.mean_cleaning_precision * 100}
                      max="100"
                    ></progress>
                  </div>
                </div>
              </div>

              {/* Recall */}
              <div className="card bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 shadow-xl">
                <div className="card-body">
                  <h3 className="card-title text-lg">Recall</h3>
                  <div className="text-4xl font-bold text-blue-600">
                    {(selectedMetrics.mean_cleaning_recall * 100).toFixed(1)}%
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    How many actual cleanings were predicted (within 7 days before event)
                  </p>
                  <div className="mt-2">
                    <progress
                      className="progress progress-info w-full"
                      value={selectedMetrics.mean_cleaning_recall * 100}
                      max="100"
                    ></progress>
                  </div>
                </div>
              </div>

              {/* F1-Score */}
              {cleaningF1Score !== null && (
                <div className="card bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 shadow-xl">
                  <div className="card-body">
                    <h3 className="card-title text-lg">F1-Score</h3>
                    <div className="text-4xl font-bold text-purple-600">
                      {(cleaningF1Score * 100).toFixed(1)}%
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Harmonic mean of precision and recall (overall accuracy)
                    </p>
                    <div className="mt-2">
                      <progress
                        className="progress progress-primary w-full"
                        value={cleaningF1Score * 100}
                        max="100"
                      ></progress>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="alert alert-warning">
              <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Cleaning recommendation accuracy data not available for this horizon.</span>
            </div>
          )}

          {/* Interpretation */}
          {selectedMetrics.interpretation.cleaning && (
            <div className="alert alert-info">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <div>
                <h3 className="font-bold">Interpretation</h3>
                <p className="text-sm">{selectedMetrics.interpretation.cleaning}</p>
              </div>
            </div>
          )}

          {/* Explanation */}
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <h3 className="card-title">Understanding Cleaning Recommendation Metrics</h3>
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-green-600">Precision</h4>
                  <p className="text-sm">
                    When the model recommends a cleaning (soiling ratio &lt; 0.97), how often does an actual cleaning occur within 7 days?
                    High precision means fewer false alarms.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-blue-600">Recall</h4>
                  <p className="text-sm">
                    When an actual cleaning occurs, how often did the model predict it within 7 days beforehand?
                    High recall means fewer missed cleaning needs.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-purple-600">F1-Score</h4>
                  <p className="text-sm">
                    The harmonic mean of precision and recall, providing a balanced measure of overall cleaning recommendation accuracy.
                    Target: F1 &gt; 80% for reliable cleaning planning.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
