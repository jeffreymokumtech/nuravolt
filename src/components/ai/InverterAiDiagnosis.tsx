'use client';

import { useState, useEffect } from 'react';
import { Sparkles, AlertCircle, AlertTriangle, CheckCircle2, Ticket, Droplets, Wrench, Eye, Zap, Cable } from 'lucide-react';

interface DiagnosisResponse {
  plantId: string;
  inverterId: string;
  diagnosis: {
    summary: string;
    severity: 'normal' | 'investigate' | 'urgent' | string;
    actions: string[];
    fault_hypothesis: {
      code: string;
      name: string;
      confidence: number;
    } | null;
    reasoning?: string;
  };
  stats: any;
  model: string;
  latency_ms: number;
  generated_at: string;
  plant_uuid?: string;
  cached?: boolean;
}

// Each suggested action opens a maintenance ticket pre-filled from the
// diagnosis (except "monitor", which is a no-op acknowledgement).
const ACTION_TICKET_META: Record<string, { verb: string; trigger: string }> = {
  create_ticket: { verb: 'Investigate', trigger: 'PERFORMANCE_ANOMALY' },
  schedule_cleaning: { verb: 'Schedule cleaning', trigger: 'SCHEDULED_MAINTENANCE' },
  schedule_inspection: { verb: 'Schedule inspection', trigger: 'SCHEDULED_MAINTENANCE' },
  check_shading: { verb: 'Check shading', trigger: 'PERFORMANCE_ANOMALY' },
  check_wiring: { verb: 'Check wiring', trigger: 'PERFORMANCE_ANOMALY' },
  verify_grid: { verb: 'Verify grid connection', trigger: 'PERFORMANCE_ANOMALY' },
  replace_sensor: { verb: 'Replace sensor', trigger: 'PERFORMANCE_ANOMALY' },
};

function priorityFromSeverity(sev: string): string {
  if (sev === 'urgent') return 'HIGH';
  if (sev === 'investigate') return 'MEDIUM';
  return 'LOW';
}

interface Props {
  plantId: string;
  inverterId: string;
}

const ACTION_META: Record<string, { label: string; icon: any; color: string }> = {
  create_ticket: { label: 'Create O&M Ticket', icon: Ticket, color: 'bg-blue-600 hover:bg-blue-700' },
  schedule_cleaning: { label: 'Schedule Cleaning', icon: Droplets, color: 'bg-amber-600 hover:bg-amber-700' },
  schedule_inspection: { label: 'Schedule Inspection', icon: Wrench, color: 'bg-purple-600 hover:bg-purple-700' },
  monitor: { label: 'Continue Monitoring', icon: Eye, color: 'bg-gray-500 hover:bg-gray-600' },
  check_shading: { label: 'Check Shading', icon: Eye, color: 'bg-yellow-600 hover:bg-yellow-700' },
  check_wiring: { label: 'Check Wiring', icon: Cable, color: 'bg-orange-600 hover:bg-orange-700' },
  verify_grid: { label: 'Verify Grid Connection', icon: Zap, color: 'bg-red-600 hover:bg-red-700' },
  replace_sensor: { label: 'Replace Sensor', icon: Wrench, color: 'bg-red-500 hover:bg-red-600' },
};

const SEVERITY_META: Record<string, { label: string; bg: string; text: string; icon: any }> = {
  normal: { label: 'Normal', bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', icon: CheckCircle2 },
  investigate: { label: 'Investigate', bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', icon: AlertTriangle },
  urgent: { label: 'Urgent', bg: 'bg-red-50 border-red-200', text: 'text-red-700', icon: AlertCircle },
};

export default function InverterAiDiagnosis({ plantId, inverterId }: Props) {
  const [diagnosis, setDiagnosis] = useState<DiagnosisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, 'busy' | 'done' | 'error'>>({});
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Pre-load the last stored diagnosis (no inference, no cost) so the panel
  // shows prior findings without a paid re-run.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ai/inverter-diagnosis/${plantId}/${encodeURIComponent(inverterId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.diagnosis) setDiagnosis(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plantId, inverterId]);

  const runDiagnosis = async () => {
    const isRerun = Boolean(diagnosis);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/ai/inverter-diagnosis/${plantId}/${encodeURIComponent(inverterId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: isRerun }),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || err.details || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDiagnosis(data);
      setActionState({});
      setActionMsg(null);
    } catch (err: any) {
      setError(err.message || 'Failed to run diagnosis');
    } finally {
      setLoading(false);
    }
  };

  // Open a maintenance ticket pre-filled from the diagnosis. "monitor" is a
  // no-op acknowledgement (nothing to action).
  const handleAction = async (action: string) => {
    if (!diagnosis) return;
    if (action === 'monitor') {
      setActionMsg('Continuing to monitor this inverter. No ticket created.');
      return;
    }
    const plantUuid = diagnosis.plant_uuid;
    if (!plantUuid) {
      setActionMsg('Run the diagnosis again to enable ticket creation.');
      return;
    }
    const meta = ACTION_TICKET_META[action] ?? { verb: ACTION_META[action]?.label ?? action, trigger: 'PERFORMANCE_ANOMALY' };
    const fault = diagnosis.diagnosis.fault_hypothesis;
    const title = fault?.name
      ? `${inverterId}: ${meta.verb.toLowerCase()} (${fault.name})`
      : `${inverterId}: ${meta.verb.toLowerCase()}`;
    const description = [
      diagnosis.diagnosis.summary,
      diagnosis.diagnosis.reasoning ? `Reasoning: ${diagnosis.diagnosis.reasoning}` : '',
      fault ? `Likely Huawei alarm ${fault.code} (${fault.name}).` : '',
      'Opened from the AI diagnostic analysis.',
    ]
      .filter(Boolean)
      .join('\n\n');

    setActionState((s) => ({ ...s, [action]: 'busy' }));
    setActionMsg(null);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plant_id: plantUuid,
          inverter_id: inverterId,
          title,
          description,
          priority: priorityFromSeverity(diagnosis.diagnosis.severity),
          trigger_type: meta.trigger,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setActionState((s) => ({ ...s, [action]: 'done' }));
      setActionMsg(`Ticket created: ${title}`);
    } catch (e) {
      setActionState((s) => ({ ...s, [action]: 'error' }));
      setActionMsg(e instanceof Error ? e.message : 'Could not create the ticket');
    }
  };

  const sevMeta = diagnosis ? SEVERITY_META[diagnosis.diagnosis.severity] ?? SEVERITY_META.investigate : null;
  const SevIcon = sevMeta?.icon;

  return (
    <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-xl shadow-sm overflow-hidden">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">AI Diagnostic Analysis</h2>
              <p className="text-xs text-gray-500">
                Interprets the power/temperature/current twins, fleet rank trajectory and string-voltage dispersion against the Huawei SUN2000 manual · Qwen3 on AWS Bedrock (EU)
              </p>
            </div>
          </div>
          <button
            onClick={runDiagnosis}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                {diagnosis ? 'Re-run Analysis' : 'Run AI Diagnosis'}
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <AlertCircle className="inline w-4 h-4 mr-1" /> {error}
          </div>
        )}

        {diagnosis && sevMeta && SevIcon && (
          <div className="space-y-4">
            {/* Severity + Summary */}
            <div className={`rounded-lg border p-4 ${sevMeta.bg}`}>
              <div className="flex items-start gap-3">
                <SevIcon className={`w-5 h-5 mt-0.5 ${sevMeta.text}`} />
                <div className="flex-1">
                  <div className={`text-sm font-semibold uppercase tracking-wide ${sevMeta.text}`}>
                    {sevMeta.label}
                  </div>
                  <p className="text-gray-800 mt-1">{diagnosis.diagnosis.summary}</p>
                  {diagnosis.diagnosis.reasoning && (
                    <p className="text-xs text-gray-500 mt-2 italic">{diagnosis.diagnosis.reasoning}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Fault hypothesis */}
            {diagnosis.diagnosis.fault_hypothesis && (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Likely Fault Code
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm font-semibold text-gray-900">
                      Alarm {diagnosis.diagnosis.fault_hypothesis.code}
                    </span>
                    <span className="text-gray-700 ml-2">{diagnosis.diagnosis.fault_hypothesis.name}</span>
                  </div>
                  <span className="text-xs text-gray-500">
                    Confidence: {Math.round((diagnosis.diagnosis.fault_hypothesis.confidence ?? 0) * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* Suggested actions */}
            {diagnosis.diagnosis.actions.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Suggested Follow-up Actions
                </div>
                <div className="flex flex-wrap gap-2">
                  {diagnosis.diagnosis.actions.map((action) => {
                    const meta = ACTION_META[action] ?? {
                      label: action,
                      icon: Wrench,
                      color: 'bg-gray-500 hover:bg-gray-600',
                    };
                    const Icon = meta.icon;
                    const st = actionState[action];
                    return (
                      <button
                        key={action}
                        disabled={st === 'busy' || st === 'done'}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-white text-sm rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${meta.color}`}
                        onClick={() => handleAction(action)}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {st === 'done' && action !== 'monitor'
                          ? 'Ticket created'
                          : st === 'busy'
                            ? 'Creating…'
                            : meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {actionMsg && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                {actionMsg}
              </div>
            )}

            <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
              {diagnosis.cached
                ? `Last run ${new Date(diagnosis.generated_at).toLocaleString()} · Model: ${diagnosis.model}`
                : `Generated in ${diagnosis.latency_ms}ms · Model: ${diagnosis.model}`}
            </div>
          </div>
        )}

        {!diagnosis && !loading && !error && (
          <p className="text-sm text-gray-500">
            Click <strong>Run AI Diagnosis</strong> to have the AI interpret this inverter's 4 twin metrics
            against the Huawei SUN2000 fault code reference and suggest follow-up actions.
          </p>
        )}
      </div>
    </div>
  );
}
