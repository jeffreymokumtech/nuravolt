'use client';

/**
 * Integrations settings: outbound webhooks on ticket events. One real
 * mechanism (signed generic webhook) that works with monday.com, Jira
 * Automation, TabTool, Make/Zapier, or any CMMS that accepts an incoming
 * webhook. Copy rules: sentence case, no dashes, no emoji, honest about
 * what is native vs webhook-based.
 */

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Webhook, Copy, Trash2, Send, CheckCircle2, XCircle } from 'lucide-react';
import OpsOrgShell from '@/components/ops/OpsOrgShell';
import UpgradeGate from '@/components/billing/UpgradeGate';

interface Delivery {
  id: string;
  event: string;
  status: string;
  response_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface Hook {
  id: string;
  name: string;
  url: string;
  secret_masked: string;
  events: string[];
  active: boolean;
  created_at: string;
  recent_deliveries: Delivery[];
}

const EVENT_OPTIONS = [
  { value: 'ticket.created', label: 'Ticket created' },
  { value: 'ticket.status_changed', label: 'Ticket status changed' },
  { value: 'alert.opened', label: 'Alert opened' },
  { value: 'alert.resolved', label: 'Alert resolved' },
  { value: 'alert.acknowledged', label: 'Alert acknowledged' },
];

const CATALOG = [
  {
    name: 'monday.com',
    blurb:
      'Works today through the generic webhook: point it at a monday.com automation webhook and new tickets appear as items on your board. Native integration is planned.',
  },
  {
    name: 'TabTool PV O&M',
    blurb:
      'Field service teams on TabTool can receive ticket events through the generic webhook via a middleware like Make. Native integration is planned.',
  },
  {
    name: 'Jira',
    blurb:
      'Point the generic webhook at a Jira Automation incoming webhook to open issues from NuraVolt tickets, with status transitions mirrored.',
  },
  {
    name: 'Make and Zapier',
    blurb:
      'Both accept the generic webhook directly, so you can route ticket events to email, Slack, Teams, or any CMMS with a connector.',
  },
];

function IntegrationsPageInner() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['ticket.created', 'ticket.status_changed']);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/integrations/webhooks');
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setHooks(d.webhooks ?? []);
    } catch {
      setHooks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/integrations/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, events }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setNewSecret(d.secret);
      setName('');
      setUrl('');
      toast.success('Webhook created');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create webhook');
    } finally {
      setCreating(false);
    }
  };

  const sendTest = async (id: string) => {
    setTesting(id);
    try {
      const res = await fetch(`/api/integrations/webhooks/${id}/test`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      const ok = d.delivery?.status === 'success';
      if (ok) toast.success(`Test delivered (HTTP ${d.delivery.response_code})`);
      else toast.error(`Test failed: ${d.delivery?.error ?? 'no response'}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(null);
    }
  };

  const toggleActive = async (h: Hook) => {
    await fetch(`/api/integrations/webhooks/${h.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !h.active }),
    });
    await load();
  };

  const remove = async (h: Hook) => {
    if (!confirm(`Delete webhook "${h.name}"? Deliveries stop immediately.`)) return;
    await fetch(`/api/integrations/webhooks/${h.id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-1 flex items-center gap-2">
        <Webhook className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-semibold text-gray-900">Integrations</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-gray-500">
        Send ticket and alert events to your O&amp;M tools as signed webhooks. Every delivery is a
        JSON POST with an HMAC SHA-256 signature in the x-nuravolt-signature header so the
        receiver can verify it came from NuraVolt.
      </p>

      {/* Generic webhook: the real mechanism */}
      <section className="mb-8 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-semibold text-gray-900">Generic webhook</h2>
        <p className="mb-4 text-xs text-gray-500">
          Point it at any HTTPS endpoint. Events: ticket and alert lifecycle.
        </p>

        {newSecret && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
            <div className="mb-1 font-semibold text-amber-800">
              Signing secret (shown once, store it now)
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-[11px] text-gray-800">
                {newSecret}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(newSecret);
                  toast.success('Copied');
                }}
                className="rounded border border-amber-300 bg-white p-1.5 text-amber-700 hover:bg-amber-100"
                aria-label="Copy secret"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setNewSecret(null)}
              className="mt-2 text-[11px] text-amber-700 underline"
            >
              I stored it, hide the secret
            </button>
          </div>
        )}

        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maintenance board"
              className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Endpoint URL
            </span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hook.example.com/nuravolt"
              className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-mono"
            />
          </label>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          {EVENT_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1.5 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={events.includes(opt.value)}
                onChange={(e) =>
                  setEvents((prev) =>
                    e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value)
                  )
                }
              />
              {opt.label}
            </label>
          ))}
          <button
            type="button"
            onClick={create}
            disabled={creating || name.trim().length < 2 || !url.trim() || events.length === 0}
            className="ml-auto rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create webhook'}
          </button>
        </div>

        {loading ? (
          <div className="py-4 text-center text-xs text-gray-400">Loading…</div>
        ) : hooks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 py-6 text-center text-xs text-gray-400">
            No webhooks configured yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {hooks.map((h) => (
              <li key={h.id} className="rounded-lg border border-gray-100 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${h.active ? 'bg-emerald-500' : 'bg-gray-300'}`}
                    title={h.active ? 'Active' : 'Paused'}
                  />
                  <span className="text-sm font-semibold text-gray-900">{h.name}</span>
                  <code className="truncate font-mono text-[11px] text-gray-500">{h.url}</code>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => sendTest(h.id)}
                      disabled={testing === h.id}
                      className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                    >
                      <Send className="h-3 w-3" />
                      {testing === h.id ? 'Sending…' : 'Send test event'}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(h)}
                      className="rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      {h.active ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(h)}
                      className="rounded-md p-1 text-gray-300 hover:text-red-500"
                      aria-label="Delete webhook"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  Secret {h.secret_masked} · events: {h.events.join(', ')}
                </div>
                {h.recent_deliveries.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {h.recent_deliveries.map((d) => (
                      <span
                        key={d.id}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ring-1 ${
                          d.status === 'success'
                            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                            : 'bg-red-50 text-red-600 ring-red-200'
                        }`}
                        title={`${d.event} · ${d.error ?? `HTTP ${d.response_code}`} · ${d.duration_ms ?? '?'}ms`}
                      >
                        {d.status === 'success' ? (
                          <CheckCircle2 className="h-2.5 w-2.5" />
                        ) : (
                          <XCircle className="h-2.5 w-2.5" />
                        )}
                        {d.event.replace(/^(ticket|alert)\./, '')}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Catalog: where the webhook plugs in */}
      <h2 className="mb-3 text-sm font-semibold text-gray-900">Works with your O&amp;M stack</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CATALOG.map((c) => (
          <div key={c.name} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-1 text-sm font-semibold text-gray-900">{c.name}</div>
            <p className="text-xs leading-relaxed text-gray-500">{c.blurb}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <OpsOrgShell activeNavKey="integrations" section="SETTINGS">
      <UpgradeGate
        feature="integrations:webhooks"
        fullPage
        title="Integrations are included with Business"
        blurb="Upgrade to Business to stream ticket events into monday.com, Jira, or any O&M tool that accepts webhooks."
      >
        <IntegrationsPageInner />
      </UpgradeGate>
    </OpsOrgShell>
  );
}
