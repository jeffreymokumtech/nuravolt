'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { BellRing } from 'lucide-react';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

/**
 * Confirm card for proposeAlarm drafts. Applying PUTs the plant settings
 * (requires MANAGE access on the plant). Honest copy about what alarms can
 * and cannot do — the thresholds are plant-wide, evaluated hourly, and only
 * newly critical breaches email org managers.
 */

interface AlarmValues {
  soilingLossPct: number;
  performanceRatioPct: number;
  emailCritical: boolean;
}

interface AlarmDraft {
  plant_id: string;
  plant_slug: string;
  plant_name: string;
  current: AlarmValues;
  proposed: AlarmValues;
}

type Status = 'draft' | 'applying' | 'applied' | 'dismissed' | 'error';

export function DraftAlarmCard({ draft }: { draft: AlarmDraft }) {
  const isScripted = useIsScriptedThread();
  const [status, setStatus] = useState<Status>('draft');
  const [values, setValues] = useState<AlarmValues>(draft.proposed);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setStatus('applying');
    setError(null);
    try {
      const res = await fetch(`/api/plants/${encodeURIComponent(draft.plant_slug)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alerts: {
            soilingLossPct: values.soilingLossPct,
            performanceRatioPct: values.performanceRatioPct,
          },
          notifications: { emailCritical: values.emailCritical },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(
          res.status === 403
            ? 'You need MANAGE access on this plant to change alarms.'
            : d.error ?? `HTTP ${res.status}`
        );
      }
      setStatus('applied');
      toast.success('Alarm thresholds updated');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to update alarms');
      toast.error('Could not update alarms');
    }
  };

  if (status === 'applied') {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Alarms updated · {draft.plant_name}</div>
        <div className="mt-1 text-gray-700">
          Soiling loss ≥ {values.soilingLossPct}% · PR &lt; {values.performanceRatioPct}% ·
          critical emails {values.emailCritical ? 'on' : 'off'}. Evaluated hourly.
        </div>
      </div>
    );
  }

  if (status === 'dismissed') {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
        Draft dismissed.
      </div>
    );
  }

  const Row = ({
    label,
    current,
    children,
  }: {
    label: string;
    current: string;
    children: React.ReactNode;
  }) => (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-36 shrink-0 text-[11px] text-gray-600">{label}</span>
      <span className="w-16 shrink-0 text-[10px] text-gray-400">now {current}</span>
      {children}
    </div>
  );

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-blue-700">
          <BellRing className="h-3 w-3" /> Alarm thresholds · review &amp; confirm
        </span>
        <span className="text-[10px] text-gray-500">{draft.plant_name}</span>
      </div>

      <Row label="Soiling loss alarm at" current={`${draft.current.soilingLossPct}%`}>
        <input
          type="number"
          min={0}
          max={50}
          step={0.5}
          value={values.soilingLossPct}
          onChange={(e) => setValues({ ...values, soilingLossPct: Number(e.target.value) })}
          disabled={status === 'applying'}
          className="w-20 rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        />
        <span className="text-[10px] text-gray-500">% loss (SR {(1 - values.soilingLossPct / 100).toFixed(2)})</span>
      </Row>

      <Row label="Performance ratio below" current={`${draft.current.performanceRatioPct}%`}>
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={values.performanceRatioPct}
          onChange={(e) => setValues({ ...values, performanceRatioPct: Number(e.target.value) })}
          disabled={status === 'applying'}
          className="w-20 rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        />
        <span className="text-[10px] text-gray-500">% trailing 7 days</span>
      </Row>

      <label className="mb-2 flex items-center gap-2 text-[11px] text-gray-700">
        <input
          type="checkbox"
          checked={values.emailCritical}
          onChange={(e) => setValues({ ...values, emailCritical: e.target.checked })}
          disabled={status === 'applying'}
        />
        Email org managers on newly critical breaches
      </label>

      <p className="mb-2 text-[10px] leading-snug text-gray-500">
        Plant-wide thresholds, evaluated hourly. Data staleness alerts are fixed at 6 hours.
        Per-inverter or custom-metric alarms are not available.
      </p>

      {error && (
        <div className="mb-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <button
          type="button"
          onClick={() => setStatus('dismissed')}
          disabled={status === 'applying' || isScripted}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={status === 'applying' || isScripted}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'applying' ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
