// O&M Ticketing System Types
// Matches Prisma schema enums and models

// ============================================
// Enums (mirror Prisma enums)
// ============================================

export type TicketStatus =
  | 'NEW'
  | 'VALIDATED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'WONT_FIX';

export type TicketPriority =
  | 'CRITICAL'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW';

export type TicketTriggerType =
  | 'SOILING_FORECAST'
  | 'PERFORMANCE_ANOMALY'
  | 'THRESHOLD_ALERT'
  | 'SCHEDULED_MAINTENANCE'
  | 'MANUAL_CREATION';

export type TicketValidationAction =
  | 'VALIDATED_CORRECT'
  | 'VALIDATED_ADJUSTED'
  | 'DISMISSED_FALSE_POSITIVE'
  | 'DISMISSED_DUPLICATE'
  | 'DISMISSED_NOT_ACTIONABLE';

// ============================================
// Core Types
// ============================================

export interface TicketSummary {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  trigger_type: TicketTriggerType;
  plant_id: string;
  plant_name?: string;
  inverter_id?: string | null;
  assigned_to_clerk_id?: string | null;
  assigned_to_name?: string;
  estimated_revenue_impact_eur?: number | null;
  estimated_energy_loss_kwh?: number | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comment_count?: number;
}

export interface TicketDetail extends TicketSummary {
  org_clerk_id: string;
  description?: string | null;
  trigger_id?: string | null;
  trigger_metadata?: Record<string, unknown> | null;
  assigned_at?: string | null;
  assigned_by_clerk_id?: string | null;
  assigned_by_name?: string;
  validated_at?: string | null;
  validated_by_clerk_id?: string | null;
  validated_by_name?: string;
  validation_action?: TicketValidationAction | null;
  validation_notes?: string | null;
  resolution_notes?: string | null;

  // AI narration fields (Phase 1)
  ai_narration?: AINarration | null;
  ai_edited_narration?: AINarration | null;
  ai_model_used?: string | null;
  ai_generated_at?: string | null;
  ai_prompt_variant?: string | null;
  ai_approved_by_clerk_id?: string | null;
  ai_approved_at?: string | null;
  ai_edited?: boolean;
  ai_regeneration_count?: number;

  comments: TicketComment[];
  history: TicketHistoryEntry[];
}

/**
 * Subset of the LLM `InterpretedAlert` shape that gets persisted on a Ticket
 * and rendered in the AI Analysis card. The LLM-side type lives in
 * `src/types/llm.ts` and has extra cost/latency metadata that we don't expose
 * to the operator UI.
 */
export interface AINarration {
  summary: string;
  explanation: string;
  likely_cause: string;
  recommended_action: string;
  urgency: 'IMMEDIATE' | 'WITHIN_24H' | 'WITHIN_7D' | 'MONITOR';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Equipment-documentation citations the narration drew on. */
  sources?: { title: string; section: string }[];
}

export interface TicketComment {
  id: string;
  ticket_id: string;
  author_clerk_id: string;
  author_name?: string;
  org_clerk_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface TicketHistoryEntry {
  id: string;
  ticket_id: string;
  old_status?: TicketStatus | null;
  new_status: TicketStatus;
  old_priority?: TicketPriority | null;
  new_priority?: TicketPriority | null;
  changed_by_clerk_id: string;
  changed_by_name?: string;
  change_reason?: string | null;
  changed_at: string;
}

// ============================================
// Request Types
// ============================================

export interface CreateTicketRequest {
  plant_id: string;
  inverter_id?: string;
  title: string;
  description?: string;
  priority?: TicketPriority;
  trigger_type: TicketTriggerType;
  trigger_id?: string;
  trigger_metadata?: Record<string, unknown>;
  estimated_revenue_impact_eur?: number;
  estimated_energy_loss_kwh?: number;
}

export interface UpdateTicketRequest {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigned_to_clerk_id?: string | null;
  resolution_notes?: string;
  change_reason?: string;
}

export interface ValidateTicketRequest {
  validation_action: TicketValidationAction;
  validation_notes?: string;
  adjusted_priority?: TicketPriority;
  adjusted_title?: string;
  adjusted_description?: string;
}

export interface AddCommentRequest {
  content: string;
}

// ============================================
// Query/Filter Types
// ============================================

export interface TicketFilters {
  status?: TicketStatus | TicketStatus[];
  priority?: TicketPriority | TicketPriority[];
  trigger_type?: TicketTriggerType | TicketTriggerType[];
  plant_id?: string;
  inverter_id?: string;
  assigned_to_clerk_id?: string;
  created_after?: string;
  created_before?: string;
  search?: string;
}

export interface TicketListResponse {
  tickets: TicketSummary[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface TicketStats {
  total: number;
  by_status: Record<TicketStatus, number>;
  by_priority: Record<TicketPriority, number>;
  by_trigger_type: Record<TicketTriggerType, number>;
  open_count: number;
  closed_count: number;
  avg_resolution_time_hours?: number;
  created_today: number;
  closed_today: number;
}

// ============================================
// Trigger Integration Types
// ============================================

export interface CreateTicketFromTriggerRequest {
  trigger_type: TicketTriggerType;
  trigger_id: string;
  plant_id: string;
  inverter_id?: string;
  trigger_metadata: Record<string, unknown>;
  auto_priority?: boolean; // Calculate priority from trigger data
}

export interface SoilingForecastTriggerData {
  forecast_id: string;
  soiling_loss_pct: number;
  forecast_date: string;
  cleaning_priority?: number;
  estimated_energy_loss_kwh?: number;
  estimated_revenue_impact_eur?: number;
}

export interface PerformanceAnomalyTriggerData {
  anomaly_id?: string;
  anomaly_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detected_at: string;
  metric_name: string;
  expected_value: number;
  actual_value: number;
  deviation_pct: number;
}

export interface ThresholdAlertTriggerData {
  alert_id?: string;
  alert_type: string;
  threshold_name: string;
  threshold_value: number;
  actual_value: number;
  exceeded_at: string;
  duration_minutes?: number;
}

export interface ScheduledMaintenanceTriggerData {
  schedule_id: string;
  maintenance_type: 'cleaning' | 'inspection' | 'repair';
  scheduled_date: string;
  energy_recovered_mwh?: number;
  revenue_recovered_eur?: number;
  cleaning_cost_eur?: number;
  net_benefit_eur?: number;
}

// ============================================
// ML Training Export Types
// ============================================

export interface ValidationExportRecord {
  ticket_id: string;
  trigger_type: TicketTriggerType;
  trigger_id?: string | null;
  trigger_metadata: Record<string, unknown> | null;
  plant_id: string;
  inverter_id?: string | null;
  validation_action: TicketValidationAction;
  validation_notes?: string | null;
  validated_at: string;
  validated_by_clerk_id: string;
  was_false_positive: boolean;
  was_adjusted: boolean;
  original_priority: TicketPriority;
  final_priority: TicketPriority;
  time_to_validation_hours: number;
  resolution_time_hours?: number | null;
  final_status: TicketStatus;
}

export interface ValidationExportResponse {
  records: ValidationExportRecord[];
  total: number;
  export_date: string;
  date_range: {
    start: string;
    end: string;
  };
}

// ============================================
// UI Helper Types
// ============================================

export const TICKET_STATUS_CONFIG: Record<TicketStatus, {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
}> = {
  NEW: {
    label: 'New',
    color: 'text-gray-700',
    bgColor: 'bg-gray-100',
    borderColor: 'border-gray-300',
  },
  VALIDATED: {
    label: 'Validated',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
    borderColor: 'border-blue-300',
  },
  ASSIGNED: {
    label: 'Assigned',
    color: 'text-purple-700',
    bgColor: 'bg-purple-100',
    borderColor: 'border-purple-300',
  },
  IN_PROGRESS: {
    label: 'In Progress',
    color: 'text-yellow-700',
    bgColor: 'bg-yellow-100',
    borderColor: 'border-yellow-300',
  },
  DONE: {
    label: 'Done',
    color: 'text-green-700',
    bgColor: 'bg-green-100',
    borderColor: 'border-green-300',
  },
  WONT_FIX: {
    label: "Won't Fix",
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    borderColor: 'border-red-300',
  },
};

export const TICKET_PRIORITY_CONFIG: Record<TicketPriority, {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
}> = {
  CRITICAL: {
    label: 'Critical',
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    icon: 'AlertTriangle',
  },
  HIGH: {
    label: 'High',
    color: 'text-orange-700',
    bgColor: 'bg-orange-100',
    icon: 'ArrowUp',
  },
  MEDIUM: {
    label: 'Medium',
    color: 'text-yellow-700',
    bgColor: 'bg-yellow-100',
    icon: 'Minus',
  },
  LOW: {
    label: 'Low',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
    icon: 'ArrowDown',
  },
};

export const TICKET_TRIGGER_CONFIG: Record<TicketTriggerType, {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
}> = {
  SOILING_FORECAST: {
    label: 'Soiling Forecast',
    color: 'text-orange-700',
    bgColor: 'bg-orange-100',
    icon: 'CloudRain',
  },
  PERFORMANCE_ANOMALY: {
    label: 'Performance Anomaly',
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    icon: 'TrendingDown',
  },
  THRESHOLD_ALERT: {
    label: 'Threshold Alert',
    color: 'text-yellow-700',
    bgColor: 'bg-yellow-100',
    icon: 'AlertCircle',
  },
  SCHEDULED_MAINTENANCE: {
    label: 'Scheduled Maintenance',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
    icon: 'Calendar',
  },
  MANUAL_CREATION: {
    label: 'Manual',
    color: 'text-gray-700',
    bgColor: 'bg-gray-100',
    icon: 'PlusCircle',
  },
};

export const VALIDATION_ACTION_CONFIG: Record<TicketValidationAction, {
  label: string;
  description: string;
  icon: string;
  color: string;
}> = {
  VALIDATED_CORRECT: {
    label: 'Validate as Correct',
    description: 'Confirm the issue is real and needs action',
    icon: 'CheckCircle',
    color: 'text-green-600',
  },
  VALIDATED_ADJUSTED: {
    label: 'Validate with Adjustments',
    description: 'Issue is valid but details need correction',
    icon: 'Edit',
    color: 'text-blue-600',
  },
  DISMISSED_FALSE_POSITIVE: {
    label: 'Dismiss: False Positive',
    description: 'No real issue detected - system error',
    icon: 'XCircle',
    color: 'text-red-600',
  },
  DISMISSED_DUPLICATE: {
    label: 'Dismiss: Duplicate',
    description: 'Already tracked in another ticket',
    icon: 'Copy',
    color: 'text-orange-600',
  },
  DISMISSED_NOT_ACTIONABLE: {
    label: 'Dismiss: Not Actionable',
    description: 'Cannot or should not take action',
    icon: 'Slash',
    color: 'text-gray-600',
  },
};

// Status workflow helpers
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['VALIDATED', 'WONT_FIX'],
  VALIDATED: ['ASSIGNED', 'WONT_FIX'],
  ASSIGNED: ['IN_PROGRESS', 'VALIDATED', 'WONT_FIX'],
  IN_PROGRESS: ['DONE', 'ASSIGNED', 'WONT_FIX'],
  DONE: ['IN_PROGRESS'], // Allow reopening
  WONT_FIX: ['NEW'], // Allow un-dismissing
};

export const isTicketOpen = (status: TicketStatus): boolean => {
  return !['DONE', 'WONT_FIX'].includes(status);
};

export const canTransitionTo = (current: TicketStatus, target: TicketStatus): boolean => {
  return TICKET_STATUS_TRANSITIONS[current]?.includes(target) ?? false;
};
