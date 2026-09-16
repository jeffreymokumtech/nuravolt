/**
 * DataExplorerChart - Raw time series visualization for threshold determination
 *
 * Multi-panel stacked chart showing:
 * - Panel 1: Precipitation (mm) - On-site vs Open-Meteo comparison
 * - Panel 2: Dust/PM (μg/m³) - PM10, PM2.5, Saharan dust
 * - Panel 3: Soiling Ratio (0-1) - ML predictions and DustIQ sensor (when available)
 * - Panel 4: Performance Ratio - Per inverter with selector
 *
 * Features:
 * - Inverter dropdown selector
 * - No threshold coloring - raw values only
 * - Shared time axis with brush for date range selection
 * - Tooltips showing exact values
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Brush,
  Legend,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

// Types for the data
interface RainDataPoint {
  date: string;
  precipitation_mm: number;
}

interface SoilingRatioDataPoint {
  date: string;
  inverterId: string;
  sr: number;
}

interface PRDataPoint {
  date: string;
  inverterId: string;
  pr: number;
}

interface DustDataPoint {
  date: string;
  pm10: number | null;
  pm2_5: number | null;
  dust: number | null;
}

interface CAMSAODDataPoint {
  date: string;  // Daily format: "YYYY-MM-DD" (merged CAMS EAC4 + Open-Meteo)
  aod_550nm: number | null;
}

interface DustIQDataPoint {
  date: string;
  sr_dustiq: number | null;
  sr_sensor1: number | null;
  sr_sensor2: number | null;
}

interface MLPredictionDataPoint {
  date: string;
  sr_ml: number | null;
}

interface TransferPredictionDataPoint {
  date: string;
  sr_transfer: number | null;
}

// Transfer features data structure
interface TransferFeaturesData {
  metadata: {
    plant_id: string;
    total_features: number;
    total_days: number;
    climate: string;
    is_coastal: boolean;
  };
  feature_groups: Record<string, string[]>;
  daily_data: Array<Record<string, number | string | null>>;
}

interface ChartDataPoint {
  date: string;
  dateFormatted: string;
  precipOnsite: number | null;
  precipOpenMeteo: number | null;
  pm10: number | null;
  pm2_5: number | null;
  dust: number | null;
  aod: number | null;                 // AOD 550nm (CAMS EAC4 + Open-Meteo merged)
  srML: number | null;                // ML-based SR prediction
  srTransfer: number | null;          // Transfer-learned SR (e.g. Ribera → target plant)
  srDustIQ: number | null;            // DustIQ sensor SR (direct)
  soilingRateML: number | null;           // Rate from ML method
  soilingRateDustIQ: number | null;       // Rate from DustIQ sensor
  pr: number | null;
  // Transfer features (enhanced data)
  rainfall_7d: number | null;
  rainfall_30d: number | null;
  days_since_rain: number | null;
  humidity: number | null;
  humidity_mean_7d: number | null;
  wind_speed: number | null;
  wind_mean_7d: number | null;
  temperature: number | null;
  temperature_mean_7d: number | null;
  sea_salt_aod: number | null;
  sea_salt_aod_mean_7d: number | null;
  organic_aod: number | null;
  sulphate_aod: number | null;
  dust_aod: number | null;
  dust_aod_mean_7d: number | null;
  snowfall: number | null;
  snowfall_7d: number | null;
}

// Error metrics for model validation
interface ValidationMetrics {
  rmse: number;
  mae: number;
  bias: number;
  correlation: number;
  count: number;
}

interface DataExplorerChartProps {
  plantId: string;
  height?: number;
  dateRange?: { start: string; end: string };
}

// Panel heights for better visibility
const PANEL_HEIGHT = 220; // Each panel is 220px tall for better readability

export function DataExplorerChart({
  plantId,
  height = 1100,
  dateRange,
}: DataExplorerChartProps) {
  // Data state
  const [rainDataOnsite, setRainDataOnsite] = useState<RainDataPoint[]>([]);
  const [rainDataOpenMeteo, setRainDataOpenMeteo] = useState<RainDataPoint[]>([]);
  const [dustData, setDustData] = useState<DustDataPoint[]>([]);
  const [camsAodData, setCAMSAodData] = useState<CAMSAODDataPoint[]>([]);
  const [dustIQData, setDustIQData] = useState<DustIQDataPoint[]>([]);
  const [mlPredData, setMlPredData] = useState<MLPredictionDataPoint[]>([]);
  const [transferPredData, setTransferPredData] = useState<TransferPredictionDataPoint[]>([]);
  const [prData, setPrData] = useState<PRDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDust, setShowDust] = useState(true);
  const [showSoilingRate, setShowSoilingRate] = useState(true);
  const [showTransfer, setShowTransfer] = useState(true);

  // Transfer features state
  const [transferFeatures, setTransferFeatures] = useState<TransferFeaturesData | null>(null);
  const [showWeather, setShowWeather] = useState(true);
  const [showSeaSalt, setShowSeaSalt] = useState(true);
  const [showHumidityWind, setShowHumidityWind] = useState(false);

  // Inverter selection
  const [availableInverters, setAvailableInverters] = useState<string[]>([]);
  const [selectedInverter, setSelectedInverter] = useState<string>('');
  const dataRoot = useDataRoot();
  const routePrefix = usePlantRoutePrefix();

  // Load all data on mount
  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      setError(null);

      // On /dashboard the per-stream fixtures don't exist for a real plant;
      // read the consolidated (synthesized/labeled) streams artifact instead.
      if (routePrefix === '/dashboard') {
        try {
          const res = await fetch(`/api/soiling/plants/${plantId}/streams`);
          const s = res.ok ? await res.json() : null;
          if (s?.available) {
            setRainDataOnsite(s.rain_onsite ?? []);
            setRainDataOpenMeteo(s.rain_openmeteo ?? []);
            setDustData(s.dust ?? []);
            setCAMSAodData(s.aod ?? []);
            setDustIQData(s.dustiq ?? []);
            setMlPredData(s.ml_sr ?? []);
            setTransferPredData(s.transfer_sr ?? []);
            setPrData(s.pr ?? []);
            const invs = Array.from(new Set((s.pr ?? []).map((d: PRDataPoint) => d.inverterId))).sort() as string[];
            setAvailableInverters(invs);
            if (invs.length > 0) setSelectedInverter((cur) => cur || invs[0]);
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setIsLoading(false);
        }
        return;
      }

      try {
        // Load on-site rain history
        const rainOnsiteRes = await fetch(`${dataRoot}/soiling/${plantId}/rain_history_onsite.json`);
        if (rainOnsiteRes.ok) {
          const rainJson = await rainOnsiteRes.json();
          setRainDataOnsite(rainJson.daily_data || []);
        }

        // Load Open-Meteo rain history
        const rainOpenMeteoRes = await fetch(`${dataRoot}/soiling/${plantId}/rain_history.json`);
        if (rainOpenMeteoRes.ok) {
          const rainJson = await rainOpenMeteoRes.json();
          setRainDataOpenMeteo(rainJson.daily_data || []);
        }

        // Load PR data and extract inverter list from it
        const prRes = await fetch(`${dataRoot}/soiling/${plantId}/time_series/daily_pr.json`);
        if (prRes.ok) {
          const prJson = await prRes.json();
          setPrData(prJson.data || []);

          // Extract unique inverters from PR data (which has per-inverter breakdown)
          const inverterSet = new Set<string>((prJson.data || []).map((d: PRDataPoint) => d.inverterId));
          const inverters = Array.from(inverterSet).sort();
          setAvailableInverters(inverters);
          if (inverters.length > 0 && !selectedInverter) {
            setSelectedInverter(inverters[0]);
          }
        }

        // Load dust data - try multiple file formats
        // Format 1 (old): dust_history.json with { daily_data: [{ date, pm10, pm2_5, dust }] }
        // Format 2 (new): aod_history.json with { daily_data: [{ date, pm10_mean, pm2p5_mean, dust_mean }] }
        let dustLoaded = false;
        const dustRes = await fetch(`${dataRoot}/soiling/${plantId}/dust_history.json`);
        if (dustRes.ok) {
          const dustJson = await dustRes.json();
          setDustData(dustJson.daily_data || []);
          dustLoaded = true;
        }

        // Fallback to aod_history.json (new format with different field names)
        if (!dustLoaded) {
          const aodHistoryRes = await fetch(`${dataRoot}/soiling/${plantId}/aod_history.json`);
          if (aodHistoryRes.ok) {
            const aodHistoryJson = await aodHistoryRes.json();
            // Map from new format to expected format
            const dustData = (aodHistoryJson.daily_data || []).map((d: {
              date: string;
              pm10_mean?: number;
              pm2p5_mean?: number;
              dust_mean?: number;
            }) => ({
              date: d.date,
              pm10: d.pm10_mean ?? null,
              pm2_5: d.pm2p5_mean ?? null,
              dust: d.dust_mean ?? null,
            }));
            setDustData(dustData);
          }
        }

        // Load merged AOD data - try multiple file formats
        // Format 1 (old): aod_merged.json with { daily_data: [{ date, aod_550nm }] }
        // Format 2 (new): cams_aod_history.json with { data: [{ timestamp, aod_550nm }] }
        let aodLoaded = false;
        const aodRes = await fetch(`${dataRoot}/soiling/${plantId}/aod_merged.json`);
        if (aodRes.ok) {
          const aodJson = await aodRes.json();
          setCAMSAodData(aodJson.daily_data || []);
          aodLoaded = true;
        }

        // Fallback to cams_aod_history.json (new format)
        if (!aodLoaded) {
          const camsRes = await fetch(`${dataRoot}/soiling/${plantId}/cams_aod_history.json`);
          if (camsRes.ok) {
            const camsJson = await camsRes.json();
            // Map from new format (data array with timestamp) to expected format
            const aodData = (camsJson.data || []).map((d: {
              timestamp: string;
              aod_550nm?: number;
            }) => ({
              date: d.timestamp,
              aod_550nm: d.aod_550nm ?? null,
            }));
            setCAMSAodData(aodData);
          }
        }

        // Load DustIQ sensor data
        const dustIQRes = await fetch(`${dataRoot}/soiling/${plantId}/dustiq_history.json`);
        if (dustIQRes.ok) {
          const dustIQJson = await dustIQRes.json();
          setDustIQData(dustIQJson.daily_data || []);
        }

        // Load ML-based SR predictions
        const mlPredRes = await fetch(`${dataRoot}/soiling/${plantId}/ml_sr_predictions.json`);
        if (mlPredRes.ok) {
          const mlPredJson = await mlPredRes.json();
          setMlPredData(mlPredJson.daily_data || []);
        }

        // Load transfer-learned SR predictions (optional).
        // Expected format: { daily_data: [{ date: 'YYYY-MM-DD', sr_transfer: number|null }, ...] }
        const transferRes = await fetch(`${dataRoot}/soiling/${plantId}/transfer_sr_predictions.json`);
        if (transferRes.ok) {
          const transferJson = await transferRes.json();
          setTransferPredData(transferJson.daily_data || []);
        } else {
          setTransferPredData([]);
        }

        // Load transfer features (enhanced feature set for all weather/environmental data)
        const transferFeaturesRes = await fetch(`${dataRoot}/soiling/${plantId}/transfer_features.json`);
        if (transferFeaturesRes.ok) {
          const tfJson = await transferFeaturesRes.json();
          setTransferFeatures(tfJson);
        }

      } catch (err) {
        console.error('Error loading data:', err);
        setError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [plantId, routePrefix]);

  // Create lookup maps for SR and PR by date+inverter
  const prMap = useMemo(() => {
    const map = new Map<string, number>();
    prData.forEach(d => {
      map.set(`${d.date}|${d.inverterId}`, d.pr);
    });
    return map;
  }, [prData]);

  // Create dust lookup (recent data from Open-Meteo)
  const dustMap = useMemo(() => {
    const map = new Map<string, DustDataPoint>();
    dustData.forEach(d => map.set(d.date, d));
    return map;
  }, [dustData]);

  // Create merged AOD lookup (CAMS EAC4 2020-2024 + bias-corrected Open-Meteo 2025)
  const camsAodMap = useMemo(() => {
    const map = new Map<string, CAMSAODDataPoint>();
    camsAodData.forEach(d => {
      if (d.date) {
        map.set(d.date, d);
      }
    });
    return map;
  }, [camsAodData]);

  // Create DustIQ lookup
  const dustIQMap = useMemo(() => {
    const map = new Map<string, DustIQDataPoint>();
    dustIQData.forEach(d => map.set(d.date, d));
    return map;
  }, [dustIQData]);

  // Create ML prediction lookup
  const mlPredMap = useMemo(() => {
    const map = new Map<string, number>();
    mlPredData.forEach(d => map.set(d.date, d.sr_ml));
    return map;
  }, [mlPredData]);

  // Create transfer prediction lookup
  const transferPredMap = useMemo(() => {
    const map = new Map<string, number>();
    transferPredData.forEach((d) => {
      if (d.sr_transfer !== null) map.set(d.date, d.sr_transfer);
    });
    return map;
  }, [transferPredData]);

  // Create transfer features lookup
  const transferFeaturesMap = useMemo(() => {
    const map = new Map<string, Record<string, number | null>>();
    if (transferFeatures?.daily_data) {
      transferFeatures.daily_data.forEach((d) => {
        const date = d.date as string;
        const features: Record<string, number | null> = {};
        Object.entries(d).forEach(([key, value]) => {
          if (key !== 'date' && typeof value === 'number') {
            features[key] = value;
          }
        });
        map.set(date, features);
      });
    }
    return map;
  }, [transferFeatures]);


  // Combine all data into chart format
  const chartData = useMemo(() => {
    // Get all unique dates from all data sources
    const allDates = new Set<string>();
    rainDataOnsite.forEach(d => allDates.add(d.date));
    rainDataOpenMeteo.forEach(d => allDates.add(d.date));
    dustData.forEach(d => allDates.add(d.date));
    camsAodData.forEach(d => {
      if (d.date) allDates.add(d.date);
    });
    dustIQData.forEach(d => allDates.add(d.date));
    mlPredData.forEach(d => allDates.add(d.date));
    transferPredData.forEach(d => allDates.add(d.date));
    prData.forEach(d => allDates.add(d.date));

    // Sort dates
    const sortedDates = Array.from(allDates).sort();

    // Filter by date range if provided
    let filteredDates = sortedDates;
    if (dateRange) {
      filteredDates = sortedDates.filter(
        date => date >= dateRange.start && date <= dateRange.end
      );
    }

    // Create rain lookups
    const rainOnsiteMap = new Map<string, number>();
    rainDataOnsite.forEach(d => rainOnsiteMap.set(d.date, d.precipitation_mm));

    const rainOpenMeteoMap = new Map<string, number>();
    rainDataOpenMeteo.forEach(d => rainOpenMeteoMap.set(d.date, d.precipitation_mm));

    // Build chart data with soiling rate calculation for ML and DustIQ methods
    let prevSrML: number | null = null;
    let prevSrDustIQ: number | null = null;

    return filteredDates.map(date => {
      // PR uses selected inverter
      const prKey = `${date}|${selectedInverter}`;
      const dustPoint = dustMap.get(date);
      const camsPoint = camsAodMap.get(date);
      const dustIQPoint = dustIQMap.get(date);

      // Use dust data from Open-Meteo (recent 92 days)
      const pm10 = dustPoint?.pm10 ?? null;
      const pm2_5 = dustPoint?.pm2_5 ?? null;
      const dust = dustPoint?.dust ?? null;
      const currentSrML = mlPredMap.get(date) ?? null;
      const currentSrTransfer = transferPredMap.get(date) ?? null;
      const currentSrDustIQ = dustIQPoint?.sr_dustiq ?? null;

      // Calculate soiling rate for ML method (change from previous day, as percentage)
      let soilingRateML: number | null = null;
      if (currentSrML !== null && prevSrML !== null) {
        soilingRateML = (currentSrML - prevSrML) * 100; // Convert to %/day
      }
      prevSrML = currentSrML;

      // Calculate soiling rate for DUSTIQ sensor (change from previous day, as percentage)
      let soilingRateDustIQ: number | null = null;
      if (currentSrDustIQ !== null && prevSrDustIQ !== null) {
        soilingRateDustIQ = (currentSrDustIQ - prevSrDustIQ) * 100; // Convert to %/day
      }
      prevSrDustIQ = currentSrDustIQ;

      // Get transfer features for this date
      const tf = transferFeaturesMap.get(date) || {};

      return {
        date,
        dateFormatted: format(parseISO(date), 'MMM d, yyyy'),
        precipOnsite: rainOnsiteMap.get(date) ?? null,
        precipOpenMeteo: rainOpenMeteoMap.get(date) ?? null,
        pm10,
        pm2_5,
        dust,
        aod: camsPoint?.aod_550nm ?? null,
        srML: currentSrML,
        srTransfer: currentSrTransfer,
        srDustIQ: currentSrDustIQ,
        soilingRateML,
        soilingRateDustIQ,
        pr: prMap.get(prKey) ?? null,
        // Transfer features
        rainfall_7d: tf.rainfall_7d ?? null,
        rainfall_30d: tf.rainfall_30d ?? null,
        days_since_rain: tf.days_since_rain ?? null,
        humidity: tf.humidity ?? null,
        humidity_mean_7d: tf.humidity_mean_7d ?? null,
        wind_speed: tf.wind_speed ?? null,
        wind_mean_7d: tf.wind_mean_7d ?? null,
        temperature: tf.temperature ?? null,
        temperature_mean_7d: tf.temperature_mean_7d ?? null,
        sea_salt_aod: tf.sea_salt_aod ?? null,
        sea_salt_aod_mean_7d: tf.sea_salt_aod_mean_7d ?? null,
        organic_aod: tf.organic_aod ?? null,
        sulphate_aod: tf.sulphate_aod ?? null,
        dust_aod: tf.dust_aod ?? null,
        dust_aod_mean_7d: tf.dust_aod_mean_7d ?? null,
        snowfall: tf.snowfall ?? null,
        snowfall_7d: tf.snowfall_7d ?? null,
      };
    });
  }, [
    rainDataOnsite,
    rainDataOpenMeteo,
    dustData,
    camsAodData,
    dustIQData,
    mlPredData,
    transferPredData,
    prData,
    dustMap,
    camsAodMap,
    dustIQMap,
    mlPredMap,
    transferPredMap,
    transferFeaturesMap,
    prMap,
    selectedInverter,
    dateRange,
  ]);

  // Calculate ML validation metrics when ML and DustIQ SR both exist
  const mlValidationMetrics = useMemo((): ValidationMetrics | null => {
    // Get points where both ML and DustIQ SR exist
    const validPoints = chartData.filter(
      d => d.srML !== null && d.srDustIQ !== null
    );

    if (validPoints.length < 10) return null;

    const n = validPoints.length;
    let sumSquaredError = 0;
    let sumAbsError = 0;
    let sumError = 0;
    let sumML = 0;
    let sumDustIQ = 0;
    let sumMLSq = 0;
    let sumDustIQSq = 0;
    let sumProduct = 0;

    validPoints.forEach(p => {
      const ml = p.srML!;
      const dustiq = p.srDustIQ!;
      const error = ml - dustiq;

      sumSquaredError += error * error;
      sumAbsError += Math.abs(error);
      sumError += error;
      sumML += ml;
      sumDustIQ += dustiq;
      sumMLSq += ml * ml;
      sumDustIQSq += dustiq * dustiq;
      sumProduct += ml * dustiq;
    });

    const rmse = Math.sqrt(sumSquaredError / n);
    const mae = sumAbsError / n;
    const bias = sumError / n;

    // Pearson correlation coefficient
    const meanML = sumML / n;
    const meanDustIQ = sumDustIQ / n;
    const stdML = Math.sqrt(sumMLSq / n - meanML * meanML);
    const stdDustIQ = Math.sqrt(sumDustIQSq / n - meanDustIQ * meanDustIQ);
    const covariance = sumProduct / n - meanML * meanDustIQ;
    const correlation = stdML > 0 && stdDustIQ > 0 ? covariance / (stdML * stdDustIQ) : 0;

    return { rmse, mae, bias, correlation, count: n };
  }, [chartData]);


  // Custom tooltip - compact version
  const CustomTooltip = useCallback(({ active, payload, label }: {
    active?: boolean;
    payload?: Array<{ name: string; value: number; color: string }>;
    label?: string;
  }) => {
    if (!active || !payload || !payload.length) return null;

    const dataPoint = chartData.find(d => d.date === label);
    if (!dataPoint) return null;

    return (
      <div className="bg-white border border-gray-300 rounded-lg p-2 shadow-lg text-xs max-w-[200px]">
        <p className="text-gray-800 font-bold mb-1">{dataPoint.dateFormatted}</p>
        <div className="space-y-0.5">
          {dataPoint.precipOnsite !== null && (
            <p className="text-blue-600">Rain: <b>{dataPoint.precipOnsite.toFixed(1)}mm</b></p>
          )}
          {dataPoint.aod !== null && (
            <p className="text-purple-600">AOD: <b>{dataPoint.aod.toFixed(3)}</b></p>
          )}
          {dataPoint.srML !== null && (
            <p className="text-orange-600">ML SR: <b>{(dataPoint.srML * 100).toFixed(1)}%</b></p>
          )}
          {dataPoint.srTransfer !== null && (
            <p className="text-sky-600">Transfer SR: <b>{(dataPoint.srTransfer * 100).toFixed(1)}%</b></p>
          )}
          {dataPoint.srDustIQ !== null && (
            <p className="text-teal-600">DustIQ: <b>{(dataPoint.srDustIQ * 100).toFixed(1)}%</b></p>
          )}
          {dataPoint.pr !== null && (
            <p className="text-amber-600">PR: <b>{(dataPoint.pr * 100).toFixed(0)}%</b></p>
          )}
        </div>
      </div>
    );
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl p-8 border border-gray-200 shadow-sm">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">Loading data...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl p-8 border border-red-200 shadow-sm">
        <div className="text-center">
          <span className="text-red-600 text-lg font-medium">Error loading data</span>
          <p className="text-gray-500 mt-2">{error}</p>
        </div>
      </div>
    );
  }

  // Calculate dynamic height based on visible panels
  // 4 base panels: Precipitation, Statistical SR, DustIQ SR, PR
  // Optional: Dust/PM, Soiling Rate
  const hasDustIQData = dustIQData.length > 0;
  const hasTransferData = transferPredData.length > 0;
  const numPanels = 3 + (hasDustIQData ? 1 : 0) + (showDust ? 1 : 0) + (showSoilingRate ? 1 : 0);
  const totalHeight = numPanels * PANEL_HEIGHT + (mlValidationMetrics ? 120 : 0) + 100; // Add space for metrics, brush, summary

  return (
    <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
      {/* Header with controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 gap-4">
        <h3 className="text-2xl font-bold text-gray-900">
          Data Explorer
        </h3>
        <div className="flex items-center gap-6 flex-wrap">
          {/* Dust toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showDust}
              onChange={(e) => setShowDust(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
            />
            <span className="text-base text-gray-700 font-semibold">Dust/PM</span>
          </label>

          {/* Soiling Rate toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showSoilingRate}
              onChange={(e) => setShowSoilingRate(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 text-violet-500 focus:ring-violet-500"
            />
            <span className="text-base text-gray-700 font-semibold">Soiling Rate</span>
          </label>

          {/* Transfer SR toggle (only if available) */}
          <label className={`flex items-center gap-2 ${hasTransferData ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={showTransfer && hasTransferData}
              onChange={(e) => setShowTransfer(e.target.checked)}
              disabled={!hasTransferData}
              className="w-5 h-5 rounded border-gray-300 text-sky-500 focus:ring-sky-500"
            />
            <span className="text-base text-gray-700 font-semibold">Transfer Model</span>
          </label>

          {/* Weather toggle (temperature, humidity, wind) */}
          <label className={`flex items-center gap-2 ${transferFeatures ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={showWeather && !!transferFeatures}
              onChange={(e) => setShowWeather(e.target.checked)}
              disabled={!transferFeatures}
              className="w-5 h-5 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500"
            />
            <span className="text-base text-gray-700 font-semibold">Weather</span>
          </label>

          {/* Sea Salt toggle (for coastal plants) */}
          <label className={`flex items-center gap-2 ${transferFeatures?.metadata?.is_coastal ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={showSeaSalt && !!transferFeatures?.metadata?.is_coastal}
              onChange={(e) => setShowSeaSalt(e.target.checked)}
              disabled={!transferFeatures?.metadata?.is_coastal}
              className="w-5 h-5 rounded border-gray-300 text-cyan-500 focus:ring-cyan-500"
            />
            <span className="text-base text-gray-700 font-semibold">Sea Salt</span>
          </label>

          {/* Humidity/Wind toggle */}
          <label className={`flex items-center gap-2 ${transferFeatures ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={showHumidityWind && !!transferFeatures}
              onChange={(e) => setShowHumidityWind(e.target.checked)}
              disabled={!transferFeatures}
              className="w-5 h-5 rounded border-gray-300 text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-base text-gray-700 font-semibold">Humidity/Wind</span>
          </label>

          {/* Inverter selector */}
          <div className="flex items-center gap-2">
            <label className="text-base text-gray-700 font-semibold">Inverter:</label>
            <select
              value={selectedInverter}
              onChange={(e) => setSelectedInverter(e.target.value)}
              className="bg-white border-2 border-gray-300 rounded-lg px-4 py-2 text-gray-900 text-base font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {availableInverters.map(inv => (
                <option key={inv} value={inv}>{inv}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Panel 1: Precipitation - Both Sources */}
      <div className="mb-6 pb-4 border-b-2 border-gray-100">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-1 h-8 bg-blue-500 rounded"></div>
          <span className="text-gray-900 text-lg font-bold">Precipitation (mm)</span>
          <span className="text-sm text-gray-500">On-site vs Open-Meteo</span>
        </div>
        <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
          <ComposedChart data={chartData} syncId="dataExplorer">
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#374151', fontSize: 12 }}
              tickFormatter={() => ''}
              axisLine={{ stroke: '#9CA3AF' }}
            />
            <YAxis
              tick={{ fill: '#374151', fontSize: 12 }}
              axisLine={{ stroke: '#9CA3AF' }}
              domain={[0, 'auto']}
              width={55}
              label={{
                value: 'mm',
                angle: -90,
                position: 'insideLeft',
                fill: '#374151',
                fontSize: 13,
                fontWeight: 600,
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="precipOnsite"
              fill="#2563EB"
              opacity={0.9}
              name="On-site"
              radius={[3, 3, 0, 0]}
            />
            <Bar
              dataKey="precipOpenMeteo"
              fill="#06B6D4"
              opacity={0.8}
              name="Open-Meteo"
              radius={[3, 3, 0, 0]}
            />
            <Legend
              verticalAlign="top"
              height={30}
              wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Panel 2: Dust/PM (optional) */}
      {showDust && (
        <div className="mb-6 pb-4 border-b-2 border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-8 bg-orange-500 rounded"></div>
            <span className="text-gray-900 text-lg font-bold">Dust & Particulates (μg/m³)</span>
          </div>
          <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
            <ComposedChart data={chartData} syncId="dataExplorer">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#374151', fontSize: 12 }}
                tickFormatter={() => ''}
                axisLine={{ stroke: '#9CA3AF' }}
              />
              <YAxis
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0, 'auto']}
                width={55}
                label={{
                  value: 'μg/m³',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
              />
              <Line
                type="monotone"
                dataKey="dust"
                stroke="#EA580C"
                strokeWidth={3}
                dot={false}
                name="Saharan Dust"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="pm10"
                stroke="#F59E0B"
                strokeWidth={2.5}
                dot={false}
                name="PM10"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="pm2_5"
                stroke="#84CC16"
                strokeWidth={2}
                dot={false}
                name="PM2.5"
                connectNulls
                strokeDasharray="6 3"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Panel 3: AOD - Aerosol Optical Depth (full historical data) */}
      <div className="mb-6 pb-4 border-b-2 border-gray-100">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-1 h-8 bg-purple-500 rounded"></div>
          <span className="text-gray-900 text-lg font-bold">Aerosol Optical Depth (AOD 550nm)</span>
          <span className="text-sm text-gray-500">CAMS EAC4 2020-2024 + Open-Meteo 2025</span>
        </div>
        <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
          <ComposedChart data={chartData} syncId="dataExplorer">
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#374151', fontSize: 12 }}
              tickFormatter={() => ''}
              axisLine={{ stroke: '#9CA3AF' }}
            />
            <YAxis
              tick={{ fill: '#374151', fontSize: 12 }}
              axisLine={{ stroke: '#9CA3AF' }}
              domain={[0, 0.8]}
              width={55}
              label={{
                value: 'AOD',
                angle: -90,
                position: 'insideLeft',
                fill: '#374151',
                fontSize: 13,
                fontWeight: 600,
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0.15} stroke="#22C55E" strokeDasharray="6 4" strokeWidth={1.5} label={{ value: 'Low (0.15)', fill: '#22C55E', fontSize: 10, position: 'insideTopRight' }} />
            <ReferenceLine y={0.3} stroke="#F59E0B" strokeDasharray="6 4" strokeWidth={1.5} label={{ value: 'Medium (0.3)', fill: '#F59E0B', fontSize: 10, position: 'insideTopRight' }} />
            <ReferenceLine y={0.5} stroke="#EF4444" strokeDasharray="6 4" strokeWidth={1.5} label={{ value: 'High (0.5)', fill: '#EF4444', fontSize: 10, position: 'insideTopRight' }} />
            <Line
              type="monotone"
              dataKey="aod"
              stroke="#9333EA"
              strokeWidth={2}
              dot={false}
              name="AOD 550nm"
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Panel 4: Weather - Temperature (from transfer features) */}
      {showWeather && transferFeatures && (
        <div className="mb-6 pb-4 border-b-2 border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-8 bg-emerald-500 rounded"></div>
            <span className="text-gray-900 text-lg font-bold">Temperature & Rainfall Accumulation</span>
            <span className="text-sm text-gray-500">7-day and 30-day rolling sums</span>
          </div>
          <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
            <ComposedChart data={chartData} syncId="dataExplorer">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#374151', fontSize: 12 }}
                tickFormatter={() => ''}
                axisLine={{ stroke: '#9CA3AF' }}
              />
              <YAxis
                yAxisId="temp"
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[-5, 45]}
                width={55}
                label={{
                  value: '°C',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <YAxis
                yAxisId="rain"
                orientation="right"
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0, 'auto']}
                width={55}
                label={{
                  value: 'mm',
                  angle: 90,
                  position: 'insideRight',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
              />
              <Line
                yAxisId="temp"
                type="monotone"
                dataKey="temperature"
                stroke="#10B981"
                strokeWidth={2}
                dot={false}
                name="Temperature"
                connectNulls
              />
              <Bar
                yAxisId="rain"
                dataKey="rainfall_7d"
                fill="#3B82F6"
                opacity={0.6}
                name="Rain 7d"
                radius={[2, 2, 0, 0]}
              />
              <Bar
                yAxisId="rain"
                dataKey="rainfall_30d"
                fill="#93C5FD"
                opacity={0.4}
                name="Rain 30d"
                radius={[2, 2, 0, 0]}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Panel 5: Humidity & Wind (from transfer features) */}
      {showHumidityWind && transferFeatures && (
        <div className="mb-6 pb-4 border-b-2 border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-8 bg-indigo-500 rounded"></div>
            <span className="text-gray-900 text-lg font-bold">Humidity & Wind Speed</span>
            <span className="text-sm text-gray-500">Key soiling factors</span>
          </div>
          <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
            <ComposedChart data={chartData} syncId="dataExplorer">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#374151', fontSize: 12 }}
                tickFormatter={() => ''}
                axisLine={{ stroke: '#9CA3AF' }}
              />
              <YAxis
                yAxisId="humidity"
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0, 100]}
                width={55}
                label={{
                  value: '%',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <YAxis
                yAxisId="wind"
                orientation="right"
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0, 'auto']}
                width={55}
                label={{
                  value: 'm/s',
                  angle: 90,
                  position: 'insideRight',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
              />
              <ReferenceLine yAxisId="humidity" y={70} stroke="#6366F1" strokeDasharray="6 4" strokeWidth={1.5} label={{ value: 'High Humidity', fill: '#6366F1', fontSize: 10, position: 'insideTopRight' }} />
              <Line
                yAxisId="humidity"
                type="monotone"
                dataKey="humidity"
                stroke="#6366F1"
                strokeWidth={2}
                dot={false}
                name="Humidity %"
                connectNulls
              />
              <Line
                yAxisId="wind"
                type="monotone"
                dataKey="wind_speed"
                stroke="#14B8A6"
                strokeWidth={2}
                dot={false}
                name="Wind Speed"
                connectNulls
              />
              <Line
                yAxisId="humidity"
                type="monotone"
                dataKey="days_since_rain"
                stroke="#F59E0B"
                strokeWidth={2}
                strokeDasharray="4 2"
                dot={false}
                name="Days Since Rain"
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Panel 6: Sea Salt & Aerosol Speciation (coastal plants only) */}
      {showSeaSalt && transferFeatures?.metadata?.is_coastal && (
        <div className="mb-6 pb-4 border-b-2 border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-8 bg-cyan-500 rounded"></div>
            <span className="text-gray-900 text-lg font-bold">Aerosol Speciation</span>
            <span className="text-sm text-gray-500">Sea salt, organic, sulphate breakdown</span>
          </div>
          <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
            <ComposedChart data={chartData} syncId="dataExplorer">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#374151', fontSize: 12 }}
                tickFormatter={() => ''}
                axisLine={{ stroke: '#9CA3AF' }}
              />
              <YAxis
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0, 0.2]}
                width={55}
                label={{
                  value: 'AOD',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
              />
              <Line
                type="monotone"
                dataKey="sea_salt_aod"
                stroke="#06B6D4"
                strokeWidth={2.5}
                dot={false}
                name="Sea Salt AOD"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="dust_aod"
                stroke="#F59E0B"
                strokeWidth={2}
                dot={false}
                name="Dust AOD"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="organic_aod"
                stroke="#22C55E"
                strokeWidth={2}
                dot={false}
                name="Organic AOD"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="sulphate_aod"
                stroke="#8B5CF6"
                strokeWidth={2}
                strokeDasharray="4 2"
                dot={false}
                name="Sulphate AOD"
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ========== ESTIMATED (Statistical + ML Methods) SECTION ========== */}
      <div className="mb-8 p-4 bg-emerald-50/50 rounded-xl border-2 border-emerald-200">
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-emerald-200">
          <div className="w-2 h-10 bg-gradient-to-b from-emerald-500 via-violet-500 to-orange-500 rounded"></div>
          <div>
            <div className="flex items-center gap-2">
              <span className="bg-emerald-600 text-white text-xs font-bold px-2 py-0.5 rounded">ESTIMATED</span>
              <h4 className="text-xl font-bold text-emerald-800">Soiling Ratio Models</h4>
            </div>
            <p className="text-sm text-gray-600">
              <span className="text-orange-600 font-semibold">ML Model</span> (transfer learning)
            </p>
          </div>
        </div>

        {/* Soiling Ratio - All Methods */}
        <div className="mb-4">
          <div className="flex items-center gap-4 mb-2">
            <span className="text-gray-800 text-base font-semibold">Soiling Ratio</span>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-orange-500"></span>
                <span className="text-orange-700">ML Model</span>
              </span>
              {hasTransferData && showTransfer && (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-sky-500"></span>
                  <span className="text-sky-700">Transfer Model</span>
                </span>
              )}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
            <ComposedChart data={chartData} syncId="dataExplorer">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#374151', fontSize: 12 }}
                tickFormatter={() => ''}
                axisLine={{ stroke: '#9CA3AF' }}
              />
              <YAxis
                tick={{ fill: '#374151', fontSize: 12 }}
                axisLine={{ stroke: '#9CA3AF' }}
                domain={[0.7, 1.02]}
                width={55}
                tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                label={{
                  value: 'SR %',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#374151',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '14px', fontWeight: 600 }}
              />
              <ReferenceLine y={0.92} stroke="#DC2626" strokeDasharray="6 4" strokeWidth={2} label={{ value: 'Clean 92%', fill: '#DC2626', fontSize: 11, fontWeight: 600, position: 'insideTopRight' }} />
              <Line
                type="monotone"
                dataKey="srML"
                stroke="#F97316"
                strokeWidth={2.5}
                dot={false}
                name="ML Model"
                connectNulls
              />
              {hasTransferData && showTransfer && (
                <Line
                  type="monotone"
                  dataKey="srTransfer"
                  stroke="#0EA5E9"
                  strokeWidth={2.5}
                  dot={false}
                  name="Transfer Model"
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

      </div>

      {/* ========== MEASURED (DustIQ Sensor) SECTION ========== */}
      {hasDustIQData && (
        <div className="mb-8 p-4 bg-teal-50/50 rounded-xl border-2 border-teal-200">
          <div className="flex items-center gap-3 mb-4 pb-3 border-b border-teal-200">
            <div className="w-2 h-10 bg-teal-500 rounded"></div>
            <div>
              <div className="flex items-center gap-2">
                <span className="bg-teal-600 text-white text-xs font-bold px-2 py-0.5 rounded">MEASURED</span>
                <h4 className="text-xl font-bold text-teal-800">DustIQ Sensor</h4>
              </div>
              <p className="text-sm text-teal-600">Direct optical measurement from on-site sensor (ground truth)</p>
            </div>
          </div>

          {/* DustIQ Soiling Ratio */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-gray-800 text-base font-semibold">Soiling Ratio</span>
            </div>
            <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
              <ComposedChart data={chartData} syncId="dataExplorer">
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#374151', fontSize: 12 }}
                  tickFormatter={() => ''}
                  axisLine={{ stroke: '#9CA3AF' }}
                />
                <YAxis
                  tick={{ fill: '#374151', fontSize: 12 }}
                  axisLine={{ stroke: '#9CA3AF' }}
                  domain={[0.7, 1.02]}
                  width={55}
                  tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                  label={{
                    value: 'SR %',
                    angle: -90,
                    position: 'insideLeft',
                    fill: '#374151',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0.92} stroke="#DC2626" strokeDasharray="6 4" strokeWidth={2} label={{ value: 'Clean 92%', fill: '#DC2626', fontSize: 11, fontWeight: 600, position: 'insideTopRight' }} />
                <Line
                  type="monotone"
                  dataKey="srDustIQ"
                  stroke="#14B8A6"
                  strokeWidth={3}
                  dot={false}
                  name="DustIQ Sensor SR"
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* DustIQ Soiling Rate */}
          {showSoilingRate && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-gray-800 text-base font-semibold">Soiling Rate</span>
                <span className="text-xs text-gray-500">(+ recovery, - degradation)</span>
              </div>
              <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
                <ComposedChart data={chartData} syncId="dataExplorer">
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#374151', fontSize: 12 }}
                    tickFormatter={() => ''}
                    axisLine={{ stroke: '#9CA3AF' }}
                  />
                  <YAxis
                    tick={{ fill: '#374151', fontSize: 12 }}
                    axisLine={{ stroke: '#9CA3AF' }}
                    domain={[-2, 2]}
                    width={55}
                    tickFormatter={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`}
                    label={{
                      value: '%/day',
                      angle: -90,
                      position: 'insideLeft',
                      fill: '#374151',
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  />
                  <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="6 4" strokeWidth={1.5} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="soilingRateDustIQ"
                    name="DustIQ Rate"
                    fill="#14B8A6"
                    opacity={0.8}
                    radius={[2, 2, 0, 0]}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* ========== VALIDATION METRICS ========== */}
      {mlValidationMetrics && (
        <div className="mb-6 p-4 bg-gradient-to-r from-orange-50 to-teal-50 rounded-xl border-2 border-gray-300">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-2 h-10 bg-gradient-to-b from-orange-500 to-teal-500 rounded"></div>
            <div>
              <h4 className="text-xl font-bold text-gray-800">Model Validation vs DustIQ (Ground Truth)</h4>
              <p className="text-sm text-gray-600">ML model accuracy compared to sensor measurements</p>
            </div>
          </div>

          {/* ML Model Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* ML Model */}
            {mlValidationMetrics && (
              <div className="bg-orange-50/50 rounded-lg p-4 border border-orange-200">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-3 h-3 bg-orange-500 rounded-full"></span>
                  <span className="font-bold text-orange-800">ML Model (CatBoost)</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white rounded p-2 border border-orange-100">
                    <div className="text-xs text-gray-500 uppercase">MAE</div>
                    <div className="text-lg font-bold text-orange-700">{(mlValidationMetrics.mae * 100).toFixed(2)}%</div>
                  </div>
                  <div className="bg-white rounded p-2 border border-orange-100">
                    <div className="text-xs text-gray-500 uppercase">RMSE</div>
                    <div className="text-lg font-bold text-orange-700">{(mlValidationMetrics.rmse * 100).toFixed(2)}%</div>
                  </div>
                  <div className="bg-white rounded p-2 border border-orange-100">
                    <div className="text-xs text-gray-500 uppercase">Bias</div>
                    <div className={`text-lg font-bold ${mlValidationMetrics.bias >= 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {mlValidationMetrics.bias >= 0 ? '+' : ''}{(mlValidationMetrics.bias * 100).toFixed(2)}%
                    </div>
                  </div>
                  <div className="bg-white rounded p-2 border border-orange-100">
                    <div className="text-xs text-gray-500 uppercase">Corr</div>
                    <div className={`text-lg font-bold ${mlValidationMetrics.correlation >= 0.7 ? 'text-green-600' : mlValidationMetrics.correlation >= 0.4 ? 'text-yellow-600' : 'text-red-600'}`}>
                      {mlValidationMetrics.correlation.toFixed(3)}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-2 text-center">{mlValidationMetrics.count} overlapping days</div>
              </div>
            )}
          </div>

        </div>
      )}

      {/* Panel 5: Performance Ratio */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-1 h-8 bg-amber-500 rounded"></div>
          <span className="text-gray-900 text-lg font-bold">Performance Ratio</span>
          <span className="text-sm text-gray-500">{selectedInverter || 'All Inverters'}</span>
        </div>
        <ResponsiveContainer width="100%" height={PANEL_HEIGHT}>
          <ComposedChart data={chartData} syncId="dataExplorer">
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#374151', fontSize: 12 }}
              tickFormatter={(date) => {
                try {
                  return format(parseISO(date), 'MMM yyyy');
                } catch {
                  return date;
                }
              }}
              axisLine={{ stroke: '#9CA3AF' }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: '#374151', fontSize: 12 }}
              axisLine={{ stroke: '#9CA3AF' }}
              domain={[0, 1.2]}
              width={55}
              tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
              label={{
                value: 'PR %',
                angle: -90,
                position: 'insideLeft',
                fill: '#374151',
                fontSize: 13,
                fontWeight: 600,
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="pr"
              stroke="#F59E0B"
              strokeWidth={3}
              dot={false}
              name="Performance Ratio"
              connectNulls
            />
            <Brush
              dataKey="date"
              height={40}
              stroke="#9CA3AF"
              fill="#F9FAFB"
              tickFormatter={(date) => {
                try {
                  return format(parseISO(date), 'MMM yy');
                } catch {
                  return '';
                }
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Data summary */}
      <div className="mt-6 pt-6 border-t-2 border-gray-200 flex flex-wrap gap-6 text-base text-gray-700">
        <span className="flex items-center gap-2 font-medium">
          <span className="w-3 h-3 bg-gray-400 rounded-full"></span>
          {chartData.length} days
        </span>
        <span className="flex items-center gap-2 font-medium">
          <span className="w-3 h-3 bg-gray-400 rounded-full"></span>
          {availableInverters.length} inverters
        </span>
        <span className="flex items-center gap-2 font-medium">
          <span className="w-3 h-3 bg-gray-400 rounded-full"></span>
          {chartData.length > 0 ? `${chartData[0].dateFormatted} - ${chartData[chartData.length - 1].dateFormatted}` : 'No data'}
        </span>
        {camsAodData.length > 0 && (
          <span className="flex items-center gap-2 text-purple-700 font-medium">
            <span className="w-3 h-3 bg-purple-500 rounded-full"></span>
            AOD: {camsAodData.length} days
          </span>
        )}
        {mlPredData.length > 0 && (
          <span className="flex items-center gap-2 text-orange-700 font-medium">
            <span className="w-3 h-3 bg-orange-500 rounded-full"></span>
            ML Model: {mlPredData.length} days
          </span>
        )}
        {hasDustIQData && (
          <span className="flex items-center gap-2 text-teal-700 font-medium">
            <span className="w-3 h-3 bg-teal-500 rounded-full"></span>
            DustIQ: {dustIQData.length} days
          </span>
        )}
        <span className="flex items-center gap-2 text-blue-700 font-medium">
          <span className="w-3 h-3 bg-blue-500 rounded-full"></span>
          On-site rain: {rainDataOnsite.length} days
        </span>
      </div>
    </div>
  );
}

export default DataExplorerChart;
