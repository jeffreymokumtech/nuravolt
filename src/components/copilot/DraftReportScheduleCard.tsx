'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

/**
 * Confirm card for proposeReportSchedule drafts. Nothing persists until the
 * user presses Schedule, which POSTs the existing /api/reports route.
 * Honest copy: sends happen at 07:00 UTC (the cron's only run time), and a
 * plant scope is a filter over the portfolio report.
 */

interface ReportScheduleDraft {
  name: string;
  dashboard_id?: string | null;
  dashboard_title?: string | null;
  schedule: 'weekly' | 'monthly';
  send_day_of_week: number | null;
  send_day_of_month: number | null;
  period: 'last_7d' | 'last_30d' | 'last_month';
  recipient_emails: string[];
  plant_slug: string | null;
  plant_name: string | null;
  include_summary: boolean;
  include_risk: boolean;
  include_losses: boolean;
  cadence_label?: string;
}

type Status = 'draft' | 'creating' | 'created' | 'dismissed' | 'error';

const ISO_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PERIODS: Array<{ value: ReportScheduleDraft['period']; label: string }> = [
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_30d', label: 'Last 30 days' },
  { value: 'last_month', label: 'Last month' },
];

export function DraftReportScheduleCard({ draft }: { draft: ReportScheduleDraft }) {
  const isScripted = useIsScriptedThread();
  const [status, setStatus] = useState<Status>('draft');
  const [editable, setEditable] = useState<ReportScheduleDraft>(draft);
  const [recipientsText, setRecipientsText] = useState(draft.recipient_emails.join(', '));
  const [error, setError] = useState<string | null>(null);

  const recipients = recipientsText
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /.+@.+\..+/.test(s));

  const create = async () => {
    setStatus('creating');
    setError(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editable.name,
          schedule: editable.schedule,
          period: editable.period,
          recipient_emails: recipients,
          plant_ids: editable.plant_slug ? [editable.plant_slug] : [],
          report_type: 'portfolio',
          include_summary: editable.include_summary,
          include_risk: editable.include_risk,
          include_losses: editable.include_losses,
          send_day_of_week: editable.schedule === 'weekly' ? editable.send_day_of_week ?? 1 : undefined,
          send_day_of_month: editable.schedule === 'monthly' ? editable.send_day_of_month ?? 1 : undefined,
          dashboard_id: editable.dashboard_id ?? undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setStatus('created');
      toast.success('Report scheduled');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to schedule report');
      toast.error('Could not schedule report');
    }
  };

  if (status === 'created') {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Report scheduled</div>
        <div className="mt-1 text-gray-700">
          {editable.name} · {editable.schedule} · first send at the next 07:00 UTC slot.{' '}
          <Link href="/dashboard/reports" className="text-blue-600 underline">
            Manage in Reports
          </Link>
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

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-blue-700">
          Draft report schedule · review &amp; confirm
        </span>
        <span className="text-[10px] text-gray-500">
          {editable.plant_name ? `Filtered to ${editable.plant_name}` : 'Whole portfolio'}
        </span>
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Name</span>
        <input
          value={editable.name}
          onChange={(e) => setEditable({ ...editable, name: e.target.value })}
          disabled={status === 'creating'}
          className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
        />
      </label>

      <div className="mb-2 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Cadence</span>
          <select
            value={editable.schedule}
            onChange={(e) =>
              setEditable({ ...editable, schedule: e.target.value as ReportScheduleDraft['schedule'] })
            }
            disabled={status === 'creating'}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        {editable.schedule === 'weekly' ? (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Day</span>
            <select
              value={editable.send_day_of_week ?? 1}
              onChange={(e) => setEditable({ ...editable, send_day_of_week: Number(e.target.value) })}
              disabled={status === 'creating'}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
            >
              {ISO_DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Day</span>
            <select
              value={editable.send_day_of_month ?? 1}
              onChange={(e) => setEditable({ ...editable, send_day_of_month: Number(e.target.value) })}
              disabled={status === 'creating'}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
            >
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Window</span>
          <select
            value={editable.period}
            onChange={(e) =>
              setEditable({ ...editable, period: e.target.value as ReportScheduleDraft['period'] })
            }
            disabled={status === 'creating'}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">
          Recipients (comma separated)
        </span>
        <input
          value={recipientsText}
          onChange={(e) => setRecipientsText(e.target.value)}
          disabled={status === 'creating'}
          placeholder="ops@yourcompany.com"
          className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
        />
      </label>

      <div className="mb-2 flex flex-wrap gap-3">
        {(
          [
            ['include_summary', 'Summary'],
            ['include_risk', 'Risk'],
            ['include_losses', 'Losses'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1 text-[11px] text-gray-700">
            <input
              type="checkbox"
              checked={editable[key]}
              onChange={(e) => setEditable({ ...editable, [key]: e.target.checked })}
              disabled={status === 'creating'}
            />
            {label}
          </label>
        ))}
      </div>

      {editable.dashboard_id && (
        <div className="mb-2 flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-200">
            Attached report: {editable.dashboard_title ?? 'Composed report'}
            <button
              type="button"
              onClick={() => setEditable({ ...editable, dashboard_id: null, dashboard_title: null })}
              className="ml-0.5 text-blue-400 hover:text-blue-700"
              aria-label="Detach report"
              title="Detach: send the standard portfolio PDF instead"
            >
              ✕
            </button>
          </span>
        </div>
      )}

      <div className="mb-2 text-[10px] text-gray-500">
        {editable.dashboard_id
          ? 'Sends this composed report as a PDF at 07:00 UTC on the chosen day.'
          : 'Sends as a portfolio PDF at 07:00 UTC on the chosen day.'}
      </div>

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
          disabled={status === 'creating' || isScripted}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={create}
          disabled={status === 'creating' || !editable.name.trim() || recipients.length === 0 || isScripted}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'creating' ? 'Scheduling…' : 'Schedule'}
        </button>
      </div>
    </div>
  );
}
