'use client';

import {
  Database,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  TrendingUp,
  Activity,
} from 'lucide-react';

interface Connection {
  id: string;
  status: 'pending' | 'connecting' | 'connected' | 'error' | 'disabled';
  last_poll_time?: string;
  plants_connected: number;
  enabled?: boolean;
  created_at?: string;
  _count: {
    field_mappings: number;
    discovered_plants: number;
    polling_jobs: number;
  };
}

interface Props {
  connections: Connection[];
}

// Alert thresholds (configurable)
const STALE_THRESHOLD_HOURS = 4; // Only alert if data is > 4 hours old
const STUCK_PENDING_MINUTES = 10; // Only alert if pending > 10 minutes

export default function ConnectionHealthDashboard({ connections }: Props) {
  // Calculate metrics
  const totalConnections = connections.length;
  const connectedCount = connections.filter(c => c.status === 'connected').length;
  const errorCount = connections.filter(c => c.status === 'error').length;

  const totalPlants = connections.reduce((sum, c) => sum + c.plants_connected, 0);
  const totalMappings = connections.reduce((sum, c) => sum + c._count.field_mappings, 0);

  const now = new Date();

  // Smart stale detection: Only for enabled, connected connections with previous polls
  const staleConnections = connections.filter(c => {
    // Skip disabled connections
    if (c.enabled === false) return false;
    // Only check connections that were previously working
    if (c.status !== 'connected') return false;
    // Never polled = new connection, not stale
    if (!c.last_poll_time) return false;

    const lastPoll = new Date(c.last_poll_time);
    const hoursSinceLastPoll = (now.getTime() - lastPoll.getTime()) / (1000 * 60 * 60);
    return hoursSinceLastPoll > STALE_THRESHOLD_HOURS;
  });

  // Smart pending detection: Only if stuck > 10 minutes
  const stuckPending = connections.filter(c => {
    if (c.status !== 'pending' && c.status !== 'connecting') return false;
    // Check how long it's been pending
    if (!c.created_at) return false;
    const createdAt = new Date(c.created_at);
    const minutesSinceCreated = (now.getTime() - createdAt.getTime()) / (1000 * 60);
    return minutesSinceCreated > STUCK_PENDING_MINUTES;
  });

  // For freshness calculation, use relaxed thresholds
  const freshConnections = connections.filter(c => {
    if (c.enabled === false) return true; // Disabled = not counted
    if (!c.last_poll_time) return false;
    const lastPoll = new Date(c.last_poll_time);
    const hoursSinceLastPoll = (now.getTime() - lastPoll.getTime()) / (1000 * 60 * 60);
    return hoursSinceLastPoll <= STALE_THRESHOLD_HOURS;
  });

  const freshnessPercentage = totalConnections > 0
    ? Math.round((freshConnections.length / totalConnections) * 100)
    : 100; // No connections = 100% fresh (nothing to be stale)

  const metrics = [
    {
      label: 'Total Connections',
      value: totalConnections,
      icon: Database,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      label: 'Connected',
      value: connectedCount,
      icon: CheckCircle2,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      subtext: totalConnections > 0 ? `${Math.round((connectedCount / totalConnections) * 100)}%` : '0%',
    },
    {
      label: 'Plants Discovered',
      value: totalPlants,
      icon: TrendingUp,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      label: 'Fields Mapped',
      value: totalMappings,
      icon: Activity,
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-100',
    },
    {
      label: 'Data Freshness',
      value: `${freshnessPercentage}%`,
      icon: Clock,
      color: freshnessPercentage >= 80 ? 'text-green-600' : freshnessPercentage >= 50 ? 'text-yellow-600' : 'text-red-600',
      bgColor: freshnessPercentage >= 80 ? 'bg-green-100' : freshnessPercentage >= 50 ? 'bg-yellow-100' : 'bg-red-100',
    },
  ];

  // Only show alerts for actionable issues (not noise)
  const hasActionableAlerts = errorCount > 0 || stuckPending.length > 0 || staleConnections.length > 0;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div
              key={metric.label}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-4"
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${metric.bgColor}`}>
                  <Icon className={`w-5 h-5 ${metric.color}`} />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{metric.value}</p>
                  <p className="text-xs text-gray-500">{metric.label}</p>
                  {metric.subtext && (
                    <p className="text-xs text-gray-400">{metric.subtext}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Alerts Panel - Only show for actionable issues */}
      {hasActionableAlerts && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            Attention Required
          </h3>
          <div className="space-y-2">
            {/* Critical: Connection errors */}
            {errorCount > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <XCircle className="w-4 h-4 text-red-500" />
                <span className="text-red-700 font-medium">
                  {errorCount} connection{errorCount !== 1 ? 's' : ''} with errors - check credentials or connectivity
                </span>
              </div>
            )}
            {/* Warning: Stuck pending (> 10 min) */}
            {stuckPending.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-yellow-500" />
                <span className="text-yellow-700">
                  {stuckPending.length} connection{stuckPending.length !== 1 ? 's' : ''} stuck in setup - may need manual intervention
                </span>
              </div>
            )}
            {/* Info: Stale data (> 4 hours) */}
            {staleConnections.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <AlertTriangle className="w-4 h-4 text-orange-500" />
                <span className="text-orange-700">
                  {staleConnections.length} connection{staleConnections.length !== 1 ? 's' : ''} with stale data ({'>'} {STALE_THRESHOLD_HOURS} hours)
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
