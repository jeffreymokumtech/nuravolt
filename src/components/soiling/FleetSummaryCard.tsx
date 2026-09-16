'use client';

/**
 * Fleet Summary Card Component
 * Displays KPIs and health distribution for the solar plant fleet.
 * Extended with forecast section for predictive insights.
 */

import React from 'react';
import { 
  Activity, 
  ShieldCheck, 
  TrendingDown, 
  Info, 
  Sparkles, 
  Lightbulb, 
  Zap, 
  BarChart3, 
  Target, 
  Calendar,
  LayoutDashboard,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp
} from 'lucide-react';
import type { FleetSummary, ForecastResponse } from '@/types/soiling';
import { getHealthPercentage, SEVERITY_COLORS } from '@/types/soiling';

interface FleetSummaryCardProps {
  summary: FleetSummary | null;
  forecast?: ForecastResponse | null;
  loading?: boolean;
}

export function FleetSummaryCard({ summary, forecast, loading }: FleetSummaryCardProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="card bg-base-200 animate-pulse h-32" />
        ))}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="alert alert-info">
        <span>No fleet data available. Run the per-inverter analysis first.</span>
      </div>
    );
  }

  const healthPct = getHealthPercentage(summary.healthDistribution);
  const {
    plantInfo,
    fleetSoiling,
    fleetLosses,
    healthDistribution,
    economicImpact,
    analysisPeriod,
  } = summary;

  return (
    <div className="space-y-6">
      {/* Main KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Fleet SR */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 hover:border-blue-200 transition-colors group">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Fleet Soiling Ratio</span>
            <Activity className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500" />
          </div>
          <div className="text-3xl font-black text-gray-900">
            {(fleetSoiling.srMean * 100).toFixed(1)}%
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs font-bold text-gray-400">&plusmn; {(fleetSoiling.srStd * 100).toFixed(2)}% std</span>
          </div>
        </div>

        {/* Fleet Health */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 hover:border-emerald-200 transition-colors group">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">System Integrity</span>
            <ShieldCheck className="w-3.5 h-3.5 text-gray-300 group-hover:text-emerald-500" />
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className="text-3xl font-black"
              style={{ color: healthPct >= 90 ? SEVERITY_COLORS.Normal : SEVERITY_COLORS.Minor }}
            >
              {healthPct}%
            </span>
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Optimized</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            <span className="px-1.5 py-0.5 bg-green-50 text-green-700 text-[9px] font-black uppercase rounded border border-green-100">
              {healthDistribution.normal} OK
            </span>
            {healthDistribution.minorIssues > 0 && (
              <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 text-[9px] font-black uppercase rounded border border-amber-100">
                {healthDistribution.minorIssues} Minor
              </span>
            )}
          </div>
        </div>

        {/* Annual Soiling Loss */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 hover:border-red-200 transition-colors group">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Est. Annual Yield Loss</span>
            <TrendingDown className="w-3.5 h-3.5 text-gray-300 group-hover:text-red-500" />
          </div>
          <div className="text-3xl font-black text-red-600">
            €{economicImpact.estimatedAnnualLoss_EUR.toLocaleString()}
          </div>
          <div className="text-xs font-bold text-gray-400 mt-2">
            {fleetLosses.totalSoilingLoss_MWh.toFixed(1)} MWh projected loss
          </div>
        </div>

        {/* Plant Info */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 hover:border-blue-200 transition-colors group">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest truncate">{plantInfo.plantName}</span>
            <LayoutDashboard className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500" />
          </div>
          <div className="text-3xl font-black text-gray-900">
            {plantInfo.totalInverters}
          </div>
          <div className="text-xs font-bold text-gray-400 mt-2 uppercase tracking-widest">
            Inverters • {plantInfo.capacity_MW} MW
          </div>
        </div>
      </div>

      {/* Forecast Section */}
      {forecast && (
        <div className="bg-white rounded-3xl border-2 border-blue-500/20 shadow-xl overflow-hidden">
          <div className="px-6 py-5 bg-blue-50/50 border-b border-blue-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-600 rounded-xl shadow-lg shadow-blue-100">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-lg font-black text-gray-900 tracking-tight">Soiling Forecast Engine</h3>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest bg-blue-100 px-1.5 py-0.5 rounded">
                    {forecast.modelInfo.type} v{forecast.modelInfo.version}
                  </span>
                </div>
              </div>
            </div>
            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest bg-white border border-gray-200 px-3 py-1.5 rounded-xl shadow-sm">
              Last Training: {new Date(forecast.modelInfo.lastTrainedAt).toLocaleDateString()}
            </div>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 relative group overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform">
                  <Target className="w-12 h-12 text-gray-900" />
                </div>
                <div className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2">7-Day Target</div>
                <div className="text-2xl font-black text-blue-600">
                  {(forecast.forecasts.slice(0, 7).reduce((sum, f) => sum + f.soilingRatio, 0) / 7 * 100).toFixed(1)}%
                </div>
                <div className="text-[9px] font-bold text-gray-400 uppercase mt-1">Avg ratio projection</div>
              </div>

              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 relative group overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform">
                  <Calendar className="w-12 h-12 text-gray-900" />
                </div>
                <div className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2">30-Day Outlook</div>
                <div className="text-2xl font-black text-purple-600">
                  {(forecast.forecasts.slice(0, 30).reduce((sum, f) => sum + f.soilingRatio, 0) / 30 * 100).toFixed(1)}%
                </div>
                <div className="text-[9px] font-bold text-gray-400 uppercase mt-1">Long-range trend</div>
              </div>

              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 relative group overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform">
                  <TrendingDown className="w-12 h-12 text-gray-900" />
                </div>
                <div className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2">Predicted Yield Loss</div>
                <div className="text-2xl font-black text-orange-600">
                  {forecast.statistics.meanLossPct.toFixed(2)}%
                </div>
                <div className="text-[9px] font-bold text-gray-400 uppercase mt-1">Weighted period average</div>
              </div>

              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 relative group overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform">
                  <Zap className="w-12 h-12 text-gray-900" />
                </div>
                <div className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2">Maintenance Req.</div>
                <div className="text-2xl font-black text-emerald-600">
                  {forecast.statistics.cleaningsRecommended}
                </div>
                <div className="text-[9px] font-bold text-gray-400 uppercase mt-1">Recommended cycles</div>
              </div>
            </div>

            <div className="mt-6 bg-blue-600 rounded-2xl p-5 text-white shadow-lg shadow-blue-100 relative overflow-hidden flex items-start gap-4 group">
              <div className="p-2 bg-blue-500 rounded-xl">
                <Lightbulb className="w-5 h-5 text-white" />
              </div>
              <div>
                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] opacity-70 mb-1">Strategic Insight</h4>
                <p className="text-sm font-bold leading-relaxed">
                  {forecast.statistics.cleaningsRecommended > 0 ? (
                    <>Based on current soiling kinetics, {forecast.statistics.cleaningsRecommended} cleaning operation{forecast.statistics.cleaningsRecommended > 1 ? 's are' : ' is'} recommended within the next {forecast.forecastPeriod.days} days to prevent yield degradation.</>
                  ) : (
                    <>Current particulate accumulation is within nominal parameters. No immediate intervention required for the 30-day horizon.</>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group Performance Table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
          <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-600" />
            Segmented Fleet Performance
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-6 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Asset Group</th>
                <th className="px-6 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center">Unit Count</th>
                <th className="px-6 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest text-right">SR Mean</th>
                <th className="px-6 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest text-right">SR Variance</th>
                <th className="px-6 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest text-right">Health Index</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {Object.entries(summary.groupMetrics).map(([groupId, metrics]) => (
                <tr key={groupId} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4 font-black text-gray-900 text-sm">{groupId}</td>
                  <td className="px-6 py-4 text-center text-sm font-bold text-gray-500">{metrics.inverterCount}</td>
                  <td className="px-6 py-4 text-right text-sm font-black text-blue-600">{(metrics.srMean * 100).toFixed(1)}%</td>
                  <td className="px-6 py-4 text-right text-xs font-bold text-gray-400">{(metrics.srStd * 100).toFixed(2)}%</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-3">
                      <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-emerald-500 rounded-full" 
                          style={{ width: `${metrics.healthScore}%` }}
                        />
                      </div>
                      <span className="text-xs font-black text-gray-900">{metrics.healthScore.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top & Worst Performers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top Performers */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 bg-emerald-50/50 border-b border-emerald-100 flex items-center justify-between">
            <h3 className="text-[10px] font-black text-emerald-700 uppercase tracking-widest flex items-center gap-2">
              <ArrowUpRight className="w-4 h-4" /> High Yield Assets
            </h3>
          </div>
          <div className="p-4 space-y-2">
            {summary.topPerformers.map((inv) => (
              <div key={inv.inverterId} className="flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100 group hover:border-emerald-200 transition-colors">
                <span className="font-mono text-xs font-bold text-gray-600">{inv.inverterId}</span>
                <span className="px-3 py-1 bg-white border border-emerald-100 text-emerald-600 text-xs font-black rounded-lg shadow-sm">
                  {(inv.srMean * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Worst Performers */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 bg-red-50/50 border-b border-red-100 flex items-center justify-between">
            <h3 className="text-[10px] font-black text-red-700 uppercase tracking-widest flex items-center gap-2">
              <ArrowDownRight className="w-4 h-4" /> Efficiency Deficit Assets
            </h3>
          </div>
          <div className="p-4 space-y-2">
            {summary.worstPerformers.map((inv) => (
              <div key={inv.inverterId} className="flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100 group hover:border-red-200 transition-colors">
                <span className="font-mono text-xs font-bold text-gray-600">{inv.inverterId}</span>
                <span className="px-3 py-1 bg-white border border-red-100 text-red-600 text-xs font-black rounded-lg shadow-sm">
                  {(inv.srMean * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default FleetSummaryCard;
