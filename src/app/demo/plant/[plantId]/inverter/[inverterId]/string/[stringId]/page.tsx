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
  Activity,
  Layers,
  TrendingDown,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  FileWarning,
} from 'lucide-react';
import type {
  PlantMpptData,
  StringData,
} from '@/types/mppt';
import type { TwinPoint } from '@/components/twin/TwinTimelineChart';
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
const IVCurveChart = dynamic(
  () => import('@/components/mppt/IVCurveChart'),
  { ssr: false }
);

// ── Status badge config ────────────────────────────────────────────
const STATUS_STYLE: Record<
  StringData['status'],
  { label: string; bg: string; text: string; border: string }
> = {
  normal: {
    label: 'Normal',
    bg: 'bg-signal-positive/10',
    text: 'text-signal-positive',
    border: 'border-signal-positive/20',
  },
  degraded: {
    label: 'Degraded',
    bg: 'bg-signal-warning/10',
    text: 'text-signal-warning',
    border: 'border-signal-warning/20',
  },
  open_circuit: {
    label: 'Open Circuit',
    bg: 'bg-signal-critical/10',
    text: 'text-signal-critical',
    border: 'border-signal-critical/20',
  },
  shorted: {
    label: 'Shorted',
    bg: 'bg-signal-critical/10',
    text: 'text-signal-critical',
    border: 'border-signal-critical/20',
  },
  offline: {
    label: 'Offline',
    bg: 'bg-paper',
    text: 'text-ink-3',
    border: 'border-divider',
  },
};

function degradationColor(pct: number): string {
  if (pct > 2) return 'text-signal-critical';
  if (pct > 1) return 'text-signal-warning';
  return 'text-signal-positive';
}

function degradationBg(pct: number): string {
  if (pct > 2) return 'from-red-50 to-red-100 border-signal-critical/20';
  if (pct > 1) return 'from-amber-50 to-amber-100 border-signal-warning/20';
  return 'from-emerald-50 to-emerald-100 border-signal-positive/20';
}

// ── Page component ─────────────────────────────────────────────────
export default function StringDetailPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const inverterId = decodeURIComponent(params.inverterId as string);
  const stringId = decodeURIComponent(params.stringId as string);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  const [stringData, setStringData] = useState<StringData | null>(null);
  const [parentMpptId, setParentMpptId] = useState<string | null>(null);
  // Twin timeseries fetched from parquet-query API (live model output, not static).
  const [voltageSeries, setVoltageSeries] = useState<TwinPoint[]>([]);
  const [currentSeries, setCurrentSeries] = useState<TwinPoint[]>([]);
  const [twinNote, setTwinNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Snapshot fixtures exist for demo/showcase plants and org plants that
        // ship one (e.g. the demo org's kilima-solar). Real operator plants
        // without a snapshot fall through to a friendly "not available".
        const snapRes = await fetch(
          `${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`
        );
        if (!snapRes.ok) {
          throw new Error('String telemetry is not available for this plant yet');
        }
        const snap: PlantMpptData = await snapRes.json();

        // Locate inverter
        const inverter = snap.inverters[inverterId];
        if (!inverter) {
          throw new Error(`Inverter "${inverterId}" not found`);
        }

        // Search for matching string across all MPPTs
        let found: StringData | null = null;
        let mpptId: string | null = null;

        for (const mppt of inverter.mppts) {
          const match = mppt.strings.find((s) => s.stringId === stringId);
          if (match) {
            found = match;
            mpptId = mppt.mpptId;
            break;
          }
        }

        if (!found || !mpptId) {
          throw new Error(
            `String "${stringId}" not found on inverter "${inverterId}"`
          );
        }

        if (!cancelled) {
          setStringData(found);
          setParentMpptId(mpptId);
        }

        // Fetch live twin timeseries from the parquet-query API.
        // - String voltage = parent MPPT's voltage (all strings on one MPPT
        //   share the same DC bus voltage).
        // - String current = own string's current.
        const from = '2020-01-01';
        const to = '2030-01-01';
        const stringDeviceId = `${inverterId}.${stringId}`; // e.g. "INV 01.057.STR-1"
        const mpptDeviceId = `${inverterId}.${mpptId}`;     // e.g. "INV 01.057.MPPT-1"

        try {
          const [voltRes, currRes] = await Promise.all([
            fetch(
              `/api/digitaltwin/${plantId}/parquet-query?device_id=${encodeURIComponent(mpptDeviceId)}&type=mppt_voltage&from=${from}&to=${to}`
            ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(
              `/api/digitaltwin/${plantId}/parquet-query?device_id=${encodeURIComponent(stringDeviceId)}&type=string_current&from=${from}&to=${to}`
            ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ]);
          if (!cancelled) {
            if (voltRes?.series) setVoltageSeries(voltRes.series);
            if (currRes?.series) setCurrentSeries(currRes.series);
            setTwinNote(twinProvenanceNote(voltRes?.modelVersion ?? currRes?.modelVersion ?? null));
          }
        } catch {
          // Optional, page still renders without timeseries.
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? 'Failed to load data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [plantId, inverterId, stringId, prefix]);

  // ── Loading state ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-blue-500" />
        <p className="text-sm text-ink-3">Loading string data...</p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────
  if (error || !stringData || !parentMpptId) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <FileWarning className="h-12 w-12 text-red-400" />
        <p className="text-signal-critical font-medium">{error ?? 'String not found'}</p>
        <Link
          href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId)}`}
          className="text-blue-600 hover:text-blue-700 text-sm"
        >
          Back to Inverter
        </Link>
      </div>
    );
  }

  const status = STATUS_STYLE[stringData.status];

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Breadcrumb ── */}
      <PlantBreadcrumb
        plantId={plantId}
        inverterId={inverterId}
        mpptId={parentMpptId}
        stringId={stringId}
      />

      {/* ── Title + status badge ───────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">
            {parentMpptId} / {stringId}
          </h1>
          <p className="text-ink-3 text-sm mt-0.5">
            Inverter {inverterId} &middot; {stringData.moduleCount} modules
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border ${status.bg} ${status.text} ${status.border}`}
        >
          {stringData.status === 'normal' ? (
            <ShieldCheck className="h-3.5 w-3.5" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5" />
          )}
          {status.label}
        </span>
      </div>

      {/* ── KPI cards (3x2 grid) ───────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Voltage */}
        <div className="bg-gradient-to-br from-amber-50 to-amber-100 border border-signal-warning/20 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            Voltage
          </div>
          <div className="text-3xl font-bold text-signal-warning mt-1.5 font-mono">
            {stringData.voltage_V.toFixed(1)}
            <span className="text-base ml-1 font-normal text-amber-500">V</span>
          </div>
        </div>

        {/* Current */}
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 border border-signal-positive/20 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <Activity className="h-3.5 w-3.5 text-emerald-500" />
            Current
          </div>
          <div className="text-3xl font-bold text-signal-positive mt-1.5 font-mono">
            {stringData.current_A.toFixed(2)}
            <span className="text-base ml-1 font-normal text-emerald-500">A</span>
          </div>
        </div>

        {/* Power */}
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <Gauge className="h-3.5 w-3.5 text-blue-500" />
            Power
          </div>
          <div className="text-3xl font-bold text-blue-600 mt-1.5 font-mono">
            {stringData.power_kW.toFixed(3)}
            <span className="text-base ml-1 font-normal text-blue-500">kW</span>
          </div>
        </div>

        {/* Module Count */}
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 rounded-xl p-4">
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <Layers className="h-3.5 w-3.5 text-purple-500" />
            Module Count
          </div>
          <div className="text-3xl font-bold text-purple-600 mt-1.5 font-mono">
            {stringData.moduleCount}
          </div>
        </div>

        {/* Degradation */}
        <div
          className={`bg-gradient-to-br border rounded-xl p-4 ${degradationBg(
            stringData.degradation_pct
          )}`}
        >
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <TrendingDown className="h-3.5 w-3.5" />
            Degradation
          </div>
          <div
            className={`text-3xl font-bold mt-1.5 font-mono ${degradationColor(
              stringData.degradation_pct
            )}`}
          >
            {stringData.degradation_pct.toFixed(2)}
            <span className="text-base ml-0.5 font-normal">%</span>
          </div>
        </div>

        {/* Status */}
        <div className="bg-gradient-to-br from-gray-50 to-gray-100 border border-divider rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-xs text-ink-2 uppercase tracking-wide">
            <ShieldCheck className="h-3.5 w-3.5 text-ink-3" />
            Status
          </div>
          <span
            className={`mt-2 inline-flex items-center self-start rounded-full px-3 py-1 text-sm font-semibold border ${status.bg} ${status.text} ${status.border}`}
          >
            {status.label}
          </span>
        </div>
      </div>

      {/* ── Twin charts (predicted vs actual, live model output) ── */}
      {twinNote && <p className="text-xs text-ink-3 mb-2">{twinNote}</p>}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-ink mb-1">
            DC Voltage Twin (parent MPPT)
          </h2>
          <p className="text-xs text-ink-3 mb-3">
            Predicted vs actual voltage on {parentMpptId} · {voltageSeries.length} points
          </p>
          <TwinTimelineChart series={voltageSeries} unit="V (DC)" />
        </div>
        <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-ink mb-1">
            DC Current Twin (this string)
          </h2>
          <p className="text-xs text-ink-3 mb-3">
            Predicted vs actual current on {stringId} · {currentSeries.length} points
          </p>
          <TwinTimelineChart
            series={currentSeries}
            unit="A (DC)"
            predictedColor="#10b981"
            actualColor="#059669"
          />
        </div>
      </div>

      {/* ── I-V Curve ──────────────────────────────────────────── */}
      <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-ink mb-1">I-V Curve</h2>
        <p className="text-xs text-ink-3 mb-4">
          Approximate curve derived from operating point. Red dot marks current
          measurement.
        </p>
        <IVCurveChart
          voltage_V={stringData.voltage_V}
          current_A={stringData.current_A}
          moduleCount={stringData.moduleCount}
          status={stringData.status}
        />
      </div>

      {/* ── Degradation Trend (info card) ──────────────────────── */}
      <div className="bg-white border border-divider rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-ink mb-4">
          Degradation Trend
        </h2>
        <div className="grid sm:grid-cols-3 gap-6">
          {/* Current degradation */}
          <div className="flex flex-col items-center text-center p-4 rounded-lg bg-paper">
            <span className="text-xs uppercase tracking-wide text-ink-3 mb-1">
              Current Degradation
            </span>
            <span
              className={`text-2xl font-bold font-mono ${degradationColor(
                stringData.degradation_pct
              )}`}
            >
              {stringData.degradation_pct.toFixed(2)}%
            </span>
          </div>

          {/* Estimated annual rate */}
          <div className="flex flex-col items-center text-center p-4 rounded-lg bg-paper">
            <span className="text-xs uppercase tracking-wide text-ink-3 mb-1">
              Est. Annual Rate
            </span>
            <span className="text-2xl font-bold font-mono text-ink-2">
              ~0.5-0.8%
              <span className="text-sm font-normal text-ink-3">/yr</span>
            </span>
          </div>

          {/* Module warranty */}
          <div className="flex flex-col items-center text-center p-4 rounded-lg bg-paper">
            <span className="text-xs uppercase tracking-wide text-ink-3 mb-1">
              Module Warranty
            </span>
            <span className="text-sm font-medium text-ink-2 leading-relaxed">
              Typically 25 years
              <br />
              <span className="text-ink-3">&gt;80% output guaranteed</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
