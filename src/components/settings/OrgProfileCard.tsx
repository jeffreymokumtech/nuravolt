'use client';

import { useEffect, useState } from 'react';
import { Building2, Check } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

/**
 * Organization profile card for the settings index: rename the org (mirrored
 * into the legacy Organization row by the afterUpdateOrganization auth hook)
 * plus a read-only plan/seat summary from the billing API.
 */
export default function OrgProfileCard() {
  const { data: org } = authClient.useActiveOrganization();
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ plan?: string; limits?: { seats?: number } } | null>(null);

  useEffect(() => {
    if (org?.name && !dirty) setName(org.name);
  }, [org?.name, dirty]);

  useEffect(() => {
    fetch('/api/billing/plan')
      .then((r) => (r.ok ? r.json() : null))
      .then(setPlan)
      .catch(() => {});
  }, []);

  async function save() {
    const trimmed = name.trim();
    if (!org || !trimmed || trimmed === org.name) return;
    setErr(null);
    setState('saving');
    const { error } = await authClient.organization.update({
      organizationId: org.id,
      data: { name: trimmed },
    });
    if (error) {
      setErr(error.message || 'Failed to rename the organization.');
      setState('idle');
      return;
    }
    setDirty(false);
    setState('saved');
    setTimeout(() => setState('idle'), 2000);
  }

  const seats = plan?.limits?.seats;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
          <Building2 className="h-5 w-5 text-blue-600" />
        </span>
        <div>
          <span className="block text-sm font-semibold text-gray-900">Organization profile</span>
          <span className="block text-xs text-gray-500">
            {plan?.plan ? `${plan.plan.charAt(0).toUpperCase()}${plan.plan.slice(1)} plan` : 'Plan'}
            {seats != null && Number.isFinite(seats) ? ` · ${seats} seats` : ''}
          </span>
        </div>
      </div>
      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1">
          <span className="block text-xs font-medium text-gray-700">Organization name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder={org?.name ?? 'Organization name'}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={state === 'saving' || !org || !name.trim() || name.trim() === org?.name}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state === 'saved' ? (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          ) : state === 'saving' ? (
            'Saving…'
          ) : (
            'Save'
          )}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}
