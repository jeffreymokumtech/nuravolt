'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Database,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Settings,
  Trash2,
  Play,
  ChevronRight,
  ChevronDown,
  Loader2,
  Factory,
  Sprout,
  Sparkles,
} from 'lucide-react';
import ConnectionWizard from '@/components/data-hub/ConnectionWizard';
import ConnectionHealthDashboard from '@/components/data-hub/ConnectionHealthDashboard';

interface LinkedPlant {
  id: string;
  name: string;
  slug: string;
  purpose: string;
  is_primary: boolean;
}

// Types matching API response
interface Connection {
  id: string;
  name: string;
  description?: string;
  type: 'influxdb' | 'sql_scada' | 'modbus_tcp' | 'csv_upload' | 'huawei_api' | 'sungrow_api' | 'sample_api';
  status: 'pending' | 'connecting' | 'connected' | 'error' | 'disabled';
  last_poll_time?: string;
  last_poll_status?: string;
  last_error?: string;
  polling_interval: number;
  plants_connected: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Plants linked via PlantDataSource (absent in demo fallback data). */
  plants?: LinkedPlant[];
  _count: {
    field_mappings: number;
    discovered_plants: number;
    polling_jobs: number;
  };
}

interface ConnectionsResponse {
  data: Connection[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

const STATUS_CONFIG = {
  connected: { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-100', label: 'Connected' },
  connecting: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Connecting' },
  pending: { icon: Clock, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Pending' },
  error: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Error' },
  disabled: { icon: AlertCircle, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Disabled' },
};

const TYPE_LABELS = {
  influxdb: 'InfluxDB',
  sql_scada: 'SQL SCADA',
  modbus_tcp: 'Modbus TCP',
  csv_upload: 'CSV Upload',
  huawei_api: 'Huawei API',
  sungrow_api: 'Sungrow iSolarCloud',
  sample_api: 'Sample inverter feed',
};

interface ConnectionsManagerProps {
  /** Hide the page-level title row (used when embedded under an ops panel that already has a heading). */
  hideHeader?: boolean;
  /**
   * Scope the list to connections feeding ONE plant (matched on the linked
   * plants' slug). Without it the manager shows every org connection — the
   * org-level "Fleet connections" view.
   */
  plantSlug?: string;
}

/**
 * The live connections manager: fetch/test/delete DataConnection rows against
 * /api/connections, health dashboard, and the ConnectionWizard modal. Used
 * org-wide (fleet connections) and, with `plantSlug`, scoped inside the
 * per-plant Data Hub so a plant screen only shows that plant's sources.
 */
export default function ConnectionsManager({ hideHeader = false, plantSlug }: ConnectionsManagerProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Plant scope: only connections whose PlantDataSource links include this
  // plant. Org scope (no plantSlug) shows everything.
  const visibleConnections = plantSlug
    ? connections.filter((c) => c.plants?.some((p) => p.slug === plantSlug))
    : connections;

  // Show feedback toast
  const showFeedback = (type: 'success' | 'error', message: string) => {
    setActionFeedback({ type, message });
    setTimeout(() => setActionFeedback(null), 4000);
  };

  // Fetch connections with demo fallback
  const fetchConnections = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/connections');
      if (!response.ok) throw new Error('Failed to fetch connections');
      const data: ConnectionsResponse = await response.json();
      setConnections(data.data);
      setError(null);
    } catch (err) {
      // Never fabricate connections for an authenticated operator. Surface a
      // real error with a retry instead of fake "connected" rows.
      setConnections([]);
      setError('Could not load your connections. Check your network and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnections();
  }, []);

  // Test/refresh a connection
  const testConnection = async (connectionId: string) => {
    setRefreshing(connectionId);
    try {
      const response = await fetch(`/api/connections/${connectionId}/test`, {
        method: 'POST',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Connection test failed');
      }
      await fetchConnections();
      showFeedback('success', 'Connection test successful');
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Test failed');
    } finally {
      setRefreshing(null);
    }
  };

  // Delete a connection
  const deleteConnection = async (connectionId: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;

    try {
      const response = await fetch(`/api/connections/${connectionId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      await fetchConnections();
      showFeedback('success', 'Connection deleted');
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // Format last sync time
  const formatLastSync = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  };

  return (
    <div>
      {/* Feedback Toast */}
      {actionFeedback && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 transition-all ${
            actionFeedback.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {actionFeedback.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : (
            <XCircle className="w-5 h-5" />
          )}
          {actionFeedback.message}
        </div>
      )}


      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between mb-6">
          <div>
            {/* "Connections" (not "Data Hub") — matches the org rail entry and
                the FLEET / CONNECTIONS trail; "Data Hub" is the per-plant page. */}
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Database className="w-7 h-7 text-blue-600" />
              Connections
            </h1>
            <p className="text-gray-600 mt-1">
              Connect and manage your solar data sources
            </p>
          </div>
          <button
            onClick={() => setShowWizard(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Add Connection
          </button>
        </div>
      )}

      {/* Health Dashboard */}
      <ConnectionHealthDashboard connections={visibleConnections} />

      {/* Connections List */}
      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">
            {plantSlug ? 'Connections feeding this plant' : 'Data Connections'}
          </h2>
          <div className="flex items-center gap-2">
            {hideHeader && (
              <button
                onClick={() => setShowWizard(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Connection
              </button>
            )}
            <button
              onClick={fetchConnections}
              disabled={loading}
              className="text-gray-500 hover:text-gray-700 transition-colors"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {loading && visibleConnections.length === 0 ? (
          <div className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto mb-4" />
            <p className="text-gray-500">Loading connections...</p>
          </div>
        ) : error ? (
          <div className="p-12 text-center">
            <XCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
            <p className="text-red-600">{error}</p>
            <button
              onClick={fetchConnections}
              className="mt-4 text-blue-600 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : visibleConnections.length === 0 ? (
          <div className="p-12 text-center">
            <Database className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {plantSlug ? 'No connections feed this plant' : 'No connections yet'}
            </h3>
            <p className="text-gray-500 mb-4">
              {plantSlug
                ? 'Link a data source to this plant, or manage the whole fleet under Settings → Connections.'
                : 'Connect your first data source to start analyzing your solar portfolio'}
            </p>
            <button
              onClick={() => setShowWizard(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus className="w-5 h-5" />
              Add Connection
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visibleConnections.map((conn) => {
              const status = STATUS_CONFIG[conn.status];
              const StatusIcon = status.icon;

              return (
                <div
                  key={conn.id}
                  className="p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      {/* Status Badge */}
                      <div className={`p-2 rounded-lg ${status.bg}`}>
                        <StatusIcon className={`w-5 h-5 ${status.color} ${conn.status === 'connecting' ? 'animate-spin' : ''}`} />
                      </div>

                      {/* Connection Info */}
                      <div>
                        <h3 className="font-medium text-gray-900">{conn.name}</h3>
                        <div className="flex items-center gap-3 text-sm text-gray-500 mt-1">
                          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs font-medium">
                            {TYPE_LABELS[conn.type]}
                          </span>
                          {conn.type === 'sample_api' && (
                            <span className="px-2 py-0.5 bg-teal-100 text-teal-800 rounded text-xs font-semibold uppercase tracking-wide">
                              Sample
                            </span>
                          )}
                          <span>
                            {conn.plants_connected} plant{conn.plants_connected !== 1 ? 's' : ''}
                          </span>
                          <span>
                            {conn._count.field_mappings} mapped field{conn._count.field_mappings !== 1 ? 's' : ''}
                          </span>
                          <span>
                            Last sync: {formatLastSync(conn.last_poll_time)}
                          </span>
                        </div>
                        {conn.last_error && conn.status === 'error' && (
                          <p className="text-sm text-red-500 mt-1">
                            {conn.last_error}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {conn.status === 'connected' &&
                        !conn.id.startsWith('demo-') &&
                        conn._count.discovered_plants > 0 && (
                          <button
                            onClick={() => setPromoteId(promoteId === conn.id ? null : conn.id)}
                            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm text-teal-700 border border-teal-300 rounded-lg hover:bg-teal-50 transition-colors"
                            title="Create plants from what discovery found on this connection"
                          >
                            <Sparkles className="w-4 h-4" />
                            Create plants from discovery
                          </button>
                        )}
                      {conn.status === 'connected' && !conn.id.startsWith('demo-') && (
                        <Link
                          href={`/dashboard/onboarding?connectionId=${conn.id}`}
                          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm text-green-700 border border-green-300 rounded-lg hover:bg-green-50 transition-colors"
                          title="Onboard a new plant using this connection"
                        >
                          <Sprout className="w-4 h-4" />
                          Onboard plant
                        </Link>
                      )}
                      <button
                        onClick={() => testConnection(conn.id)}
                        disabled={refreshing === conn.id}
                        className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Test connection"
                      >
                        {refreshing === conn.id ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <Play className="w-5 h-5" />
                        )}
                      </button>
                      <button
                        onClick={() => setSelectedConnection(conn)}
                        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Configure"
                      >
                        <Settings className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => deleteConnection(conn.id)}
                        className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => setExpandedId(expandedId === conn.id ? null : conn.id)}
                        disabled={!conn.plants || conn.plants.length === 0}
                        className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:cursor-default transition-colors"
                        title={conn.plants?.length ? 'Show linked plants' : 'No linked plants'}
                      >
                        {expandedId === conn.id ? (
                          <ChevronDown className="w-5 h-5" />
                        ) : (
                          <ChevronRight className="w-5 h-5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Zero-touch promotion: create real plants from discovery. */}
                  {promoteId === conn.id && (
                    <DiscoveryPromotePanel connectionId={conn.id} onCreated={fetchConnections} />
                  )}

                  {/* Linked plants — closes the connections ↔ plants loop
                      (per-plant provenance lives in that plant's Data Hub). */}
                  {expandedId === conn.id && conn.plants && conn.plants.length > 0 && (
                    <div className="mt-3 ml-14 flex flex-wrap gap-2">
                      {conn.plants.map((plant) => (
                        <Link
                          key={plant.id}
                          href={`/dashboard/plant/${plant.slug}/datahub`}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                        >
                          <Factory className="w-4 h-4 text-gray-400" />
                          {plant.name}
                          {plant.is_primary && (
                            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                              primary
                            </span>
                          )}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Connection Wizard Modal */}
      {showWizard && (
        <ConnectionWizard
          mode="connection-only"
          onClose={() => setShowWizard(false)}
          onComplete={() => {
            setShowWizard(false);
            fetchConnections();
          }}
        />
      )}

      {/* Connection Config Modal: details, enable/disable, field mappings */}
      {selectedConnection && (
        <ConnectionConfigModal
          connection={selectedConnection}
          onClose={() => setSelectedConnection(null)}
          onChanged={() => {
            fetchConnections();
          }}
        />
      )}
    </div>
  );
}

interface DiscoveredPlantRow {
  id: string; // external_plant_id
  name: string;
  location?: { lat?: number; lng?: number; address?: string; country?: string };
  capacity_mw?: number;
  inverter_count?: number;
}

type PromoteState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'created'; slug: string }
  | { kind: 'already'; slug: string }
  | { kind: 'error'; message: string };

/**
 * Zero-touch promotion panel: lists what discovery found on a connection and
 * creates real plants from it (POST .../promote). Idempotent server-side.
 */
function DiscoveryPromotePanel({
  connectionId,
  onCreated,
}: {
  connectionId: string;
  onCreated: () => void;
}) {
  const [plants, setPlants] = useState<DiscoveredPlantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [states, setStates] = useState<Record<string, PromoteState>>({});

  useEffect(() => {
    fetch(`/api/connections/${connectionId}/discover`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setPlants(json?.data?.plants ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [connectionId]);

  async function promote(externalId: string) {
    setStates((s) => ({ ...s, [externalId]: { kind: 'busy' } }));
    try {
      const res = await fetch(`/api/connections/${connectionId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_plant_id: externalId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setStates((s) => ({ ...s, [externalId]: { kind: 'created', slug: json.data.slug } }));
        onCreated();
      } else if (res.status === 200) {
        setStates((s) => ({ ...s, [externalId]: { kind: 'already', slug: json.data.slug } }));
      } else {
        setStates((s) => ({
          ...s,
          [externalId]: { kind: 'error', message: json.detail ?? json.error ?? `HTTP ${res.status}` },
        }));
      }
    } catch (e) {
      setStates((s) => ({
        ...s,
        [externalId]: { kind: 'error', message: e instanceof Error ? e.message : 'failed' },
      }));
    }
  }

  return (
    <div className="mt-3 ml-14 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-teal-800">
        Discovered on this connection
      </p>
      {loading ? (
        <p className="text-sm text-gray-500">Loading discovery…</p>
      ) : plants.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing discovered yet — run Discover first.</p>
      ) : (
        <div className="space-y-2">
          {plants.map((p) => {
            const state = states[p.id] ?? { kind: 'idle' };
            return (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-2"
              >
                <div className="text-sm">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="ml-2 text-xs text-gray-500">
                    {p.capacity_mw != null ? `${Math.round(p.capacity_mw * 1000)} kWp` : 'capacity unknown'}
                    {p.inverter_count ? ` · ${p.inverter_count} inverter${p.inverter_count === 1 ? '' : 's'}` : ''}
                    {p.location?.address ? ` · ${p.location.address}` : ''}
                  </span>
                </div>
                {state.kind === 'created' || state.kind === 'already' ? (
                  <Link
                    href={`/dashboard/plant/${state.slug}/status`}
                    className="text-sm font-medium text-teal-700 hover:underline"
                  >
                    {state.kind === 'created' ? 'Created — view status →' : 'Already onboarded →'}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2">
                    {state.kind === 'error' && (
                      <span className="text-xs text-red-600">
                        {state.message}{' '}
                        {state.message.includes('plan') && (
                          <Link href="/pricing" className="underline">
                            pricing
                          </Link>
                        )}
                      </span>
                    )}
                    <button
                      onClick={() => promote(p.id)}
                      disabled={state.kind === 'busy'}
                      className="rounded-md bg-teal-600 px-3 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                    >
                      {state.kind === 'busy' ? 'Creating…' : 'Create plant'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface MappingRow {
  id: string;
  original_field: string;
  mapped_field: string;
  unit: string | null;
  confidence_score: number;
  is_confirmed: boolean;
}

function ConnectionConfigModal({
  connection,
  onClose,
  onChanged,
}: {
  connection: Connection;
  onClose: () => void;
  onChanged: () => void;
}) {
  const isDemoConn = connection.id.startsWith('demo-');
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(!isDemoConn);
  const [enabled, setEnabled] = useState(connection.enabled);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (isDemoConn) return;
    fetch(`/api/connections/${connection.id}/mappings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setMappings(json?.data?.mappings ?? []))
      .catch(() => {})
      .finally(() => setLoadingMappings(false));
  }, [connection.id, isDemoConn]);

  const toggleEnabled = async () => {
    if (isDemoConn) {
      setEnabled(!enabled);
      return;
    }
    setToggling(true);
    try {
      const res = await fetch(`/api/connections/${connection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (res.ok) {
        setEnabled(!enabled);
        onChanged();
      }
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Configure {connection.name}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <XCircle className="w-6 h-6" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          {/* Enable / disable polling */}
          <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
            <div>
              <h3 className="font-medium text-gray-900">Polling {enabled ? 'enabled' : 'disabled'}</h3>
              <p className="text-sm text-gray-500">
                {enabled
                  ? `Polled every ${Math.round(connection.polling_interval / 60)} min by the cloud scheduler.`
                  : 'This connection is paused — no data is being fetched.'}
              </p>
            </div>
            <button
              onClick={toggleEnabled}
              disabled={toggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                enabled ? 'bg-green-500' : 'bg-gray-300'
              }`}
              title={enabled ? 'Disable polling' : 'Enable polling'}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium mb-2">Connection Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Type:</dt>
                <dd>{TYPE_LABELS[connection.type]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Status:</dt>
                <dd className={STATUS_CONFIG[connection.status].color}>
                  {STATUS_CONFIG[connection.status].label}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Plants:</dt>
                <dd>{connection.plants?.length ?? connection.plants_connected}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Polling Interval:</dt>
                <dd>{connection.polling_interval}s</dd>
              </div>
            </dl>
          </div>

          {/* Field mappings (read-only review) */}
          <div>
            <h3 className="font-medium mb-2">
              Field mappings ({isDemoConn ? connection._count.field_mappings : mappings.length})
            </h3>
            {isDemoConn ? (
              <p className="text-sm text-gray-500">Not available in demo mode.</p>
            ) : loadingMappings ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : mappings.length === 0 ? (
              <p className="text-sm text-gray-500">
                No field mappings yet — run discovery from the wizard to create them.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Source field</th>
                      <th className="px-3 py-2">Mapped to</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-3 py-2">Confidence</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {mappings.map((m) => (
                      <tr key={m.id}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700">{m.original_field}</td>
                        <td className="px-3 py-2 font-mono text-xs text-blue-700">{m.mapped_field}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">{m.unit ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          {Math.round(Number(m.confidence_score) * 100)}%
                        </td>
                        <td className="px-3 py-2">
                          {m.is_confirmed ? (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Confirmed
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Unconfirmed
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
