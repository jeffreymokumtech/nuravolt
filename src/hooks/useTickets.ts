/**
 * Data fetching hook for O&M ticketing system.
 * Provides CRUD operations, filtering, and caching for tickets.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  TicketSummary,
  TicketDetail,
  TicketStats,
  TicketFilters,
  TicketListResponse,
  CreateTicketRequest,
  UpdateTicketRequest,
  ValidateTicketRequest,
  AddCommentRequest,
  TicketStatus,
} from '@/types/tickets';

interface UseTicketsOptions {
  autoLoad?: boolean;
  initialFilters?: TicketFilters;
  pageSize?: number;
}

interface UseTicketsReturn {
  // Ticket list
  tickets: TicketSummary[];
  total: number;
  page: number;
  totalPages: number;
  loading: boolean;
  error: Error | null;

  // Stats
  stats: TicketStats | null;
  statsLoading: boolean;
  statsUnavailable: boolean;

  // Selected ticket
  selectedTicket: TicketDetail | null;
  selectedLoading: boolean;

  // Actions
  fetchTickets: (page?: number) => Promise<void>;
  fetchStats: () => Promise<void>;
  selectTicket: (ticketId: string | null) => Promise<void>;
  createTicket: (data: CreateTicketRequest) => Promise<TicketSummary | null>;
  updateTicket: (ticketId: string, data: UpdateTicketRequest) => Promise<boolean>;
  validateTicket: (ticketId: string, data: ValidateTicketRequest) => Promise<boolean>;
  addComment: (ticketId: string, data: AddCommentRequest) => Promise<boolean>;
  deleteTicket: (ticketId: string) => Promise<boolean>;

  // Filters
  filters: TicketFilters;
  setFilters: (filters: TicketFilters) => void;
  clearFilters: () => void;

  // Helpers
  refetch: () => Promise<void>;
  getTicketsByStatus: (status: TicketStatus) => TicketSummary[];
}

export function useTickets(options: UseTicketsOptions = {}): UseTicketsReturn {
  const { autoLoad = true, initialFilters = {}, pageSize = 50 } = options;

  // List state
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Stats state
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsUnavailable, setStatsUnavailable] = useState(false);

  // Selected ticket state
  const [selectedTicket, setSelectedTicket] = useState<TicketDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  // Filters state
  const [filters, setFiltersState] = useState<TicketFilters>(initialFilters);

  // Build query string from filters
  const buildQueryString = useCallback(
    (pageNum: number = 1): string => {
      const params = new URLSearchParams();
      params.set('page', pageNum.toString());
      params.set('page_size', pageSize.toString());

      if (filters.status) {
        params.set(
          'status',
          Array.isArray(filters.status) ? filters.status.join(',') : filters.status
        );
      }
      if (filters.priority) {
        params.set(
          'priority',
          Array.isArray(filters.priority) ? filters.priority.join(',') : filters.priority
        );
      }
      if (filters.trigger_type) {
        params.set(
          'trigger_type',
          Array.isArray(filters.trigger_type)
            ? filters.trigger_type.join(',')
            : filters.trigger_type
        );
      }
      if (filters.plant_id) params.set('plant_id', filters.plant_id);
      if (filters.inverter_id) params.set('inverter_id', filters.inverter_id);
      if (filters.assigned_to_clerk_id) params.set('assigned_to', filters.assigned_to_clerk_id);
      if (filters.created_after) params.set('created_after', filters.created_after);
      if (filters.created_before) params.set('created_before', filters.created_before);
      if (filters.search) params.set('search', filters.search);

      return params.toString();
    },
    [filters, pageSize]
  );

  // Fetch ticket list
  const fetchTickets = useCallback(
    async (pageNum: number = 1) => {
      setLoading(true);
      setError(null);
      try {
        const queryString = buildQueryString(pageNum);
        const response = await fetch(`/api/tickets?${queryString}`);

        if (!response.ok) {
          throw new Error(`Failed to fetch tickets: ${response.statusText}`);
        }

        const data: TicketListResponse = await response.json();
        setTickets(data.tickets);
        setTotal(data.total);
        setPage(data.page);
        setTotalPages(data.total_pages);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        setLoading(false);
      }
    },
    [buildQueryString]
  );

  // Fetch stats
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const response = await fetch('/api/tickets/stats');
      if (!response.ok) {
        throw new Error(`Failed to fetch stats: ${response.statusText}`);
      }
      const data: TicketStats = await response.json();
      setStats(data);
      setStatsUnavailable(false);
    } catch (err) {
      console.warn('Ticket stats unavailable:', err);
      setStatsUnavailable(true);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  // Select and fetch ticket detail
  const selectTicket = useCallback(async (ticketId: string | null) => {
    if (!ticketId) {
      setSelectedTicket(null);
      return;
    }

    setSelectedLoading(true);
    try {
      const response = await fetch(`/api/tickets/${ticketId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch ticket: ${response.statusText}`);
      }
      const data: TicketDetail = await response.json();
      setSelectedTicket(data);
    } catch (err) {
      console.error('Error fetching ticket detail:', err);
      setSelectedTicket(null);
    } finally {
      setSelectedLoading(false);
    }
  }, []);

  // Create ticket
  const createTicket = useCallback(
    async (data: CreateTicketRequest): Promise<TicketSummary | null> => {
      try {
        const response = await fetch('/api/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to create ticket');
        }

        const newTicket = await response.json();

        // Refresh list and stats
        await Promise.all([fetchTickets(page), fetchStats()]);

        return newTicket;
      } catch (err) {
        console.error('Error creating ticket:', err);
        return null;
      }
    },
    [fetchTickets, fetchStats, page]
  );

  // Update ticket
  const updateTicket = useCallback(
    async (ticketId: string, data: UpdateTicketRequest): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tickets/${ticketId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          throw new Error('Failed to update ticket');
        }

        // Refresh data
        await Promise.all([fetchTickets(page), fetchStats()]);

        // Refresh selected ticket if it's the one being updated
        if (selectedTicket?.id === ticketId) {
          await selectTicket(ticketId);
        }

        return true;
      } catch (err) {
        console.error('Error updating ticket:', err);
        return false;
      }
    },
    [fetchTickets, fetchStats, page, selectedTicket, selectTicket]
  );

  // Validate ticket
  const validateTicket = useCallback(
    async (ticketId: string, data: ValidateTicketRequest): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tickets/${ticketId}/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          throw new Error('Failed to validate ticket');
        }

        // Refresh data
        await Promise.all([fetchTickets(page), fetchStats()]);

        // Refresh selected ticket if it's the one being validated
        if (selectedTicket?.id === ticketId) {
          await selectTicket(ticketId);
        }

        return true;
      } catch (err) {
        console.error('Error validating ticket:', err);
        return false;
      }
    },
    [fetchTickets, fetchStats, page, selectedTicket, selectTicket]
  );

  // Add comment
  const addComment = useCallback(
    async (ticketId: string, data: AddCommentRequest): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tickets/${ticketId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          throw new Error('Failed to add comment');
        }

        // Refresh selected ticket to show new comment
        if (selectedTicket?.id === ticketId) {
          await selectTicket(ticketId);
        }

        return true;
      } catch (err) {
        console.error('Error adding comment:', err);
        return false;
      }
    },
    [selectedTicket, selectTicket]
  );

  // Delete ticket
  const deleteTicket = useCallback(
    async (ticketId: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tickets/${ticketId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error('Failed to delete ticket');
        }

        // Clear selected if it was deleted
        if (selectedTicket?.id === ticketId) {
          setSelectedTicket(null);
        }

        // Refresh data
        await Promise.all([fetchTickets(page), fetchStats()]);

        return true;
      } catch (err) {
        console.error('Error deleting ticket:', err);
        return false;
      }
    },
    [fetchTickets, fetchStats, page, selectedTicket]
  );

  // Set filters and refetch
  const setFilters = useCallback(
    (newFilters: TicketFilters) => {
      setFiltersState(newFilters);
    },
    []
  );

  // Clear filters
  const clearFilters = useCallback(() => {
    setFiltersState({});
  }, []);

  // Refetch current data
  const refetch = useCallback(async () => {
    await Promise.all([fetchTickets(page), fetchStats()]);
  }, [fetchTickets, fetchStats, page]);

  // Get tickets by status (for Kanban board)
  const getTicketsByStatus = useCallback(
    (status: TicketStatus): TicketSummary[] => {
      return tickets.filter((t) => t.status === status);
    },
    [tickets]
  );

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad) {
      fetchTickets(1);
      fetchStats();
    }
  }, [autoLoad]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when filters change
  useEffect(() => {
    if (autoLoad) {
      fetchTickets(1);
    }
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    tickets,
    total,
    page,
    totalPages,
    loading,
    error,
    stats,
    statsLoading,
    statsUnavailable,
    selectedTicket,
    selectedLoading,
    fetchTickets,
    fetchStats,
    selectTicket,
    createTicket,
    updateTicket,
    validateTicket,
    addComment,
    deleteTicket,
    filters,
    setFilters,
    clearFilters,
    refetch,
    getTicketsByStatus,
  };
}

export default useTickets;
