'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import PlantBreadcrumb from '@/components/ui/PlantBreadcrumb';
import {
  ChevronRight,
  Zap,
  Gauge,
  BatteryCharging,
  Activity,
  AlertTriangle,
  Circle,
  TrendingDown,
} from 'lucide-react';
import type {
  PlantMpptData,
  MpptData,
} from '@/types/mppt';
import type { TwinPoint } from '@/components/twin/TwinTimelineChart';
import StringComparisonChart from '@/components/mppt/StringComparisonChart';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/** Honest provenance caption for the drill-down twin overlay, keyed on the
 *  parquet-query modelVersion (snapshot-derived vs physics-synth vs trained). */
function twinProvenanceNote(modelVersion: string | null | undefined): string | null {
  const mv = typeof modelVersion === 'string' ? modelVersion : '';
  if (mv.startsWith('snapshot-derived')) {
    return 'Derived from the plant snapshot and the inverter power twin, not per-string measured telemetry.';
  }
  if (mv.startsWith('electrical-synth') || mv.startsWith('physics-multisignal')) {
    return 'Physics-derived synthetic twin.';
  }
  return null;
}

const TwinTimelineChart = dynamic(
  () => import('@/components/twin/TwinTimelineChart'),
  { ssr: false }
);

const MPPT_STATUS_CONFIG: Record<
  MpptData['status'],
  { label: string; bg: string; text: string; dot: string }
> = {
  normal: {
    label: 'Normal',
    bg: 'bg-signal-positive/10',
    text: 'text-signal-positive',
    dot: 'bg-emerald-500',
  },
  warning: {
    label: 'Warning',
    bg: 'bg-signal-warning/10',
    text: 'text-signal-warning',
    dot: 'bg-amber-500',
  },
  fault: {
    label: 'Fault',
    bg: 'bg-signal-critical/10',
    text: 'text-signal-critical',
    dot: 'bg-red-500',
  },
  offline: {
    label: 'Offline',
    bg: 'bg-paper-2',
    text: 'text-ink-3',
    dot: 'bg-gray-400',
  },
};

const STRING_STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; dot: string }
> = {
  normal: {
    label: 'Normal',
    bg: 'bg-signal-positive/10',
    text: 'text-signal-positive',
    dot: 'bg-emerald-500',
  },
  degraded: {
    label: 'Degraded',
    bg: 'bg-signal-warning/10',
    text: 'text-signal-warning',
    dot: 'bg-amber-500',
  },
  open_circuit: {
    label: 'Open Circuit',
    bg: 'bg-signal-critical/10',
    text: 'text-signal-critical',
    dot: 'bg-red-500',
  },
  shorted: {
    label: 'Shorted',
    bg: 'bg-signal-critical/10',
    text: 'text-signal-critical',
    dot: 'bg-red-600',
  },
  offline: {
    label: 'Offline',
    bg: 'bg-paper',
    text: 'text-ink-3',
    dot: 'bg-gray-400',
  },
};

export default function MpptDetailPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const inverterId = decodeURIComponent(params.inverterId as string);
  const mpptId = decodeURIComponent(params.mpptId as string);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  const [mppt, setMppt] = useState<MpptData | null>(null);
  // Live twin timeseries from parquet-query API (replaces static JSON snapshot).
  const [voltageSeries, setVoltageSeries] = useState<TwinPoint[]>([]);
  const [currentSeries, setCurrentSeries] = useState<TwinPoint[]>([]);
  const [twinNote, setTwinNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setError(null);

      try {
        // Snapshot fixtures exist for demo/showcase plants and org plants that
        // ship one (e.g. the demo org's kilima-solar). Real operator plants
        // without a snapshot fall through to a friendly "not available".
        const snapshotRes = await fetch(
          `${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`
        );
        if (!snapshotRes.ok) {
          throw new Error('MPPT telemetry is not available for this plant yet');
        }
        const snapshotJson: PlantMpptData = await snapshotRes.json();

        // Find the inverter
        const inverterSnapshot = snapshotJson.inverters[inverterId];
        if (!inverterSnapshot) {
          throw new Error(
            `Inverter "${inverterId}" not found in snapshot data`
          );
        }

        // Find the MPPT within this inverter
        const mpptMatch = inverterSnapshot.mppts.find(
          (m) => m.mpptId === mpptId
        );
        if (!mpptMatch) {
          throw new Error(
            `MPPT "${mpptId}" not found on inverter "${inverterId}"`
          );
        }

        setMppt(mpptMatch);

        // Fetch live twin timeseries from the parquet-query API.
        // - MPPT voltage = own MPPT (mppt_voltage parquet).
        // - MPPT current = sum across child strings (string_current_sum aggregates
        //   the strings under this MPPT, see scripts/parquet_query.py).
        const from = '2020-01-01';
        const to = '2030-01-01';
        const mpptDeviceId = `${inverterId}.${mpptId}`; // e.g. "INV 01.057.MPPT-1"
        try {
          const [voltRes, currRes] = await Promise.all([
            fetch(
              `/api/digitaltwin/${plantId}/parquet-query?device_id=${encodeURIComponent(mpptDeviceId)}&type=mppt_voltage&from=${from}&to=${to}`
            ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(
              `/api/digitaltwin/${plantId}/parquet-query?device_id=${encodeURIComponent(mpptDeviceId)}&type=string_current_sum&from=${from}&to=${to}`
            ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ]);
          if (voltRes?.series) setVoltageSeries(voltRes.series);
          if (currRes?.series) setCurrentSeries(currRes.series);
          setTwinNote(twinProvenanceNote(voltRes?.modelVersion ?? currRes?.modelVersion ?? null));
        } catch {
          console.warn('MPPT twin timeseries fetch failed');
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load MPPT data';
        console.error('Error loading MPPT data:', message);
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [plantId, inverterId, mpptId, prefix]);

  // -- Loading state --
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto" />
          <p className="mt-4 text-sm text-ink-3">Loading MPPT data...</p>
        </div>
      </div>
    );
  }

  // -- Error / not-found state --
  if (error || !mppt) {
    return (
      <div className="text-center py-16">
        <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-ink mb-1">
          MPPT Not Found
        </h2>
        <p className="text-sm text-ink-3 mb-6 max-w-md mx-auto">
          {error ?? `Could not locate MPPT "${mpptId}" on inverter "${inverterId}".`}
        </p>
        <Link
          href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId)}`}
          className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 text-sm font-medium"
        >
          &larr; Back to Inverter
        </Link>
      </div>
    );
  }

  const statusCfg = MPPT_STATUS_CONFIG[mppt.status];

  return (
    <div className="space-y-6">
      {/* ── Breadcrumb ── */}
      <PlantBreadcrumb
        plantId={plantId}
        inverterId={inverterId}
        mpptId={mpptId}
      />

      {/* ── KPI Row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Voltage */}
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-ink-2 uppercase tracking-wide">
              Voltage
            </span>
          </div>
          <div className="text-3xl font-bold text-blue-600 mt-1">
            {mppt.voltage_V.toFixed(1)}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">V</div>
        </div>

        {/* Current */}
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 border border-signal-positive/20 rounded-xl p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Gauge className="h-4 w-4 text-emerald-500" />
            <span className="text-xs text-ink-2 uppercase tracking-wide">
              Current
            </span>
          </div>
          <div className="text-3xl font-bold text-signal-positive mt-1">
            {mppt.current_A.toFixed(2)}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">A</div>
        </div>

        {/* Power */}
        <div className="bg-gradient-to-br from-amber-50 to-amber-100 border border-signal-warning/20 rounded-xl p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <BatteryCharging className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-ink-2 uppercase tracking-wide">
              Power
            </span>
          </div>
          <div className="text-3xl font-bold text-signal-warning mt-1">
            {mppt.power_kW.toFixed(2)}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">kW</div>
        </div>

        {/* Status */}
        <div className="bg-white border border-divider rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 mb-1">
            <Activity className="h-4 w-4 text-ink-3" />
            <span className="text-xs text-ink-2 uppercase tracking-wide">
              Status
            </span>
          </div>
          <span
            className={`
              mt-2 inline-flex items-center gap-1.5 self-start
              rounded-full px-3 py-1 text-sm font-medium
              ${statusCfg.bg} ${statusCfg.text}
            `}
          >
            <span
              className={`h-2 w-2 rounded-full ${statusCfg.dot}`}
            />
            {statusCfg.label}
          </span>
        </div>
      </div>

      {/* ── String Comparison ── */}
      <section>
        <h2 className="text-lg font-semibold text-ink mb-4">
          String Comparison
        </h2>

        {mppt.strings.length === 0 ? (
          <div className="bg-white border border-divider rounded-xl p-8 text-center text-sm text-ink-3">
            No string data available for this MPPT.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {mppt.strings.map((str) => {
                const sCfg =
                  STRING_STATUS_CONFIG[str.status] ?? STRING_STATUS_CONFIG.offline;

                return (
                  <Link
                    key={str.stringId}
                    href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId)}/string/${encodeURIComponent(str.stringId)}`}
                    className={`
                      block rounded-xl border bg-white p-5 shadow-sm
                      transition-all duration-150
                      hover:shadow-md hover:border-blue-300 hover:-translate-y-0.5
                      ${str.status === 'normal' ? 'border-divider' : 'border-signal-warning/20'}
                    `}
                  >
                    {/* Card header */}
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-semibold text-ink">
                        {str.stringId}
                      </span>
                      <span
                        className={`
                          inline-flex items-center gap-1.5 rounded-full px-2 py-0.5
                          text-xs font-medium ${sCfg.bg} ${sCfg.text}
                        `}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${sCfg.dot}`}
                        />
                        {sCfg.label}
                      </span>
                    </div>

                    {/* Electrical readings */}
                    <div className="grid grid-cols-3 gap-3 text-center mb-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-ink-3">
                          Voltage
                        </p>
                        <p className="text-sm font-medium text-ink">
                          {str.voltage_V.toFixed(1)}{' '}
                          <span className="text-ink-3 text-xs">V</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-ink-3">
                          Current
                        </p>
                        <p className="text-sm font-medium text-ink">
                          {str.current_A.toFixed(2)}{' '}
                          <span className="text-ink-3 text-xs">A</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-ink-3">
                          Power
                        </p>
                        <p className="text-sm font-medium text-ink">
                          {str.power_kW.toFixed(2)}{' '}
                          <span className="text-ink-3 text-xs">kW</span>
                        </p>
                      </div>
                    </div>

                    {/* Footer: module count + degradation */}
                    <div className="flex items-center justify-between pt-3 border-t border-divider">
                      <div className="flex items-center gap-1.5 text-xs text-ink-3">
                        <Circle className="h-2.5 w-2.5 text-gray-300" />
                        {str.moduleCount} modules
                      </div>
                      <div className="flex items-center gap-1 text-xs">
                        <TrendingDown className="h-3 w-3 text-ink-3" />
                        <span
                          className={
                            str.degradation_pct > 5
                              ? 'text-signal-critical font-medium'
                              : str.degradation_pct > 2
                                ? 'text-signal-warning font-medium'
                                : 'text-ink-3'
                          }
                        >
                          {str.degradation_pct.toFixed(1)}% degradation
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* String comparison chart */}
            <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
              <StringComparisonChart strings={mppt.strings} />
            </div>
          </>
        )}
      </section>

      {/* ── Twin charts (predicted vs actual, live model output) ── */}
      <section>
        <h2 className="text-lg font-semibold text-ink mb-1">
          Digital Twin · Predicted vs Actual
        </h2>
        {twinNote && <p className="text-xs text-ink-3 mb-4">{twinNote}</p>}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-ink mb-1">
              DC Voltage Twin
            </h3>
            <p className="text-xs text-ink-3 mb-3">
              Predicted vs actual voltage on {mpptId} · {voltageSeries.length} points
            </p>
            <TwinTimelineChart series={voltageSeries} unit="V (DC)" />
          </div>
          <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-ink mb-1">
              DC Current Twin (sum across strings)
            </h3>
            <p className="text-xs text-ink-3 mb-3">
              Predicted vs actual current on {mpptId} · {currentSeries.length} points
            </p>
            <TwinTimelineChart
              series={currentSeries}
              unit="A (DC)"
              predictedColor="#10b981"
              actualColor="#059669"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
