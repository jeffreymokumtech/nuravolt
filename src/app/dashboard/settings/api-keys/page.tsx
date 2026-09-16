'use client';

import { useEffect, useMemo, useState } from 'react';
import { Key, Plus, Trash2, Copy, Check, AlertTriangle, X, History, CheckCircle2, AlertCircle, ShieldX, Clock } from 'lucide-react';
import {
  ALL_SCOPES,
  READ_ONLY_SCOPES,
  FULL_AGENT_SCOPES,
  type Scope,
} from '@/lib/mcp/scopes';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const SCOPE_LABELS: Record<Scope, string> = {
  'plants:read': 'Plants, read',
  'inverters:read': 'Inverters, read',
  'soiling:read': 'Soiling forecast, read',
  'bess:read': 'BESS revenue, warranty and optimizer audit, read',
  'faults:read': 'Faults & classification, read',
  'tickets:read': 'Tickets, read',
  'kb:read': 'Knowledge base, search',
  'diagnosis:run': 'Inverter AI diagnosis, run (paid inference)',
  'tickets:write': 'Tickets, create / update / comment',
  'cleaning:write': 'Cleaning schedule, approve',
  'reports:write': 'Report schedules, create',
};

function relativeTime(iso: string | null): string {
  if (!iso) return ',';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [justMinted, setJustMinted] = useState<{ token: string; name: string } | null>(null);
  // null while the plan is loading; API keys unlock on Business and Enterprise.
  const [canGenerateKeys, setCanGenerateKeys] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/billing/plan')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCanGenerateKeys(data?.features?.['mcp:api_keys'] ?? false))
      .catch(() => setCanGenerateKeys(false));
  }, []);

  async function loadKeys() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp-keys');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(data.keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  async function revokeKey(id: string) {
    if (!confirm('Revoke this key? Any client using it will lose access immediately.')) return;
    const res = await fetch(`/api/mcp-keys/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert(`Failed to revoke: HTTP ${res.status}`);
      return;
    }
    loadKeys();
  }

  return (
    <OpsOrgShell activeNavKey="api-keys" section="API KEYS">
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Key className="h-6 w-6 text-blue-600" />
            MCP API keys
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Generate keys to let external AI assistants (Claude Desktop, ChatGPT, Cursor) query
            your NuraVolt data over the Model Context Protocol.{' '}
            <a
              href="/mcp"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener"
            >
              Setup guide →
            </a>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            disabled={canGenerateKeys !== true}
            title={
              canGenerateKeys === false
                ? 'MCP API keys are available on Business and Enterprise plans.'
                : undefined
            }
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Generate key
          </button>
          {canGenerateKeys === false && (
            <a href="/pricing" className="text-xs text-blue-600 hover:underline">
              Upgrade to Business to generate keys
            </a>
          )}
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="p-12 text-center">
            <Key className="mx-auto h-10 w-10 text-gray-300" />
            <p className="mt-3 text-sm text-gray-500">
              No API keys yet. Generate one to connect Claude or ChatGPT to your NuraVolt data.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Prefix</th>
                <th className="px-4 py-2">Scopes</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {keys.map((k) => {
                const isRevoked = !!k.revoked_at;
                return (
                  <tr key={k.id} className={isRevoked ? 'opacity-50' : ''}>
                    <td className="px-4 py-3 font-medium text-gray-900">{k.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {k.prefix}…
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {k.scopes.length} scope{k.scopes.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {relativeTime(k.last_used_at)}
                    </td>
                    <td className="px-4 py-3">
                      {isRevoked ? (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                          Revoked
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!isRevoked && (
                        <button
                          type="button"
                          onClick={() => revokeKey(k.id)}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                          title="Revoke"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <AuditPanel />

      {showGenerate && (
        <GenerateKeyDialog
          onClose={() => setShowGenerate(false)}
          onMinted={(token, name) => {
            setShowGenerate(false);
            setJustMinted({ token, name });
            loadKeys();
          }}
        />
      )}

      {justMinted && (
        <RevealKeyDialog
          token={justMinted.token}
          name={justMinted.name}
          onClose={() => setJustMinted(null)}
        />
      )}
    </div>
    </OpsOrgShell>
  );
}

interface AuditCall {
  id: string;
  api_key_id: string;
  api_key_name: string | null;
  api_key_prefix: string | null;
  tool_name: string;
  status: 'success' | 'error' | 'forbidden' | 'rate_limited';
  error_reason: string | null;
  duration_ms: number;
  idempotency_key: string | null;
  ticket_id: string | null;
  cleaning_schedule_id: string | null;
  created_at: string;
}

function AuditPanel() {
  const [calls, setCalls] = useState<AuditCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/mcp-keys/audit?limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCalls(data.calls);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const c = { success: 0, error: 0, forbidden: 0, rate_limited: 0 };
    for (const r of calls) c[r.status]++;
    return c;
  }, [calls]);

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <History className="h-4 w-4 text-gray-500" />
            Recent tool calls
          </h2>
          <p className="text-xs text-gray-500">
            Last 50 MCP calls from any key in this org. Helps you see what external AI
            assistants are actually doing.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Badge tone="emerald" icon={<CheckCircle2 className="h-3 w-3" />}>
            {counts.success} ok
          </Badge>
          <Badge tone="red" icon={<AlertCircle className="h-3 w-3" />}>
            {counts.error} err
          </Badge>
          <Badge tone="amber" icon={<ShieldX className="h-3 w-3" />}>
            {counts.forbidden} forbidden
          </Badge>
          <Badge tone="gray" icon={<Clock className="h-3 w-3" />}>
            {counts.rate_limited} 429
          </Badge>
          <button
            type="button"
            onClick={load}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
      </header>

      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4" />
          {err}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
        ) : calls.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            No tool calls yet. Connect Claude Desktop or ChatGPT with one of your keys to start
            seeing activity here.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 bg-gray-50 text-left font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Tool</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Idempotency</th>
                <th className="px-3 py-2">Side effect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {calls.map((c) => (
                <tr key={c.id} className="font-mono text-[11px]">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                    {relativeTime(c.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-900">
                    <span className="font-sans">{c.api_key_name ?? ','}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{c.tool_name.replace('nuravolt_', '')}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={c.status} reason={c.error_reason} />
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{c.duration_ms}ms</td>
                  <td className="px-3 py-2 text-gray-500">{c.idempotency_key ?? ','}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {c.ticket_id ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
                        ticket {c.ticket_id.slice(0, 8)}…
                      </span>
                    ) : c.cleaning_schedule_id ? (
                      <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700">
                        schedule {c.cleaning_schedule_id.slice(0, 8)}…
                      </span>
                    ) : (
                      ','
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Badge({
  tone,
  icon,
  children,
}: {
  tone: 'emerald' | 'red' | 'amber' | 'gray';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-gray-100 text-gray-600',
  } as const;
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

function StatusPill({ status, reason }: { status: AuditCall['status']; reason: string | null }) {
  const config = {
    success: { bg: 'bg-emerald-50 text-emerald-700', label: 'ok' },
    error: { bg: 'bg-red-50 text-red-700', label: reason ?? 'error' },
    forbidden: { bg: 'bg-amber-50 text-amber-700', label: reason ?? 'forbidden' },
    rate_limited: { bg: 'bg-gray-100 text-gray-600', label: reason ?? 'rate limited' },
  }[status];
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${config.bg}`}
      title={reason ?? undefined}
    >
      {config.label}
    </span>
  );
}

function GenerateKeyDialog({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (token: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(READ_ONLY_SCOPES));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleScope = (s: Scope) => {
    const next = new Set(scopes);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setScopes(next);
  };

  const preset = useMemo(() => {
    const arr = [...scopes].sort();
    if (
      arr.join(',') === [...READ_ONLY_SCOPES].sort().join(',')
    )
      return 'read-only';
    if (arr.join(',') === [...FULL_AGENT_SCOPES].sort().join(','))
      return 'full-agent';
    return 'custom';
  }, [scopes]);

  async function submit() {
    setErr(null);
    if (!name.trim()) {
      setErr('Please give the key a name.');
      return;
    }
    if (scopes.size === 0) {
      setErr('Pick at least one scope.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/mcp-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: [...scopes] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.detail ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      onMinted(data.token, data.key.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">Generate a new API key</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <label className="block text-xs font-medium text-gray-700">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Desktop, Anna"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
            <p className="mt-1 text-xs text-gray-500">
              For identifying the key in this list, the consumer never sees it.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700">Scopes</label>
            <div className="mt-1 flex gap-1.5">
              <button
                type="button"
                onClick={() => setScopes(new Set(READ_ONLY_SCOPES))}
                className={`rounded px-2 py-1 text-xs ${
                  preset === 'read-only'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Read-only preset
              </button>
              <button
                type="button"
                onClick={() => setScopes(new Set(FULL_AGENT_SCOPES))}
                className={`rounded px-2 py-1 text-xs ${
                  preset === 'full-agent'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Full agent preset
              </button>
            </div>

            <div className="mt-3 space-y-1.5 rounded-md border border-gray-200 p-3">
              {ALL_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.has(s)}
                    onChange={() => toggleScope(s)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-gray-700">{SCOPE_LABELS[s]}</span>
                  <span className="ml-auto font-mono text-[10px] text-gray-400">{s}</span>
                </label>
              ))}
            </div>
          </div>

          {err && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4" />
              {err}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Generating…' : 'Generate'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RevealKeyDialog({
  token,
  name,
  onClose,
}: {
  token: string;
  name: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">Your new key</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 p-5">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">Copy this now, it won&apos;t be shown again.</p>
            <p className="mt-1 text-xs">
              The token is stored as a one-way SHA-256 hash on our side. If you lose it, revoke
              this key and generate a new one.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700">{name}</label>
            <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50 p-2 font-mono text-xs text-gray-800">
              <code className="flex-1 break-all">{token}</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(token);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* clipboard write fails on insecure origins */
                  }
                }}
                className="rounded p-1 hover:bg-gray-200"
                title="Copy"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Copy className="h-4 w-4 text-gray-500" />
                )}
              </button>
            </div>
          </div>

          <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
            <p className="font-medium text-gray-700">Use it in Claude Desktop:</p>
            <pre className="mt-1.5 overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-gray-800">{`{
  "mcpServers": {
    "nuravolt": {
      "url": "${typeof window !== 'undefined' ? window.location.origin : ''}/api/mcp/mcp",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`}</pre>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
