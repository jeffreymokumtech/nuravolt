'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname, useParams } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ClipboardList,
  Plus,
  Filter,
  LayoutGrid,
  List,
  RefreshCw,
  X,
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  MessageSquare,
  Euro,
  Zap,
} from 'lucide-react';
import { useTickets } from '@/hooks/useTickets';
import { useDataSource } from '@/contexts/DataSourceContext';
import { AskAIButton } from '@/components/copilot/AskAIButton';
import AIAnalysisCard from '@/components/tickets/AIAnalysisCard';
import type {
  TicketStatus,
  TicketSummary,
  TicketPriority,
  TicketTriggerType,
  TicketValidationAction,
  CreateTicketRequest,
} from '@/types/tickets';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import {
  TICKET_STATUS_CONFIG,
  TICKET_PRIORITY_CONFIG,
  TICKET_TRIGGER_CONFIG,
  VALIDATION_ACTION_CONFIG,
} from '@/types/tickets';

// Status columns for Kanban board
const STATUS_COLUMNS: TicketStatus[] = [
  'NEW',
  'VALIDATED',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'WONT_FIX',
];

// Priority border colors for accent bar
const PRIORITY_BORDER_COLORS: Record<TicketPriority, string> = {
  CRITICAL: 'border-l-red-500 bg-red-50/50',
  HIGH: 'border-l-orange-500',
  MEDIUM: 'border-l-yellow-500',
  LOW: 'border-l-blue-400',
};

// Status dot colors
const STATUS_DOT_COLORS: Record<TicketStatus, string> = {
  NEW: 'bg-gray-400',
  VALIDATED: 'bg-blue-500',
  ASSIGNED: 'bg-purple-500',
  IN_PROGRESS: 'bg-yellow-500',
  DONE: 'bg-green-500',
  WONT_FIX: 'bg-red-400',
};

export default function TicketsSection() {
  const { readOnly } = useDataSource();

  // In the public showcase we don't expose the ticket DB, show a concise,
  // illustrative stand-in so visitors still see the feature exists.
  if (readOnly) {
    return <TicketsReadOnlyPlaceholder />;
  }

  return <TicketsSectionLive />;
}

function TicketsSectionLive() {
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showNewTicketModal, setShowNewTicketModal] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<TicketStatus | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const {
    tickets,
    stats,
    loading,
    statsLoading,
    selectedTicket,
    selectedLoading,
    selectTicket,
    validateTicket,
    updateTicket,
    createTicket,
    refetch,
    filters,
    setFilters,
    clearFilters,
  } = useTickets({ autoLoad: true, pageSize: 100 });

  // Group tickets by status for Kanban board
  const ticketsByStatus = useMemo(() => {
    const grouped: Record<TicketStatus, TicketSummary[]> = {
      NEW: [],
      VALIDATED: [],
      ASSIGNED: [],
      IN_PROGRESS: [],
      DONE: [],
      WONT_FIX: [],
    };

    tickets.forEach((ticket) => {
      grouped[ticket.status].push(ticket);
    });

    return grouped;
  }, [tickets]);

  // Get active ticket for drag overlay
  const activeTicket = useMemo(
    () => tickets.find((t) => t.id === activeId),
    [tickets, activeId]
  );

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor)
  );

  // Handle ticket click
  const handleTicketClick = async (ticketId: string) => {
    setSelectedTicketId(ticketId);
    await selectTicket(ticketId);
  };

  // Auto-open ticket detail when arriving via `?ticketId=`, fired by the
  // alarm-click → /api/tickets/from-alarm → router.push flow in OpsFaults /
  // OpsOverview. Wait for tickets to land so selectTicket has the row in
  // the local store.
  useEffect(() => {
    const queryTicketId = searchParams?.get('ticketId');
    if (!queryTicketId || loading || tickets.length === 0) return;
    if (queryTicketId === selectedTicketId) return;
    void handleTicketClick(queryTicketId);
    // We intentionally leave the search param in place so refresh re-opens
    // the same ticket; clearing would need router.replace with the
    // remainder of the query string preserved.
  }, [searchParams, tickets, loading, selectedTicketId]);

  // When the detail panel closes, drop the ticketId query so back/forward
  // navigation reflects the closed state.
  const closeDetailPanel = useCallback(() => {
    setSelectedTicketId(null);
    if (searchParams?.has('ticketId') && pathname) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('ticketId');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  // DnD handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (over) {
      // Check if over a column
      if (STATUS_COLUMNS.includes(over.id as TicketStatus)) {
        setOverId(over.id as TicketStatus);
      } else {
        // Over a ticket - find its column
        const ticket = tickets.find((t) => t.id === over.id);
        if (ticket) {
          setOverId(ticket.status);
        }
      }
    } else {
      setOverId(null);
    }
  }, [tickets]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setOverId(null);

      if (!over) return;

      const ticketId = active.id as string;
      let newStatus: TicketStatus | null = null;

      // Check if dropped on column
      if (STATUS_COLUMNS.includes(over.id as TicketStatus)) {
        newStatus = over.id as TicketStatus;
      } else {
        // Dropped on another ticket - get its status
        const targetTicket = tickets.find((t) => t.id === over.id);
        if (targetTicket) {
          newStatus = targetTicket.status;
        }
      }

      if (newStatus) {
        const ticket = tickets.find((t) => t.id === ticketId);
        if (ticket && ticket.status !== newStatus) {
          await updateTicket(ticketId, { status: newStatus });
        }
      }
    },
    [tickets, updateTicket]
  );

  // Handle validation
  const handleValidate = async (action: TicketValidationAction, notes?: string) => {
    if (!selectedTicketId) return;

    const success = await validateTicket(selectedTicketId, {
      validation_action: action,
      validation_notes: notes,
    });

    if (success) {
      setShowValidationModal(false);
      setSelectedTicketId(null);
    }
  };

  // Handle status change (for manual change)
  const handleStatusChange = async (ticketId: string, newStatus: TicketStatus) => {
    await updateTicket(ticketId, { status: newStatus });
  };

  // Format relative time
  const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      {/* Toolbar — title comes from the wrapping OpsPanel (O&M TICKETS),
          so this row only carries the open count and the actions. */}
      <div className="bg-white rounded-xl shadow-sm border border-divider px-6 py-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <span className="font-mono text-xs uppercase tracking-wider text-ink-2">
            {stats ? `${stats.open_count} open` : ' '}
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={refetch}
              disabled={loading}
              className="p-2 text-ink-2 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>

            <div className="flex bg-paper-2 rounded-lg p-1">
              <button
                onClick={() => setViewMode('board')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'board'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-ink-2 hover:text-gray-900'
                }`}
                title="Board View"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 rounded-md transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-ink-2 hover:text-gray-900'
                }`}
                title="List View"
              >
                <List className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                showFilters || Object.keys(filters).length > 0
                  ? 'text-blue-700 bg-blue-100 border border-blue-300'
                  : 'text-ink-2 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
            >
              <Filter className="w-4 h-4" />
              <span className="hidden sm:inline">Filter</span>
            </button>

            <button
              onClick={() => setShowNewTicketModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New</span>
            </button>
          </div>
        </div>

        {/* Filter Panel */}
        <AnimatePresence>
          {showFilters && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-4 pt-4 border-t border-divider">
                <div className="flex flex-wrap gap-4">
                  <select
                    value={filters.priority?.toString() || ''}
                    onChange={(e) =>
                      setFilters({ ...filters, priority: (e.target.value as TicketPriority) || undefined })
                    }
                    className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All Priorities</option>
                    {Object.entries(TICKET_PRIORITY_CONFIG).map(([key, config]) => (
                      <option key={key} value={key}>
                        {config.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={filters.trigger_type?.toString() || ''}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        trigger_type: (e.target.value as TicketTriggerType) || undefined,
                      })
                    }
                    className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All Triggers</option>
                    {Object.entries(TICKET_TRIGGER_CONFIG).map(([key, config]) => (
                      <option key={key} value={key}>
                        {config.label}
                      </option>
                    ))}
                  </select>

                  {Object.keys(filters).length > 0 && (
                    <button
                      onClick={clearFilters}
                      className="px-3 py-2 text-sm text-signal-critical hover:bg-red-50 rounded-lg transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {STATUS_COLUMNS.map((status) => {
          const config = TICKET_STATUS_CONFIG[status];
          const count = stats?.by_status[status] ?? ticketsByStatus[status].length;

          return (
            <motion.div
              key={status}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`bg-white rounded-lg border p-4 cursor-pointer transition-all ${
                filters.status === status
                  ? 'border-blue-500 ring-2 ring-blue-100'
                  : 'border-divider hover:border-gray-300'
              }`}
              onClick={() =>
                setFilters({
                  ...filters,
                  status: filters.status === status ? undefined : status,
                })
              }
            >
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${STATUS_DOT_COLORS[status]}`} />
                <span className="text-xs font-medium text-ink-2 uppercase tracking-wide">
                  {config.label}
                </span>
              </div>
              <div className="text-2xl font-bold text-ink">
                {statsLoading ? '...' : count}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Kanban Board */}
      {viewMode === 'board' ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="bg-white rounded-xl shadow-sm border border-divider p-4 overflow-x-auto">
            <div className="flex gap-4 min-w-max">
              {STATUS_COLUMNS.map((status) => (
                <DroppableColumn
                  key={status}
                  status={status}
                  tickets={ticketsByStatus[status]}
                  isOver={overId === status}
                  onTicketClick={handleTicketClick}
                  formatRelativeTime={formatRelativeTime}
                />
              ))}
            </div>
          </div>

          {/* Drag Overlay */}
          <DragOverlay dropAnimation={{
            duration: 200,
            easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
          }}>
            {activeTicket ? (
              <TicketCard
                ticket={activeTicket}
                onClick={() => {}}
                formatRelativeTime={formatRelativeTime}
                isDragOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        /* List View */
        <div className="bg-white rounded-xl shadow-sm border border-divider overflow-hidden">
          <table className="w-full">
            <thead className="bg-paper border-b border-divider">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Priority
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Trigger
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Impact
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-ink-2 uppercase">
                  Created
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              <AnimatePresence>
                {tickets.map((ticket, index) => {
                  const statusConfig = TICKET_STATUS_CONFIG[ticket.status];
                  const priorityConfig = TICKET_PRIORITY_CONFIG[ticket.priority];
                  const triggerConfig = TICKET_TRIGGER_CONFIG[ticket.trigger_type];

                  return (
                    <motion.tr
                      key={ticket.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ delay: index * 0.03 }}
                      className="hover:bg-gray-50 cursor-pointer group"
                      onClick={() => handleTicketClick(ticket.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-1 h-10 rounded-full ${PRIORITY_BORDER_COLORS[ticket.priority].split(' ')[0].replace('border-l-', 'bg-')}`} />
                          <div>
                            <div className="font-medium text-ink group-hover:text-blue-600 transition-colors">
                              {ticket.title}
                            </div>
                            {ticket.plant_name && (
                              <div className="text-xs text-ink-3">{ticket.plant_name}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${statusConfig.bgColor} ${statusConfig.color}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_COLORS[ticket.status]}`} />
                          {statusConfig.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${priorityConfig.bgColor} ${priorityConfig.color}`}
                        >
                          {priorityConfig.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-1 rounded text-xs ${triggerConfig.bgColor} ${triggerConfig.color}`}
                        >
                          {triggerConfig.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {ticket.estimated_revenue_impact_eur ? (
                          <span className="text-sm font-medium text-ink">
                            €{Math.round(ticket.estimated_revenue_impact_eur).toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-sm text-ink-3">,</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-3">
                        {formatRelativeTime(ticket.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <ChevronRight className="w-4 h-4 text-ink-3 group-hover:text-gray-600 transition-colors" />
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>

              {tickets.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-ink-3">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Loading tickets...
                      </div>
                    ) : (
                      'No tickets found'
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Ticket Detail Sidebar */}
      <AnimatePresence>
        {selectedTicketId && (
          <TicketDetailPanel
            ticket={selectedTicket}
            loading={selectedLoading}
            onClose={() => {
              closeDetailPanel();
              selectTicket(null);
            }}
            onValidate={() => setShowValidationModal(true)}
            onStatusChange={(status) => handleStatusChange(selectedTicketId, status)}
            onNarrationChange={() => selectTicket(selectedTicketId)}
            formatRelativeTime={formatRelativeTime}
          />
        )}
      </AnimatePresence>

      {/* Validation Modal */}
      <AnimatePresence>
        {showValidationModal && selectedTicket?.status === 'NEW' && (
          <ValidationModal
            onValidate={handleValidate}
            onClose={() => setShowValidationModal(false)}
          />
        )}
      </AnimatePresence>

      {/* New Ticket Modal */}
      <AnimatePresence>
        {showNewTicketModal && (
          <NewTicketModal
            onCreate={async (data) => {
              const created = await createTicket(data);
              if (created) {
                setShowNewTicketModal(false);
                refetch();
              }
              return created != null;
            }}
            onClose={() => setShowNewTicketModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// Droppable Column Component
function DroppableColumn({
  status,
  tickets,
  isOver,
  onTicketClick,
  formatRelativeTime,
}: {
  status: TicketStatus;
  tickets: TicketSummary[];
  isOver: boolean;
  onTicketClick: (id: string) => void;
  formatRelativeTime: (date: string) => string;
}) {
  const config = TICKET_STATUS_CONFIG[status];
  const { setNodeRef } = useSortable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg p-3 w-72 flex-shrink-0 transition-all duration-200 ${
        isOver
          ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset'
          : 'bg-paper'
      }`}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT_COLORS[status]}`} />
          <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wide">
            {config.label}
          </h3>
        </div>
        <span className="text-xs font-medium text-ink-3 bg-white px-2 py-0.5 rounded-full shadow-sm">
          {tickets.length}
        </span>
      </div>

      {/* Tickets */}
      <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2 min-h-[200px] max-h-[500px] overflow-y-auto">
          <AnimatePresence mode="popLayout">
            {tickets.map((ticket, index) => (
              <SortableTicketCard
                key={ticket.id}
                ticket={ticket}
                onClick={() => onTicketClick(ticket.id)}
                formatRelativeTime={formatRelativeTime}
                index={index}
              />
            ))}
          </AnimatePresence>

          {tickets.length === 0 && (
            <div
              className={`flex flex-col items-center justify-center py-8 text-sm rounded-lg transition-all ${
                isOver
                  ? 'text-blue-600 border-2 border-dashed border-blue-400 bg-blue-50'
                  : 'text-ink-3'
              }`}
            >
              {isOver ? (
                <>
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center mb-2">
                    <Plus className="w-4 h-4 text-blue-600" />
                  </div>
                  <span>Drop here</span>
                </>
              ) : (
                'No tickets'
              )}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// Sortable Ticket Card wrapper
function SortableTicketCard({
  ticket,
  onClick,
  formatRelativeTime,
  index,
}: {
  ticket: TicketSummary;
  onClick: () => void;
  formatRelativeTime: (date: string) => string;
  index: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ticket.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ delay: index * 0.05 }}
      {...attributes}
      {...listeners}
    >
      <TicketCard
        ticket={ticket}
        onClick={onClick}
        formatRelativeTime={formatRelativeTime}
        isDragging={isDragging}
      />
    </motion.div>
  );
}

// Ticket Card Component
function TicketCard({
  ticket,
  onClick,
  formatRelativeTime,
  isDragging,
  isDragOverlay,
}: {
  ticket: TicketSummary;
  onClick: () => void;
  formatRelativeTime: (date: string) => string;
  isDragging?: boolean;
  isDragOverlay?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const priorityConfig = TICKET_PRIORITY_CONFIG[ticket.priority];
  const triggerConfig = TICKET_TRIGGER_CONFIG[ticket.trigger_type];

  return (
    <div
      className={`
        relative bg-white rounded-lg border-l-4 border border-divider p-3
        cursor-grab active:cursor-grabbing
        transition-all duration-200
        ${PRIORITY_BORDER_COLORS[ticket.priority]}
        ${isDragging ? 'opacity-50 scale-95' : ''}
        ${isDragOverlay ? 'shadow-2xl rotate-2 scale-105' : 'shadow-sm'}
        ${!isDragging && !isDragOverlay ? 'hover:shadow-md hover:-translate-y-0.5' : ''}
      `}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Priority & Time */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className={`px-2 py-0.5 text-xs font-semibold rounded ${priorityConfig.bgColor} ${priorityConfig.color}`}
        >
          {priorityConfig.label}
        </span>
        <div className="flex items-center gap-1.5">
          {/* Stop drag/click bubbling so the AskAI button doesn't open the ticket. */}
          <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <AskAIButton
              variant="icon"
              title="Ask Shams about this ticket"
              seed={() =>
                `Ticket ${ticket.id} ("${ticket.title}", ${ticket.priority} priority, status ${ticket.status}, trigger ${ticket.trigger_type}). What is the most likely root cause and what should the operator do next? Search the knowledge base for similar past tickets.`
              }
              context={{
                plantId: ticket.plant_id ?? undefined,
                inverterId: ticket.inverter_id ?? undefined,
              }}
            />
          </div>
          <span className="text-xs text-ink-3 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatRelativeTime(ticket.created_at)}
          </span>
        </div>
      </div>

      {/* Title */}
      <h4 className="text-sm font-medium text-ink mb-2 line-clamp-2 leading-snug">
        {ticket.title}
      </h4>

      {/* Metadata */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className={`px-2 py-0.5 text-xs rounded ${triggerConfig.bgColor} ${triggerConfig.color}`}>
          {triggerConfig.label}
        </span>
        {ticket.inverter_id && (
          <span className="px-2 py-0.5 text-xs bg-paper-2 text-ink-2 rounded">
            {ticket.inverter_id}
          </span>
        )}
      </div>

      {/* Bottom row: Impact & Comments */}
      <div className="flex items-center justify-between text-xs text-ink-3">
        <div className="flex items-center gap-3">
          {ticket.estimated_revenue_impact_eur && (
            <span className="flex items-center gap-1 text-green-600 font-medium">
              <Euro className="w-3 h-3" />
              {Math.round(ticket.estimated_revenue_impact_eur).toLocaleString()}
            </span>
          )}
          {ticket.estimated_energy_loss_kwh && (
            <span className="flex items-center gap-1 text-orange-600">
              <Zap className="w-3 h-3" />
              {Math.round(ticket.estimated_energy_loss_kwh).toLocaleString()} kWh
            </span>
          )}
        </div>
        {ticket.comment_count && ticket.comment_count > 0 && (
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {ticket.comment_count}
          </span>
        )}
      </div>

      {/* Quick Actions (on hover) */}
      <AnimatePresence>
        {isHovered && !isDragging && !isDragOverlay && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="absolute -top-2 right-2 flex gap-1"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              className="p-1.5 bg-white border border-divider rounded-md shadow-sm hover:bg-gray-50 transition-colors"
              title="View Details"
            >
              <Eye className="w-3.5 h-3.5 text-ink-2" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Ticket Detail Panel
function TicketDetailPanel({
  ticket,
  loading,
  onClose,
  onValidate,
  onStatusChange,
  onNarrationChange,
  formatRelativeTime,
}: {
  ticket: import('@/types/tickets').TicketDetail | null;
  loading: boolean;
  onClose: () => void;
  onValidate: () => void;
  onStatusChange: (status: TicketStatus) => void;
  onNarrationChange: () => void;
  formatRelativeTime: (date: string) => string;
}) {
  if (loading) {
    return (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/20 z-40"
          onClick={onClose}
        />
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className="fixed inset-y-0 right-0 w-full sm:w-[450px] bg-white shadow-xl border-l border-divider z-50 p-6"
        >
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-divider rounded w-3/4"></div>
            <div className="h-4 bg-divider rounded w-1/2"></div>
            <div className="h-32 bg-divider rounded"></div>
          </div>
        </motion.div>
      </>
    );
  }

  if (!ticket) return null;

  const statusConfig = TICKET_STATUS_CONFIG[ticket.status];
  const priorityConfig = TICKET_PRIORITY_CONFIG[ticket.priority];
  const triggerConfig = TICKET_TRIGGER_CONFIG[ticket.trigger_type];

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="fixed inset-y-0 right-0 w-full sm:w-[450px] bg-white shadow-xl border-l border-divider z-50 overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-divider p-4 z-10">
          <div className="flex items-start justify-between">
            <div className="flex-1 pr-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${statusConfig.bgColor} ${statusConfig.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_COLORS[ticket.status]}`} />
                  {statusConfig.label}
                </span>
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${priorityConfig.bgColor} ${priorityConfig.color}`}>
                  {priorityConfig.label}
                </span>
              </div>
              <h2 className="text-lg font-bold text-ink">{ticket.title}</h2>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <X className="w-5 h-5 text-ink-3" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* AI Analysis card, present for PERFORMANCE_ANOMALY tickets. When
              the operator approves here, the ticket also transitions to
              VALIDATED, so we skip the legacy validation button below. */}
          {ticket.trigger_type === 'PERFORMANCE_ANOMALY' && (
            <AIAnalysisCard ticket={ticket} onNarrationChange={onNarrationChange} />
          )}

          {/* Actions, legacy validation block for trigger types without a
              dedicated AI narration. */}
          {ticket.status === 'NEW' &&
            ticket.trigger_type !== 'PERFORMANCE_ANOMALY' && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-blue-50 rounded-lg p-4 border border-blue-200"
              >
                <h4 className="font-medium text-blue-900 mb-2">Validation Required</h4>
                <p className="text-sm text-blue-700 mb-3">
                  Review this auto-generated ticket and validate or dismiss it.
                </p>
                <button
                  onClick={onValidate}
                  className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  Validate or Dismiss
                </button>
              </motion.div>
            )}

          {/* Description */}
          {ticket.description && (
            <div>
              <h4 className="text-sm font-semibold text-ink-2 mb-2">Description</h4>
              <p className="text-sm text-ink-2 leading-relaxed">{ticket.description}</p>
            </div>
          )}

          {/* Details */}
          <div>
            <h4 className="text-sm font-semibold text-ink-2 mb-3">Details</h4>
            <dl className="space-y-3">
              <div className="flex justify-between text-sm">
                <dt className="text-ink-3">Trigger</dt>
                <dd className={`px-2 py-0.5 rounded text-xs font-medium ${triggerConfig.bgColor} ${triggerConfig.color}`}>
                  {triggerConfig.label}
                </dd>
              </div>
              {ticket.plant_name && (
                <div className="flex justify-between text-sm">
                  <dt className="text-ink-3">Plant</dt>
                  <dd className="text-ink font-medium">{ticket.plant_name}</dd>
                </div>
              )}
              {ticket.inverter_id && (
                <div className="flex justify-between text-sm">
                  <dt className="text-ink-3">Inverter</dt>
                  <dd className="text-ink font-medium">{ticket.inverter_id}</dd>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <dt className="text-ink-3">Created</dt>
                <dd className="text-ink">{formatRelativeTime(ticket.created_at)}</dd>
              </div>
              {ticket.estimated_energy_loss_kwh && (
                <div className="flex justify-between text-sm">
                  <dt className="text-ink-3">Est. Energy Loss</dt>
                  <dd className="text-orange-600 font-medium">{ticket.estimated_energy_loss_kwh.toFixed(0)} kWh</dd>
                </div>
              )}
              {ticket.estimated_revenue_impact_eur && (
                <div className="flex justify-between text-sm">
                  <dt className="text-ink-3">Est. Revenue Impact</dt>
                  <dd className="text-green-600 font-medium">€{ticket.estimated_revenue_impact_eur.toFixed(0)}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* History */}
          {ticket.history && ticket.history.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-ink-2 mb-3">History</h4>
              <div className="space-y-3">
                {ticket.history.map((entry, index) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="flex items-start gap-3 text-sm"
                  >
                    <div className={`w-2 h-2 mt-1.5 rounded-full ${STATUS_DOT_COLORS[entry.new_status]}`} />
                    <div>
                      <p className="text-ink">
                        Changed to <strong>{TICKET_STATUS_CONFIG[entry.new_status].label}</strong>
                      </p>
                      {entry.change_reason && (
                        <p className="text-ink-3 text-xs mt-0.5">{entry.change_reason}</p>
                      )}
                      <p className="text-xs text-ink-3 mt-0.5">{formatRelativeTime(entry.changed_at)}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          {ticket.comments && ticket.comments.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-ink-2 mb-3">
                Comments ({ticket.comments.length})
              </h4>
              <div className="space-y-3">
                {ticket.comments.map((comment, index) => (
                  <motion.div
                    key={comment.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-paper rounded-lg p-3"
                  >
                    <p className="text-sm text-ink">{comment.content}</p>
                    <p className="text-xs text-ink-3 mt-2">
                      {formatRelativeTime(comment.created_at)}
                    </p>
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </>
  );
}

// Validation Modal
function NewTicketModal({
  onCreate,
  onClose,
}: {
  onCreate: (data: CreateTicketRequest) => Promise<boolean>;
  onClose: () => void;
}) {
  const params = useParams();
  const { plants } = useDemoPlants();
  const routePlant = plants.find(
    (p) => p.slug === params?.plantId || p.id === params?.plantId,
  );
  const [plantId, setPlantId] = useState<string>(routePlant?.id ?? plants[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('MEDIUM');
  const [inverterId, setInverterId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!plantId || !title.trim()) return;
    setSubmitting(true);
    setError(null);
    const ok = await onCreate({
      plant_id: plantId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      inverter_id: inverterId.trim() || undefined,
      trigger_type: 'MANUAL_CREATION',
    });
    setSubmitting(false);
    if (!ok) setError('Could not create the ticket. Try again.');
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="fixed inset-0 flex items-center justify-center z-50 p-4"
      >
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-ink mb-4">New ticket</h3>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Plant</label>
              <select
                value={plantId}
                onChange={(e) => setPlantId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white"
              >
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Inspect INV-07 string connectors"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white"
                >
                  {Object.entries(TICKET_PRIORITY_CONFIG).map(([value, cfg]) => (
                    <option key={value} value={value}>
                      {cfg.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">
                  Inverter (optional)
                </label>
                <input
                  value={inverterId}
                  onChange={(e) => setInverterId(e.target.value)}
                  placeholder="e.g. INV-07"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                />
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !plantId}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create ticket'}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}

function ValidationModal({
  onValidate,
  onClose,
}: {
  onValidate: (action: TicketValidationAction, notes?: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [selectedAction, setSelectedAction] = useState<TicketValidationAction | null>(null);

  const handleSubmit = () => {
    if (selectedAction) {
      onValidate(selectedAction, notes || undefined);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="fixed inset-0 flex items-center justify-center z-50 p-4"
      >
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-ink mb-2">Validate Ticket</h3>
          <p className="text-sm text-ink-2 mb-4">
            Your feedback helps improve our detection algorithms.
          </p>

          <div className="space-y-2 mb-4">
            {Object.entries(VALIDATION_ACTION_CONFIG).map(([action, config]) => (
              <motion.button
                key={action}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => setSelectedAction(action as TicketValidationAction)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                  selectedAction === action
                    ? 'border-blue-500 bg-blue-50 shadow-sm'
                    : 'border-divider hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                {action.startsWith('VALIDATED') ? (
                  <CheckCircle className={`w-5 h-5 ${config.color}`} />
                ) : (
                  <XCircle className={`w-5 h-5 ${config.color}`} />
                )}
                <div className="text-left">
                  <div className="font-medium text-ink">{config.label}</div>
                  <div className="text-xs text-ink-3">{config.description}</div>
                </div>
              </motion.button>
            ))}
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add notes (optional)..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-4 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            rows={2}
          />

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 text-ink-2 bg-paper-2 rounded-lg hover:bg-gray-200 transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!selectedAction}
              className="flex-1 py-2.5 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}

/**
 * Read-only placeholder shown in the public showcase in place of the live
 * ticket board. Keeps the UX story visible ("yes, this platform has tickets")
 * without exposing the DB or requiring auth.
 */
function TicketsReadOnlyPlaceholder() {
  const SAMPLE = [
    { id: 'T-2031', title: 'INV 03.082, predicted inverter failure', status: 'NEW', priority: 'CRITICAL', created: '2 hours ago' },
    { id: 'T-2029', title: 'PV-02 block, soiling loss above threshold', status: 'VALIDATED', priority: 'HIGH', created: '5 hours ago' },
    { id: 'T-2024', title: 'INV 01.044, thermal RUL 42 days', status: 'ASSIGNED', priority: 'HIGH', created: 'yesterday' },
    { id: 'T-2018', title: 'INV 02.019, MPPT current imbalance', status: 'IN_PROGRESS', priority: 'MEDIUM', created: '2 days ago' },
    { id: 'T-1997', title: 'PV-04, monthly cleaning completed', status: 'DONE', priority: 'LOW', created: '4 days ago' },
  ];

  const STATUS_COLOR: Record<string, string> = {
    NEW: 'bg-paper-2 text-ink-2',
    VALIDATED: 'bg-blue-100 text-blue-700',
    ASSIGNED: 'bg-purple-100 text-purple-700',
    IN_PROGRESS: 'bg-yellow-100 text-yellow-800',
    DONE: 'bg-signal-positive/10 text-signal-positive',
  };
  const PRIORITY_COLOR: Record<string, string> = {
    CRITICAL: 'bg-signal-critical/10 text-signal-critical',
    HIGH: 'bg-orange-100 text-orange-700',
    MEDIUM: 'bg-yellow-100 text-yellow-800',
    LOW: 'bg-blue-100 text-blue-700',
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-signal-warning/20 bg-signal-warning/10 p-4 flex items-start gap-3 text-sm text-signal-warning">
        <ClipboardList className="w-5 h-5 flex-shrink-0 mt-0.5 text-signal-warning" />
        <div className="leading-relaxed">
          <strong>Read-only showcase.</strong> Real deployments have a full ticket board
          with validation workflow, contractor SLA tracking, and audit trail. Below is
          an illustrative snapshot, no write actions are enabled here.
        </div>
      </div>

      <div className="rounded-xl bg-white border border-divider overflow-hidden">
        <div className="px-5 py-3 border-b border-divider flex items-center justify-between">
          <h2 className="text-base font-bold text-ink flex items-center gap-2">
            <ClipboardList className="w-4 h-4" />
            Recent Tickets
          </h2>
          <span className="text-xs text-ink-3">{SAMPLE.length} sample tickets</span>
        </div>
        <div className="divide-y divide-gray-100">
          {SAMPLE.map((t) => (
            <div
              key={t.id}
              className="px-5 py-3 flex items-center gap-4 hover:bg-gray-50 transition-colors"
            >
              <span className="font-mono text-xs text-ink-3 w-16 flex-shrink-0">{t.id}</span>
              <span className="flex-1 text-sm text-ink truncate">{t.title}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PRIORITY_COLOR[t.priority]}`}
              >
                {t.priority}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[t.status]}`}
              >
                {t.status.replace('_', ' ')}
              </span>
              <span className="text-xs text-ink-3 w-24 text-right">{t.created}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
