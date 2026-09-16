'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
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
  Loader2,
  Info,
} from 'lucide-react';
import ConnectionWizard from '@/components/data-hub/ConnectionWizard';
import ConnectionHealthDashboard from '@/components/data-hub/ConnectionHealthDashboard';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { OnboardedPlant } from '@/types/onboarding';

// Types matching API response
interface Connection {
  id: string;
  name: string;
  description?: string;
  type: 'influxdb' | 'sql_scada' | 'modbus_tcp' | 'sunspec' | 'csv_upload' | 'huawei_api' | 'sungrow_api';
  status: 'pending' | 'connecting' | 'connected' | 'error' | 'disabled';
  last_poll_time?: string;
  last_poll_status?: string;
  last_error?: string;
  polling_interval: number;
  plants_connected: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  _count: {
    field_mappings: number;
    discovered_plants: number;
    polling_jobs: number;
  };
}

// Demo mock data - realistic sample connections
const DEMO_CONNECTIONS: Connection[] = [
  {
    id: 'demo-influx-1',
    name: 'Primary InfluxDB',
    description: 'Main production time-series database',
    type: 'influxdb',
    status: 'connected',
    last_poll_time: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    last_poll_status: 'success',
    polling_interval: 300,
    plants_connected: 3,
    enabled: true,
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    _count: { field_mappings: 24, discovered_plants: 3, polling_jobs: 1 },
  },
  {
    id: 'demo-huawei-1',
    name: 'Huawei FusionSolar',
    description: 'Plant monitoring via Huawei FusionSolar API',
    type: 'huawei_api',
    status: 'connected',
    last_poll_time: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    last_poll_status: 'success',
    polling_interval: 900,
    plants_connected: 2,
    enabled: true,
    created_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    _count: { field_mappings: 18, discovered_plants: 2, polling_jobs: 1 },
  },
  {
    id: 'demo-sungrow-1',
    name: 'Sungrow iSolarCloud',
    description: 'Theta plant monitoring via Sungrow iSolarCloud API',
    type: 'sungrow_api',
    status: 'connected',
    last_poll_time: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    last_poll_status: 'success',
    polling_interval: 300,
    plants_connected: 1,
    enabled: true,
    created_at: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    _count: { field_mappings: 20, discovered_plants: 1, polling_jobs: 1 },
  },
  {
    id: 'demo-csv-1',
    name: 'Historical CSV Import',
    description: 'Uploaded historical data from legacy system',
    type: 'csv_upload',
    status: 'connected',
    last_poll_time: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    last_poll_status: 'success',
    polling_interval: 0,
    plants_connected: 1,
    enabled: false,
    created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    _count: { field_mappings: 12, discovered_plants: 1, polling_jobs: 0 },
  },
  {
    id: 'demo-modbus-1',
    name: 'Modbus TCP Gateway',
    description: 'Direct inverter connection via Modbus',
    type: 'modbus_tcp',
    status: 'connected',
    last_poll_time: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    last_poll_status: 'success',
    polling_interval: 60,
    plants_connected: 1,
    enabled: true,
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    _count: { field_mappings: 32, discovered_plants: 1, polling_jobs: 1 },
  },
];

const STATUS_CONFIG = {
  connected: { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-100', label: 'Connected' },
  connecting: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Connecting' },
  pending: { icon: Clock, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Pending' },
  error: { icon: XCircle, color: 'text-red-500', bg: 'bg-signal-critical/10', label: 'Error' },
  disabled: { icon: AlertCircle, color: 'text-ink-3', bg: 'bg-paper-2', label: 'Disabled' },
};

const TYPE_LABELS = {
  influxdb: 'InfluxDB',
  sql_scada: 'SQL SCADA',
  modbus_tcp: 'Modbus TCP',
  sunspec: 'SunSpec',
  csv_upload: 'CSV Upload',
  huawei_api: 'Huawei API',
  sungrow_api: 'Sungrow iSolarCloud',
};

export default function DataHubSection() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { addPlant } = useDemoPlants();

  const [connections, setConnections] = useState<Connection[]>(DEMO_CONNECTIONS);
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Show feedback toast
  const showFeedback = (type: 'success' | 'error', message: string) => {
    setActionFeedback({ type, message });
    setTimeout(() => setActionFeedback(null), 4000);
  };

  // Simulate refresh
  const fetchConnections = async () => {
    setLoading(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    setLoading(false);
  };

  // Test connection (demo simulation)
  const testConnection = async (connectionId: string) => {
    setRefreshing(connectionId);
    await new Promise(resolve => setTimeout(resolve, 1500));
    setRefreshing(null);

    // Update the connection's last_poll_time
    setConnections(prev => prev.map(c =>
      c.id === connectionId
        ? { ...c, last_poll_time: new Date().toISOString(), status: 'connected' as const }
        : c
    ));
    showFeedback('success', 'Connection test successful');
  };

  // Delete connection (demo simulation)
  const deleteConnection = async (connectionId: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;

    setConnections(prev => prev.filter(c => c.id !== connectionId));
    showFeedback('success', 'Connection deleted');
  };

  // Handle wizard completion - add new demo connection and optionally create plant
  const handleWizardComplete = (plant?: OnboardedPlant) => {
    const newConnection: Connection = {
      id: `demo-new-${Date.now()}`,
      name: plant?.connectionName || 'New Connection',
      description: plant ? `${plant.plantName} via ${plant.connectionType}` : 'Recently added connection',
      type: (plant?.connectionType || 'influxdb') as Connection['type'],
      status: 'connected',
      last_poll_time: new Date().toISOString(),
      last_poll_status: 'success',
      polling_interval: 300,
      plants_connected: 1,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      _count: { field_mappings: plant ? 9 : 8, discovered_plants: 1, polling_jobs: 1 },
    };
    setConnections(prev => [...prev, newConnection]);

    // If a plant was created via full onboarding, persist it
    if (plant) {
      addPlant(plant);
    }

    setShowWizard(false);
    showFeedback('success', plant
      ? `Plant "${plant.plantName}" created successfully`
      : 'Connection created successfully'
    );
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
    <div className="space-y-6">
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

      {/* Demo Mode Banner */}
      <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-3">
        <Info className="w-5 h-5 text-blue-600 flex-shrink-0" />
        <div>
          <span className="font-medium text-blue-800">Demo Mode</span>
          <span className="text-blue-700 ml-2">
            Showing sample data. All actions are simulated.
          </span>
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-ink flex items-center gap-2">
            <Database className="w-7 h-7 text-blue-600" />
            Data Hub
          </h2>
          <p className="text-ink-2 mt-1">
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

      {/* Health Dashboard */}
      <ConnectionHealthDashboard connections={connections} />

      {/* Connections List */}
      <div className="bg-white rounded-xl shadow-sm border border-divider">
        <div className="p-4 border-b border-divider flex items-center justify-between">
          <h3 className="font-semibold text-ink">Data Connections</h3>
          <button
            onClick={fetchConnections}
            disabled={loading}
            className="text-ink-3 hover:text-gray-700 transition-colors"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {connections.length === 0 ? (
          <div className="p-12 text-center">
            <Database className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-ink mb-2">No connections yet</h3>
            <p className="text-ink-3 mb-4">
              Connect your first data source to start analyzing your solar portfolio
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
            {connections.map((conn) => {
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
                        <h4 className="font-medium text-ink">{conn.name}</h4>
                        <div className="flex items-center gap-3 text-sm text-ink-3 mt-1">
                          <span className="px-2 py-0.5 bg-paper-2 rounded text-xs font-medium">
                            {TYPE_LABELS[conn.type]}
                          </span>
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
                        {conn.description && (
                          <p className="text-sm text-ink-3 mt-1">{conn.description}</p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => testConnection(conn.id)}
                        disabled={refreshing === conn.id}
                        className="p-2 text-ink-3 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
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
                        className="p-2 text-ink-3 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Configure"
                      >
                        <Settings className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => deleteConnection(conn.id)}
                        className="p-2 text-ink-3 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                      <ChevronRight className="w-5 h-5 text-ink-3" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Connection Wizard Modal */}
      {showWizard && (
        <ConnectionWizard
          allowDemoFallback
          onClose={() => setShowWizard(false)}
          onComplete={handleWizardComplete}
        />
      )}

      {/* Connection Config Modal */}
      {selectedConnection && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-divider flex items-center justify-between">
              <h2 className="text-lg font-semibold">Configure {selectedConnection.name}</h2>
              <button
                onClick={() => setSelectedConnection(null)}
                className="text-ink-3 hover:text-gray-700"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6">
              <div className="p-4 bg-paper rounded-lg mb-4">
                <h3 className="font-medium mb-3">Connection Details</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Type:</dt>
                    <dd>{TYPE_LABELS[selectedConnection.type]}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Status:</dt>
                    <dd className={STATUS_CONFIG[selectedConnection.status].color}>
                      {STATUS_CONFIG[selectedConnection.status].label}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Plants:</dt>
                    <dd>{selectedConnection.plants_connected}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Mapped Fields:</dt>
                    <dd>{selectedConnection._count.field_mappings}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Polling Interval:</dt>
                    <dd>{selectedConnection.polling_interval}s</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Enabled:</dt>
                    <dd>{selectedConnection.enabled ? 'Yes' : 'No'}</dd>
                  </div>
                </dl>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setSelectedConnection(null)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
