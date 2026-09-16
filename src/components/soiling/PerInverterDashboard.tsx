'use client';

/**
 * Per-Inverter Soiling Dashboard
 * Main dashboard component with tabs for fleet overview and per-inverter analysis.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useSoilingData } from '@/hooks/useSoilingData';
import { FleetSummaryCard } from './FleetSummaryCard';
import { LossWaterfallChart } from './LossWaterfallChart';
import { ForecastChart } from './ForecastChart';
import type { InverterSoilingMetrics, ForecastResponse } from '@/types/soiling';
import { getSeverityColor } from '@/types/soiling';

interface PerInverterDashboardProps {
  plantId?: string;
}

export function PerInverterDashboard({ plantId = 'alpha1' }: PerInverterDashboardProps) {
  const {
    fleetSummary,
    fleetLoading,
    fleetError,
    inverterMetrics,
    fetchInverterData,
    inverterLoading,
    getInverterList,
    getGroupInverters,
  } = useSoilingData(plantId);

  const [activeTab, setActiveTab] = useState<'overview' | 'inverters'>('overview');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedInverter, setSelectedInverter] = useState<string | null>(null);
  const [inverterData, setInverterData] = useState<InverterSoilingMetrics | null>(null);
  const [forecastData, setForecastData] = useState<ForecastResponse | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);

  // Set default group when data loads
  useEffect(() => {
    if (fleetSummary && !selectedGroup) {
      const groups = fleetSummary.plantInfo.inverterGroups;
      if (groups.length > 0) {
        setSelectedGroup(groups[0]);
      }
    }
  }, [fleetSummary, selectedGroup]);

  // Fetch forecast data for overview tab
  useEffect(() => {
    const fetchForecast = async () => {
      setForecastLoading(true);
      try {
        const response = await fetch(`/api/soiling/plants/${plantId}/forecast?days=90`);
        if (response.ok) {
          const data = await response.json();
          setForecastData(data);
        }
      } catch (error) {
        console.error('Error fetching forecast:', error);
      } finally {
        setForecastLoading(false);
      }
    };

    fetchForecast();
  }, [plantId]);

  // Fetch inverter data when selected
  const handleInverterSelect = useCallback(
    async (inverterId: string) => {
      setSelectedInverter(inverterId);
      const data = await fetchInverterData(inverterId);
      setInverterData(data);
    },
    [fetchInverterData]
  );

  // Get inverters for current group
  const groupInverters = selectedGroup ? getGroupInverters(selectedGroup) : [];

  if (fleetError) {
    return (
      <div className="alert alert-error">
        <span>Error loading fleet data: {fleetError.message}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {fleetSummary?.plantInfo.plantName || 'Loading...'}
          </h1>
          <p className="text-sm text-base-content/60">
            Per-Inverter Soiling Analysis
          </p>
        </div>
        <div className="text-sm text-base-content/50">
          {fleetSummary && (
            <>
              Generated: {new Date(fleetSummary.generatedAt).toLocaleDateString()}
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs tabs-boxed bg-base-200">
        <button
          className={`tab ${activeTab === 'overview' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Fleet Overview
        </button>
        <button
          className={`tab ${activeTab === 'inverters' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('inverters')}
        >
          Per-Inverter Analysis
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Fleet Summary */}
          <FleetSummaryCard summary={fleetSummary} forecast={forecastData} loading={fleetLoading} />

          {/* Forecast Chart */}
          {forecastData && !forecastLoading && (
            <div className="card bg-base-200 shadow-sm">
              <div className="card-body p-5">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  90-Day Soiling Forecast
                </h3>
                <ForecastChart
                  forecast={forecastData.forecasts}
                  showConfidenceBands={true}
                  showCleaningEvents={false}
                  height={400}
                />
              </div>
            </div>
          )}

          {/* Loading State */}
          {forecastLoading && (
            <div className="card bg-base-200 shadow-sm">
              <div className="card-body p-5">
                <div className="flex items-center justify-center h-96">
                  <span className="loading loading-spinner loading-lg"></span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'inverters' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Inverter Selector */}
          <div className="card bg-base-200 shadow-sm lg:col-span-1">
            <div className="card-body p-4">
              <h3 className="card-title text-sm">Select Inverter</h3>

              {/* Group Selector */}
              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text text-xs">Group</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={selectedGroup || ''}
                  onChange={(e) => {
                    setSelectedGroup(e.target.value);
                    setSelectedInverter(null);
                    setInverterData(null);
                  }}
                >
                  {fleetSummary?.plantInfo.inverterGroups.map((group) => (
                    <option key={group} value={group}>
                      {group} ({fleetSummary.groupMetrics[group]?.inverterCount} inverters)
                    </option>
                  ))}
                </select>
              </div>

              {/* Inverter List */}
              <div className="mt-2 max-h-96 overflow-y-auto">
                <div className="space-y-1">
                  {groupInverters.map((invId) => {
                    const cached = inverterMetrics.get(invId);
                    return (
                      <button
                        key={invId}
                        className={`btn btn-sm btn-block justify-between ${
                          selectedInverter === invId ? 'btn-primary' : 'btn-ghost'
                        }`}
                        onClick={() => handleInverterSelect(invId)}
                      >
                        <span className="font-mono text-xs">{invId}</span>
                        {cached && (
                          <span
                            className="badge badge-xs"
                            style={{ backgroundColor: getSeverityColor(cached.fleetComparison.severity) }}
                          >
                            {(cached.soilingRatio.mean * 100).toFixed(1)}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Inverter Details */}
          <div className="lg:col-span-2 space-y-4">
            {/* Inverter Metrics Card */}
            {inverterData && (
              <div className="card bg-base-200 shadow-sm">
                <div className="card-body p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="card-title text-sm">{inverterData.inverterId}</h3>
                    <div
                      className="badge"
                      style={{ backgroundColor: getSeverityColor(inverterData.fleetComparison.severity) }}
                    >
                      {inverterData.fleetComparison.severity}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                    {/* SR Mean */}
                    <div>
                      <div className="text-xs text-base-content/60">SR Mean</div>
                      <div className="text-xl font-bold">
                        {(inverterData.soilingRatio.mean * 100).toFixed(1)}%
                      </div>
                    </div>

                    {/* Fleet Rank */}
                    <div>
                      <div className="text-xs text-base-content/60">Fleet Rank</div>
                      <div className="text-xl font-bold">
                        #{inverterData.fleetComparison.rank}
                        <span className="text-sm text-base-content/60">
                          /{fleetSummary?.plantInfo.totalInverters}
                        </span>
                      </div>
                    </div>

                    {/* Performance Ratio */}
                    <div>
                      <div className="text-xs text-base-content/60">Performance Ratio</div>
                      <div className="text-xl font-bold">
                        {(inverterData.performance.performanceRatio * 100).toFixed(1)}%
                      </div>
                    </div>

                    {/* Soiling Loss */}
                    <div>
                      <div className="text-xs text-base-content/60">Soiling Loss</div>
                      <div className="text-xl font-bold text-error">
                        {inverterData.lossDisaggregation.percentages.soiling.toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  {/* Detailed Metrics */}
                  <div className="divider my-2"></div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    <div>
                      <span className="text-base-content/60">Z-Score: </span>
                      <span className="font-mono">{inverterData.fleetComparison.zScore.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-base-content/60">Deviation: </span>
                      <span className="font-mono">
                        {inverterData.fleetComparison.deviationFromMean_pct > 0 ? '+' : ''}
                        {inverterData.fleetComparison.deviationFromMean_pct.toFixed(2)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-base-content/60">Availability: </span>
                      <span className="font-mono">{inverterData.performance.availability_pct.toFixed(0)}%</span>
                    </div>
                    <div>
                      <span className="text-base-content/60">Data Quality: </span>
                      <span className="font-mono">{inverterData.dataQuality.completeness_pct.toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Loss Waterfall Chart */}
            <LossWaterfallChart
              inverterData={inverterData}
              loading={inverterLoading}
              height={350}
            />

            {/* Loss Details Table */}
            {inverterData && (
              <div className="card bg-base-200 shadow-sm">
                <div className="card-body p-4">
                  <h3 className="card-title text-sm">Loss Breakdown (IEA PVPS T13)</h3>
                  <div className="overflow-x-auto">
                    <table className="table table-sm">
                      <thead>
                        <tr>
                          <th>Loss Category</th>
                          <th>Percentage</th>
                          <th>Energy (kWh)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(inverterData.lossDisaggregation.percentages).map(([key, value]) => {
                          if (key === 'total') return null;
                          const energyLoss = (inverterData.lossDisaggregation.energy_kWh.reference * value) / 100;
                          return (
                            <tr key={key}>
                              <td className="capitalize">{key.replace(/([A-Z])/g, ' $1')}</td>
                              <td className="font-mono">{value.toFixed(2)}%</td>
                              <td className="font-mono text-error">-{energyLoss.toFixed(0)}</td>
                            </tr>
                          );
                        })}
                        <tr className="font-bold border-t-2">
                          <td>Total Loss</td>
                          <td className="font-mono">
                            {inverterData.lossDisaggregation.percentages.total.toFixed(2)}%
                          </td>
                          <td className="font-mono text-error">
                            -{(inverterData.lossDisaggregation.energy_kWh.reference -
                              inverterData.lossDisaggregation.energy_kWh.net).toFixed(0)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PerInverterDashboard;
