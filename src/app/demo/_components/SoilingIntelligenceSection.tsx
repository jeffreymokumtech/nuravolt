'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { DataExplorerChart } from '@/components/soiling/DataExplorerChart';
import { SeasonalForecastChart } from '@/components/soiling/SeasonalForecastChart';
import ZoneAnalysisTab from '@/components/soiling/ZoneAnalysisTab';
import CleaningOptimizerTab from '@/components/soiling/CleaningOptimizerTab';
import { useDataRoot } from '@/contexts/DataSourceContext';
import type { PlantSummaryResponse, DataSourceType } from '@/types/soiling';

interface SeasonalForecast {
  metadata: {
    plant_id: string;
    generated_at: string;
    forecast_start: string;
    forecast_days: number;
    initial_sr: number;
    method: string;
    version: string;
  };
  backtest_validation: {
    years_tested: number[];
    avg_rmse: number | null;
    avg_mae: number | null;
    avg_r_squared: number | null;
  };
  forecast: Array<{
    date: string;
    sr_forecast: number;
    sr_lower_95: number;
    sr_upper_95: number;
    sr_seasonal_mean: number;
    rain_probability: number;
    rain_mm_expected: number;
    is_rain_event: boolean;
  }>;
  cleaning_recommendations: Array<{
    date: string;
    sr_at_cleaning: number;
    reason: string;
    // Only present on generator-produced recommendations — never invented
    // client-side for forecast-derived flags.
    expected_recovery?: number;
    priority?: string;
  }>;
}

interface MLForecast {
  metadata: {
    plant_id: string;
    forecast_period: { start: string; end: string };
    n_days: number;
    model_type: string;
    generated_at: string;
    model_version: string;
    is_cold_start?: boolean;
    input_window_days?: number;
  };
  forecasts: Array<{
    date: string;
    sr_predicted: number;
    soiling_loss_pct: number;
    is_cleaning_needed: boolean;
    sr_lower_bound: number;
    sr_upper_bound: number;
  }>;
}

function isColdStartModel(modelType: string | undefined): boolean {
  if (!modelType) return false;
  return modelType.startsWith('chronos2');
}

interface NormalizedForecastPoint {
  date: string;
  sr_forecast: number;
  sr_lower_95: number;
  sr_upper_95: number;
  rain_probability: number;
}

interface PlantMeta {
  name: string;
  capacityMW: number | null;
  hasDustIQ: boolean;
}

// Fallback availability for plants without a DB row (showcase fixtures).
const FIXTURE_DUSTIQ: Record<string, boolean> = {
  helios: false,
  zephyr: false,
  cold_start_demo: false,
};

// Display-name fallback when /api/plants returns nothing for a fixture plant.
const FIXTURE_PLANT_NAME: Record<string, string> = {
  cold_start_demo: 'New Plant (Cold-Start Demo)',
};

type TabId = 'overview' | 'explorer' | 'zones' | 'cleaning';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Data Explorer' },
  { id: 'zones', label: 'Zone Analysis' },
  { id: 'cleaning', label: 'Cleaning Optimizer' },
];

export default function SoilingIntelligenceSection() {
  const params = useParams();
  const plantId = (params.plantId as string) || 'alpha1';
  const dataRoot = useDataRoot();
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const [meta, setMeta] = useState<PlantMeta | null>(null);
  const [dataSource, setDataSource] = useState<DataSourceType>('ml_model');
  const [plantSummary, setPlantSummary] = useState<PlantSummaryResponse | null>(null);
  const [seasonalForecast, setSeasonalForecast] = useState<SeasonalForecast | null>(null);
  const [mlForecast, setMlForecast] = useState<MLForecast | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Plant metadata from the DB (name, capacity, sensor availability).
  useEffect(() => {
    let alive = true;
    fetch(`/api/plants/${plantId}`)
      .then(async (r) => (r.ok ? (await r.json()).data : null))
      .then((p) => {
        if (!alive) return;
        setMeta({
          name: p?.name ?? FIXTURE_PLANT_NAME[plantId] ?? plantId,
          capacityMW: p?.capacity_mw ? Number(p.capacity_mw) : null,
          hasDustIQ: p?.has_dustiq_sensor ?? FIXTURE_DUSTIQ[plantId] ?? false,
        });
      })
      .catch(
        () =>
          alive &&
          setMeta({
            name: FIXTURE_PLANT_NAME[plantId] ?? plantId,
            capacityMW: null,
            hasDustIQ: false,
          })
      );
    return () => {
      alive = false;
    };
  }, [plantId]);

  // Force ML model when the plant has no usable DustIQ sensor.
  useEffect(() => {
    if (meta && !meta.hasDustIQ) setDataSource('ml_model');
  }, [meta]);

  const normalizedForecast: NormalizedForecastPoint[] = React.useMemo(() => {
    if (dataSource === 'ml_model' && mlForecast) {
      return mlForecast.forecasts.map((f) => ({
        date: f.date,
        sr_forecast: f.sr_predicted,
        sr_lower_95: f.sr_lower_bound,
        sr_upper_95: f.sr_upper_bound,
        rain_probability: 0,
      }));
    }
    if (seasonalForecast) {
      return seasonalForecast.forecast.map((f) => ({
        date: f.date,
        sr_forecast: f.sr_forecast,
        sr_lower_95: f.sr_lower_95,
        sr_upper_95: f.sr_upper_95,
        rain_probability: f.rain_probability,
      }));
    }
    return [];
  }, [dataSource, mlForecast, seasonalForecast]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setSummaryLoading(true);
        setError(null);

        let summaryData: PlantSummaryResponse;
        if (dataSource === 'sensor') {
          const summaryRes = await fetch(`/api/soiling/plants/${plantId}/summary`);
          if (!summaryRes.ok) throw new Error('Failed to fetch sensor data');
          summaryData = await summaryRes.json();
        } else {
          const summaryRes = await fetch(`${dataRoot}/soiling/${plantId}/ml_plant_summary.json`);
          if (!summaryRes.ok) throw new Error('Failed to fetch ML data');
          summaryData = await summaryRes.json();
        }
        setPlantSummary(summaryData);
        setSummaryLoading(false);

        if (dataSource === 'ml_model') {
          const mlForecastRes = await fetch(`${dataRoot}/soiling/${plantId}/ml_forecast_365d.json`);
          if (mlForecastRes.ok) setMlForecast(await mlForecastRes.json());
        } else {
          const forecastRes = await fetch(`${dataRoot}/soiling/${plantId}/seasonal_forecast_365d.json`);
          if (forecastRes.ok) setSeasonalForecast(await forecastRes.json());
        }
        setForecastLoading(false);
      } catch (err) {
        console.error('Error fetching soiling intelligence data:', err);
        setError(`Failed to load ${dataSource} data. Please try again.`);
        setSummaryLoading(false);
        setForecastLoading(false);
      }
    };
    fetchData();
  }, [plantId, dataSource, dataRoot]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);

  const forecastWindow =
    normalizedForecast.length > 0
      ? {
          start: new Date(normalizedForecast[0].date),
          end: new Date(normalizedForecast[normalizedForecast.length - 1].date),
        }
      : null;

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Prefer generator-produced recommendations (real optimizer/climatology
  // output). Forecast-derived flags carry only what the forecast knows —
  // no invented recovery/priority constants.
  const cleaningRecs =
    seasonalForecast?.cleaning_recommendations?.length
      ? seasonalForecast.cleaning_recommendations
      : mlForecast
        ? mlForecast.forecasts
            .filter((f) => f.is_cleaning_needed)
            .map((f) => ({
              date: f.date,
              sr_at_cleaning: f.sr_predicted,
              reason: 'forecast SR below threshold',
            }))
        : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-ink">Soiling Intelligence</h2>
            <p className="text-ink-2 mt-1">
              Soiling forecasts, sensor data exploration and cleaning optimization
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-ink-2">Data source</label>
            <select
              value={dataSource}
              onChange={(e) => setDataSource(e.target.value as DataSourceType)}
              className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-ink-2 hover:border-blue-400 focus:border-blue-500 focus:outline-none"
            >
              <option value="sensor" disabled={!meta?.hasDustIQ}>
                DustIQ Sensor{!meta?.hasDustIQ ? ' (unavailable)' : ''}
              </option>
              <option value="ml_model">ML Model</option>
            </select>
          </div>
        </div>

        {meta && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span className="font-medium text-ink">
              {meta.name !== plantId
                ? meta.name
                : (plantSummary?.plantInfo?.plantName ?? plantId)}
            </span>
            {meta.capacityMW != null && (
              <>
                <span className="text-gray-300">•</span>
                <span>{meta.capacityMW} MW</span>
              </>
            )}
            {dataSource === 'ml_model' && mlForecast && (
              <>
                <span className="text-gray-300">•</span>
                <span>
                  {mlForecast.metadata.model_type} · {mlForecast.metadata.model_version}
                </span>
                <span className="text-gray-300">•</span>
                <span>
                  Forecast generated{' '}
                  {new Date(mlForecast.metadata.generated_at).toLocaleDateString()}
                </span>
                {(isColdStartModel(mlForecast.metadata.model_type) ||
                  mlForecast.metadata.is_cold_start) && (
                  <>
                    <span className="text-gray-300">•</span>
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.08em] text-violet-700"
                      title={
                        mlForecast.metadata.input_window_days != null
                          ? `Cold-start: only ${mlForecast.metadata.input_window_days} days of ground-truth history. The 95% prediction interval widens with horizon and narrows as DustIQ data accumulates (full LightGBM forecasts kick in at 90 days).`
                          : 'Cold-start forecast, the prediction interval widens with horizon and narrows as DustIQ data accumulates.'
                      }
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                      Cold-start forecast
                    </span>
                  </>
                )}
              </>
            )}
            {dataSource === 'ml_model' && plantSummary?.currentStatus?.validation && (
              <>
                <span className="text-gray-300">•</span>
                <span className="text-orange-600">
                  ML MAE {(plantSummary.currentStatus.validation.mae * 100).toFixed(2)}%
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-signal-critical/10 border border-signal-critical/20 rounded-xl p-4">
          <p className="text-signal-critical">{error}</p>
        </div>
      )}

      {/* KPI band */}
      {plantSummary && !summaryLoading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gradient-to-br from-blue-100 to-blue-50 border border-blue-200 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-ink-2 uppercase tracking-wide">
                Current Soiling Ratio
              </div>
              {dataSource === 'ml_model' && (
                <span className="inline-flex items-center text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                  ML
                </span>
              )}
            </div>
            <div className="text-3xl font-bold text-blue-700">
              {(plantSummary.currentStatus.avgSoilingRatio * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-ink-2 mt-1">
              {plantSummary.currentStatus.estimatedLossPct.toFixed(2)}% energy loss
            </div>
          </div>

          <div className="bg-gradient-to-br from-emerald-100 to-emerald-50 border border-signal-positive/20 rounded-xl p-5 shadow-sm">
            <div className="text-xs text-ink-2 uppercase tracking-wide mb-1">Fleet Health</div>
            <div className="text-3xl font-bold text-signal-positive">
              {plantSummary.fleetHealth.normalInverters}
            </div>
            <div className="text-xs text-ink-2 mt-1">
              {plantSummary.fleetHealth.minorIssues} minor, {plantSummary.fleetHealth.majorIssues}{' '}
              major, {plantSummary.fleetHealth.critical} critical
            </div>
          </div>

          <div className="bg-gradient-to-br from-orange-100 to-orange-50 border border-orange-200 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-ink-2 uppercase tracking-wide">YTD Energy Loss</div>
              {dataSource === 'ml_model' && (
                <span className="inline-flex items-center text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                  ML
                </span>
              )}
            </div>
            <div className="text-3xl font-bold text-orange-700">
              {plantSummary.economicImpact?.ytdEnergyLoss_MWh.toFixed(0) || 'N/A'} MWh
            </div>
            <div className="text-xs text-ink-2 mt-1">
              {plantSummary.economicImpact
                ? formatCurrency(plantSummary.economicImpact.ytdRevenueLoss_EUR)
                : 'N/A'}{' '}
              revenue loss
            </div>
          </div>
        </div>
      )}

      {summaryLoading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-paper-2 border border-divider rounded-xl p-5 h-32 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-divider pb-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-5 py-2.5 rounded-lg font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-blue-100 text-blue-700 border border-blue-300 shadow-sm'
                : 'bg-white text-ink-2 hover:bg-gray-50 border border-divider'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-6">
        {activeTab === 'overview' && (
          <>
            {forecastLoading && (
              <div className="bg-paper-2 border border-divider rounded-xl h-96 animate-pulse" />
            )}

            {normalizedForecast.length > 0 && !forecastLoading && forecastWindow && (
              <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-ink">30-Day Outlook</h2>
                    <span
                      className={`inline-flex items-center text-xs px-2 py-1 rounded-full font-medium ${
                        dataSource === 'ml_model'
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {dataSource === 'ml_model' ? 'ML Model' : 'DustIQ Sensor'}
                    </span>
                  </div>
                  <span className="text-sm text-ink-3">
                    First 30 days of the forecast window, from {fmtDate(forecastWindow.start)}
                  </span>
                </div>
                <SeasonalForecastChart
                  forecast={normalizedForecast.slice(0, 30).map((f) => ({
                    ...f,
                    day_of_year: 0,
                    month: 0,
                    month_name: '',
                    sr_seasonal_mean: f.sr_forecast,
                    rain_mm_expected: 0,
                    is_rain_event: f.rain_probability > 0.3,
                    monthly_soiling_rate: 0,
                  }))}
                  cleaningRecommendations={cleaningRecs.filter(
                    (c) => c.date <= normalizedForecast[29]?.date,
                  )}
                  height={320}
                />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-divider">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">
                      {(
                        (normalizedForecast.slice(0, 30).reduce((s, f) => s + f.sr_forecast, 0) /
                          30) *
                        100
                      ).toFixed(1)}
                      %
                    </div>
                    <div className="text-xs text-ink-3">Avg SR (30d)</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-600">
                      {(
                        Math.min(...normalizedForecast.slice(0, 30).map((f) => f.sr_forecast)) * 100
                      ).toFixed(1)}
                      %
                    </div>
                    <div className="text-xs text-ink-3">Min SR (30d)</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-cyan-600">
                      {dataSource === 'sensor'
                        ? normalizedForecast.slice(0, 30).filter((f) => f.rain_probability > 0.3)
                            .length
                        : ','}
                    </div>
                    <div className="text-xs text-ink-3">
                      Rain Days{dataSource === 'ml_model' ? ' (sensor only)' : ''}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-signal-positive">
                      {cleaningRecs.filter((c) => c.date <= normalizedForecast[29]?.date).length}
                    </div>
                    <div className="text-xs text-ink-3">Cleanings Rec.</div>
                  </div>
                </div>
              </div>
            )}

            {normalizedForecast.length > 0 && !forecastLoading && forecastWindow && (
              <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h2 className="text-lg font-semibold text-ink">Full-Year Forecast</h2>
                  <span className="text-sm text-ink-3">
                    {fmtDate(forecastWindow.start)}, {fmtDate(forecastWindow.end)}
                  </span>
                </div>
                <SeasonalForecastChart
                  forecast={normalizedForecast.map((f) => ({
                    ...f,
                    day_of_year: 0,
                    month: 0,
                    month_name: '',
                    sr_seasonal_mean: f.sr_forecast,
                    rain_mm_expected: 0,
                    is_rain_event: f.rain_probability > 0.3,
                    monthly_soiling_rate: 0,
                  }))}
                  cleaningRecommendations={cleaningRecs}
                  height={300}
                  showSeasonalMean={dataSource === 'sensor'}
                />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-divider">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">
                      {(
                        (normalizedForecast.reduce((s, f) => s + f.sr_forecast, 0) /
                          normalizedForecast.length) *
                        100
                      ).toFixed(1)}
                      %
                    </div>
                    <div className="text-xs text-ink-3">Annual Avg SR</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-signal-positive">{cleaningRecs.length}</div>
                    <div className="text-xs text-ink-3">Cleanings/Year (suggested)</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-purple-600 capitalize">
                      {dataSource === 'sensor' && seasonalForecast
                        ? seasonalForecast.metadata.method.replace('_', ' ')
                        : mlForecast
                          ? (mlForecast.metadata?.model_type ?? 'unknown').replace(/_/g, ' ')
                          : '—'}
                    </div>
                    <div className="text-xs text-ink-3">Forecast Method</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-600">
                      {dataSource === 'sensor' && seasonalForecast
                        ? (seasonalForecast.backtest_validation.avg_rmse?.toFixed(3) ?? ',')
                        : (
                            (1 -
                              normalizedForecast.reduce((s, f) => s + f.sr_forecast, 0) /
                                normalizedForecast.length) *
                            100
                          ).toFixed(1) + '%'}
                    </div>
                    <div className="text-xs text-ink-3">
                      {dataSource === 'sensor' ? 'Model RMSE' : 'Avg Soiling Loss'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'explorer' && (
          <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
            <h2 className="text-lg font-semibold text-ink mb-1">Data Explorer</h2>
            <p className="text-sm text-ink-2 mb-6">
              Precipitation, dust, soiling ratio, soiling rate and performance ratio. Use the brush
              at the bottom to zoom into specific date ranges.
            </p>
            <DataExplorerChart plantId={plantId} height={600} />
          </div>
        )}

        {activeTab === 'zones' && <ZoneAnalysisTab plantId={plantId} />}

        {activeTab === 'cleaning' && <CleaningOptimizerTab plantId={plantId} />}
      </div>
    </div>
  );
}
