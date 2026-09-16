'use client';

import React from 'react';
import { Cpu, AlertTriangle, LineChart, CheckCircle, Info, Sparkles } from 'lucide-react';

interface ModelMetrics {
  model: string;
  mae_train: number;
  mae_test: number;
  rmse_train: number;
  rmse_test: number;
  r2_train: number;
  r2_test: number;
  best_iteration: number;
}

interface ModelPerformanceCardProps {
  models: ModelMetrics[];
  plantId?: string;
  className?: string;
}

/**
 * ModelPerformanceCard - Display ML model performance comparison
 *
 * Features:
 * - Side-by-side model comparison
 * - Training vs test metrics
 * - Performance indicators (MAE, RMSE, R²)
 * - Best model highlighting
 * - Overfitting detection
 */
export function ModelPerformanceCard({
  models,
  plantId,
  className = '',
}: ModelPerformanceCardProps) {
  // Find best model based on test R²
  const bestModelIndex = models.reduce((bestIdx, model, idx) => {
    return model.r2_test > models[bestIdx].r2_test ? idx : bestIdx;
  }, 0);

  const formatMetric = (value: number, decimals: number = 4) => {
    return value.toFixed(decimals);
  };

  const getR2Color = (r2: number) => {
    if (r2 >= 0.8) return 'text-green-600';
    if (r2 >= 0.6) return 'text-blue-600';
    if (r2 >= 0.4) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getR2Badge = (r2: number) => {
    if (r2 >= 0.8) return 'bg-green-100 text-green-800';
    if (r2 >= 0.6) return 'bg-blue-100 text-blue-800';
    if (r2 >= 0.4) return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
  };

  const detectOverfitting = (model: ModelMetrics): string | null => {
    const trainTestGap = model.r2_train - model.r2_test;
    if (trainTestGap > 0.3) return 'High overfitting';
    if (trainTestGap > 0.15) return 'Moderate overfitting';
    return null;
  };

  return (
    <div className={className}>
      <div className="bg-white rounded-3xl border border-gray-200 overflow-hidden shadow-sm">
        {/* Header */}
        <div className="px-8 py-6 bg-gray-50 border-b border-gray-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-black text-gray-900 tracking-tight flex items-center gap-3">
              <Cpu className="w-6 h-6 text-blue-600" />
              Model Performance Comparison
            </h3>
            {plantId && (
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] mt-1 ml-9">Inference Node: {plantId}</p>
            )}
          </div>
        </div>

        {/* Model Cards */}
        <div className="p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {models.map((model, idx) => {
              const isBest = idx === bestModelIndex;
              const overfitting = detectOverfitting(model);

              return (
                <div
                  key={idx}
                  className={`relative rounded-3xl border-2 p-6 transition-all duration-300 ${
                    isBest
                      ? 'border-blue-500 bg-blue-50/30 shadow-lg shadow-blue-100/50'
                      : 'border-gray-100 bg-white hover:border-gray-200'
                  }`}
                >
                  {/* Best Model Badge */}
                  {isBest && (
                    <div className="absolute top-0 right-0 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-bl-2xl shadow-md">
                      Top Performer
                    </div>
                  )}

                  {/* Model Name */}
                  <div className="flex items-center gap-3 mb-1">
                    <h4 className="text-xl font-black text-gray-900 tracking-tight">
                      {model.model}
                    </h4>
                    {isBest && <Sparkles className="w-4 h-4 text-blue-500" />}
                  </div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-6">
                    Convergence Iteration: <span className="text-gray-900 font-black">{model.best_iteration}</span>
                  </p>

                  {/* Overfitting Warning */}
                  {overfitting && (
                    <div className="mb-6 bg-amber-50 border-2 border-amber-100 rounded-2xl p-4 animate-in fade-in zoom-in-95">
                      <div className="text-xs font-black text-amber-800 uppercase tracking-wider flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600" /> 
                        {overfitting} Detected
                      </div>
                      <p className="text-xs text-amber-700 font-medium mt-1">
                        Train R² ({formatMetric(model.r2_train, 3)}) vs Test R² ({formatMetric(model.r2_test, 3)})
                      </p>
                    </div>
                  )}

                  {/* Metrics Grid */}
                  <div className="space-y-6">
                    {/* R² Score - Primary Metric */}
                    <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm relative overflow-hidden">
                      <div className="absolute top-0 right-0 p-4 opacity-5">
                        <LineChart className="w-12 h-12 text-gray-900" />
                      </div>
                      <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-4">
                        R² Score Accuracy
                      </div>
                      <div className="grid grid-cols-2 gap-6 relative z-10">
                        <div>
                          <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">Training</div>
                          <div className={`text-2xl font-black ${getR2Color(model.r2_train)}`}>
                            {formatMetric(model.r2_train, 3)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold text-gray-400 uppercase mb-1 text-right">Testing</div>
                          <div className={`text-2xl font-black text-right ${getR2Color(model.r2_test)}`}>
                            {formatMetric(model.r2_test, 3)}
                          </div>
                          <div className="flex justify-end mt-1">
                            <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-tighter rounded border ${getR2Badge(model.r2_test)}`}>
                              {model.r2_test >= 0.8 ? 'Excellent' : model.r2_test >= 0.6 ? 'Optimized' : model.r2_test >= 0.4 ? 'Stable' : 'Unstable'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Secondary Error Metrics */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                        <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-3">MAE Error</div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-gray-400 font-bold uppercase">Train</span>
                            <span className="font-black text-gray-900">{formatMetric(model.mae_train)}</span>
                          </div>
                          <div className="flex justify-between text-[10px]">
                            <span className="text-gray-400 font-bold uppercase">Test</span>
                            <span className="font-black text-blue-600">{formatMetric(model.mae_test)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                        <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-3">RMSE Variance</div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px]">
                            <span className="text-gray-400 font-bold uppercase">Train</span>
                            <span className="font-black text-gray-900">{formatMetric(model.rmse_train)}</span>
                          </div>
                          <div className="flex justify-between text-[10px]">
                            <span className="text-gray-400 font-bold uppercase">Test</span>
                            <span className="font-black text-blue-600">{formatMetric(model.rmse_test)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Performance Insights */}
          {models.length > 1 && (
            <div className="mt-8 bg-gray-900 rounded-3xl p-6 text-white shadow-2xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-110 transition-transform duration-500">
                <Info className="w-24 h-24" />
              </div>
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-2 bg-blue-600 rounded-xl">
                    <LineChart className="w-5 h-5 text-white" />
                  </div>
                  <h4 className="text-sm font-black uppercase tracking-[0.2em]">Diagnostic Intelligence</h4>
                </div>
                
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <li className="flex items-start gap-3 bg-white/5 p-3 rounded-xl border border-white/10">
                    <CheckCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                    <span className="text-xs font-medium text-gray-300">
                      Dominant architecture: <strong className="text-white">{models[bestModelIndex].model}</strong> with{' '}
                      <span className="text-blue-400 font-black">{formatMetric(models[bestModelIndex].r2_test, 3)} accuracy</span>
                    </span>
                  </li>
                  <li className="flex items-start gap-3 bg-white/5 p-3 rounded-xl border border-white/10">
                    <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                    <span className="text-xs font-medium text-gray-300">
                      Standardized metrics: R² target is 1.0. Convergence observed in {models[bestModelIndex].best_iteration} passes.
                    </span>
                  </li>
                  {models.some(m => detectOverfitting(m)) && (
                    <li className="flex items-start gap-3 bg-amber-500/10 p-3 rounded-xl border border-amber-500/20 col-span-1 md:col-span-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                      <span className="text-xs font-medium text-amber-200">
                        Yield variance detected: Minor overfitting in secondary architectures suggests need for higher-regularization telemetry.
                      </span>
                    </li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
