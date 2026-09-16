'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Clock,
  Ticket,
  CheckCircle,
  Zap,
  TrendingDown,
} from 'lucide-react';
import type {
  Fault,
  ReactiveFault,
  PredictiveFault,
  FaultSeverity,
  FaultUrgency,
  FaultSortConfig,
  FaultSortField,
} from '@/types/faults';
import { FAULT_TYPE_DISPLAY_NAMES } from '@/types/faults';

interface FaultTableProps {
  faults: Fault[];
  loading?: boolean;
  onFaultClick: (fault: Fault) => void;
  onCreateTicket: (fault: Fault) => Promise<{ id: string } | { error: string }>;
  // Sorting props
  sortConfig?: FaultSortConfig | null;
  onSort?: (field: FaultSortField) => void;
}

// Sortable column header component
interface SortableHeaderProps {
  field: FaultSortField;
  label: string;
  currentSort: FaultSortConfig | null | undefined;
  onSort?: (field: FaultSortField) => void;
  className?: string;
}

function SortableHeader({ field, label, currentSort, onSort, className = '' }: SortableHeaderProps) {
  const isActive = currentSort?.field === field;
  const direction = isActive ? currentSort?.direction : null;

  if (!onSort) {
    return <div className={className}>{label}</div>;
  }

  return (
    <button
      onClick={() => onSort(field)}
      className={`flex items-center gap-1 hover:text-gray-900 transition-colors group ${className}`}
    >
      <span>{label}</span>
      <span className="flex flex-col -space-y-1">
        <ChevronUp
          className={`w-3 h-3 ${
            isActive && direction === 'asc' ? 'text-blue-600' : 'text-gray-300 group-hover:text-gray-400'
          }`}
        />
        <ChevronDown
          className={`w-3 h-3 ${
            isActive && direction === 'desc' ? 'text-blue-600' : 'text-gray-300 group-hover:text-gray-400'
          }`}
        />
      </span>
    </button>
  );
}

// Type guard functions
function isReactiveFault(fault: Fault): fault is ReactiveFault {
  return 'severity' in fault && 'duration_minutes' in fault;
}

function isPredictiveFault(fault: Fault): fault is PredictiveFault {
  return 'urgency' in fault && 'days_to_fault' in fault;
}

// Temporal status badge
function FaultTemporalBadge({ fault }: { fault: Fault }) {
  const isCurrent = isReactiveFault(fault)
    ? !fault.timestamp_end || new Date(fault.timestamp_end).getTime() >= Date.now()
    : true; // predictive faults are upcoming/current by definition

  const label = isCurrent ? 'Current' : 'Historical';
  const classes = isCurrent
    ? 'bg-signal-positive/10 text-signal-positive border-signal-positive/20'
    : 'bg-paper-2 text-ink-2 border-divider';

  return (
    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full border ${classes}`}>
      {label}
    </span>
  );
}

// Severity badge colors
const SEVERITY_STYLES: Record<FaultSeverity, string> = {
  critical: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  warning: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  info: 'bg-blue-100 text-blue-700 border-blue-200',
};

// Urgency badge colors
const URGENCY_STYLES: Record<FaultUrgency, string> = {
  urgent: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  soon: 'bg-orange-100 text-orange-700 border-orange-200',
  planned: 'bg-blue-100 text-blue-700 border-blue-200',
  monitoring: 'bg-paper-2 text-ink-2 border-divider',
};

// Priority border colors
const PRIORITY_BORDERS: Record<string, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-yellow-500',
  info: 'border-l-blue-400',
  urgent: 'border-l-red-500',
  soon: 'border-l-orange-500',
  planned: 'border-l-blue-400',
  monitoring: 'border-l-gray-400',
};

export default function FaultTable({
  faults,
  loading,
  onFaultClick,
  onCreateTicket,
  sortConfig,
  onSort,
}: FaultTableProps) {
  const [creatingTicketId, setCreatingTicketId] = useState<string | null>(null);
  const [ticketSuccess, setTicketSuccess] = useState<string | null>(null);

  const handleCreateTicket = async (e: React.MouseEvent, fault: Fault) => {
    e.stopPropagation();
    setCreatingTicketId(fault.id);

    const result = await onCreateTicket(fault);

    if ('id' in result) {
      setTicketSuccess(fault.id);
      setTimeout(() => setTicketSuccess(null), 3000);
    }

    setCreatingTicketId(null);
  };

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-divider overflow-hidden">
        <div className="animate-pulse">
          <div className="h-12 bg-paper-2 border-b border-divider" />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center p-4 border-b border-divider">
              <div className="h-4 bg-divider rounded w-1/4 mr-4" />
              <div className="h-4 bg-divider rounded w-1/6 mr-4" />
              <div className="h-4 bg-divider rounded w-1/6 mr-4" />
              <div className="h-4 bg-divider rounded w-1/6" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (faults.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-divider p-12 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-green-600" />
        </div>
        <h3 className="text-lg font-semibold text-ink mb-2">No Faults Detected</h3>
        <p className="text-ink-2 max-w-sm mx-auto">
          All systems are operating within normal parameters. No active or predicted faults at this time.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-divider overflow-hidden">
      {/* Table Header */}
      <div className="bg-paper border-b border-divider">
        <div className="grid grid-cols-12 gap-4 px-4 py-3 text-xs font-semibold text-ink-2 uppercase tracking-wider">
          <SortableHeader
            field="fault_type"
            label="Fault"
            currentSort={sortConfig}
            onSort={onSort}
            className="col-span-2"
          />
          <SortableHeader
            field="equipment_name"
            label="Equipment"
            currentSort={sortConfig}
            onSort={onSort}
            className="col-span-2"
          />
          <div className="col-span-2">Status</div>
          <SortableHeader
            field="energy_loss"
            label="Loss"
            currentSort={sortConfig}
            onSort={onSort}
            className="col-span-2"
          />
          <SortableHeader
            field="days_to_fault"
            label="Days/Duration"
            currentSort={sortConfig}
            onSort={onSort}
            className="col-span-2"
          />
          <SortableHeader
            field="date"
            label="Date"
            currentSort={sortConfig}
            onSort={onSort}
            className="col-span-1"
          />
          <div className="col-span-1"></div>
        </div>
      </div>

      {/* Table Body */}
      <div className="divide-y divide-gray-100">
        <AnimatePresence mode="popLayout">
          {faults.map((fault, index) => {
            const isReactive = isReactiveFault(fault);
            const priority = isReactive
              ? (fault as ReactiveFault).severity
              : (fault as PredictiveFault).urgency;
            const borderClass = PRIORITY_BORDERS[priority] || 'border-l-gray-400';

            return (
              <motion.div
                key={fault.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ delay: index * 0.03 }}
                onClick={() => onFaultClick(fault)}
                className={`grid grid-cols-12 gap-4 px-4 py-4 border-l-4 ${borderClass} cursor-pointer hover:bg-gray-50 transition-colors group`}
              >
                {/* Fault Type */}
                <div className="col-span-2">
                  <div className="flex items-center gap-2">
                    {isReactive ? (
                      <AlertTriangle className="w-4 h-4 text-signal-warning flex-shrink-0" />
                    ) : (
                      <Clock className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    )}
                    <div>
                      <div className="font-medium text-ink text-sm group-hover:text-blue-600 transition-colors truncate" title={FAULT_TYPE_DISPLAY_NAMES[fault.fault_type] || fault.fault_type}>
                        {FAULT_TYPE_DISPLAY_NAMES[fault.fault_type] || fault.fault_type}
                      </div>
                      <div className="text-xs text-ink-3">
                        {isReactive ? 'Reactive' : 'Predictive'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Equipment */}
                <div className="col-span-2 flex items-center">
                  <span className="text-sm text-ink truncate" title={fault.equipment_name}>
                    {fault.equipment_name}
                  </span>
                </div>

                {/* Status Badge */}
                <div className="col-span-2 flex items-center gap-2 flex-wrap">
                  {isReactive ? (
                    <span
                      className={`inline-flex px-2 py-1 text-xs font-medium rounded-full border ${
                        SEVERITY_STYLES[(fault as ReactiveFault).severity]
                      }`}
                    >
                      {(fault as ReactiveFault).severity}
                    </span>
                  ) : (
                    <span
                      className={`inline-flex px-2 py-1 text-xs font-medium rounded-full border ${
                        URGENCY_STYLES[(fault as PredictiveFault).urgency]
                      }`}
                    >
                      {(fault as PredictiveFault).urgency}
                    </span>
                  )}
                </div>

                {/* Loss */}
                <div className="col-span-2 flex items-center">
                  <div className="flex items-center gap-1">
                    {isReactive ? (
                      <>
                        <Zap className="w-3.5 h-3.5 text-orange-500" />
                        <span className="text-sm font-medium text-ink">
                          {(fault as ReactiveFault).energy_loss_kwh.toLocaleString()} kWh
                        </span>
                      </>
                    ) : (
                      <>
                        <TrendingDown className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-sm font-medium text-ink">
                          {(fault as PredictiveFault).projected_energy_loss_kwh.toLocaleString()} kWh
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Days to Fault / Duration */}
                <div className="col-span-2 flex items-center">
                  {isReactive ? (
                    <span className="text-sm text-ink-2">
                      {formatDuration((fault as ReactiveFault).duration_minutes)}
                    </span>
                  ) : (
                    <span
                      className={`inline-flex px-2.5 py-1 text-sm font-semibold rounded-lg ${
                        (fault as PredictiveFault).days_to_fault < 3
                          ? 'bg-signal-critical/10 text-signal-critical'
                          : (fault as PredictiveFault).days_to_fault < 7
                            ? 'bg-orange-100 text-orange-700'
                            : (fault as PredictiveFault).days_to_fault < 30
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-paper-2 text-ink-2'
                      }`}
                    >
                      {(fault as PredictiveFault).days_to_fault}d
                    </span>
                  )}
                </div>

                {/* Date */}
                <div className="col-span-1 flex items-center">
                  <div className="text-xs text-ink-2">
                    {isReactive ? (
                      formatDate((fault as ReactiveFault).timestamp_start)
                    ) : (
                      formatDate((fault as PredictiveFault).estimated_date)
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="col-span-1 flex items-center justify-end gap-2">
                  {fault.ticket_id ? (
                    <span className="text-xs text-green-600 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span className="hidden xl:inline">Ticket</span>
                    </span>
                  ) : ticketSuccess === fault.id ? (
                    <span className="text-xs text-green-600 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                    </span>
                  ) : (
                    <button
                      onClick={(e) => handleCreateTicket(e, fault)}
                      disabled={creatingTicketId === fault.id}
                      className="p-1.5 text-ink-3 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
                      title="Create Ticket"
                    >
                      {creatingTicketId === fault.id ? (
                        <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Ticket className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  <ChevronRight className="w-4 h-4 text-ink-3 group-hover:text-gray-600 transition-colors" />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
