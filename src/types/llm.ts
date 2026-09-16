/**
 * LLM Service Layer Types
 *
 * Types for LLM-powered features:
 * - Alert interpretation
 * - Knowledge base queries
 * - Report generation
 */

// =============================================================================
// Enums (matching Prisma schema)
// =============================================================================

export type LLMProvider =
  | 'AZURE_OPENAI'
  | 'OPENROUTER'
  | 'BEDROCK_ANTHROPIC'
  | 'BEDROCK_QWEN'
  | 'MOCK';

export type LLMModel =
  | 'GPT_4O'
  | 'GPT_4O_MINI'
  | 'CLAUDE_3_5_SONNET'
  | 'CLAUDE_3_HAIKU'
  | 'CLAUDE_HAIKU_4_5'
  | 'LLAMA_3_3_70B'
  | 'QWEN3_NEXT_80B';

export type LLMInteractionType =
  | 'ALERT_INTERPRETATION'
  | 'KNOWLEDGE_QUERY'
  | 'REPORT_GENERATION'
  | 'EMBEDDING'
  | 'CHAT';

export type AlertUrgency = 'IMMEDIATE' | 'WITHIN_24H' | 'WITHIN_7D' | 'MONITOR';

export type AlertConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

// =============================================================================
// Alert Interpretation
// =============================================================================

export interface AnomalyContext {
  anomaly_score: number;        // 0-1
  is_anomaly: boolean;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;           // Model confidence 0-1

  // Component info
  component_id: string;
  component_type: 'inverter' | 'string' | 'battery_cell' | 'gearbox';
  component_location?: string;

  // Fault classifier output. Required for cache disambiguation and LLM anchoring
  // when no SHAP features are present (rule-based faults from the cascade
  // classifier carry these but not feature_contributions).
  fault_type?: string;
  display_name?: string;

  // Feature attributions (SHAP values)
  feature_contributions: Record<string, number>;

  // Temporal context
  consecutive_anomalies?: number;
  trend_direction?: 'improving' | 'stable' | 'worsening';

  // Values
  expected_value?: number;
  actual_value?: number;
  deviation_percent?: number;

  // Existing interpretation (for fallback)
  existing_interpretation?: string;
  existing_possible_causes?: string[];
}

export interface HistoricalMatch {
  event_id: string;
  timestamp: string;
  similarity_score: number;
  resolution: string;
  root_cause: string;
  time_to_resolution: string;
}

/** Documentation citation attached to an interpretation. */
export interface AlertDocSource {
  title: string;
  section: string;
}

export interface InterpretedAlert {
  summary: string;              // One-line summary
  explanation: string;          // Detailed explanation (2-3 sentences)
  likely_cause: string;         // Root cause hypothesis
  recommended_action: string;   // What to do
  urgency: AlertUrgency;        // "immediate", "24h", "7d", "monitor"
  confidence: AlertConfidence;  // "high", "medium", "low"
  similar_past_events: string[];
  /** Equipment-manual excerpts the narration drew on (empty when none). */
  sources?: AlertDocSource[];

  // LLM metadata
  llm_model: string;
  llm_cost_usd: number;
  llm_latency_ms: number;
  input_tokens: number;
  output_tokens: number;

  // Fallback indicator
  used_fallback: boolean;
}

// API Request/Response types
export interface InterpretAlertRequest {
  org_clerk_id: string;
  plant_id: string;
  inverter_id?: string;
  alert_type: 'anomaly' | 'fault' | 'rul' | 'soiling';
  alert_id?: string;
  context: AnomalyContext;
  historical_matches?: HistoricalMatch[];
  use_fallback?: boolean;
}

export interface InterpretAlertResponse {
  interpretation: InterpretedAlert;
  cache_hit: boolean;
  interaction_id?: string;
}

// =============================================================================
// Knowledge Base
// =============================================================================

export interface KBDocumentMetadata {
  id: string;
  title: string;
  file_name: string;
  file_type: string;
  equipment_type?: string;
  manufacturer?: string;
  model_number?: string;
  chunk_count: number;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
}

export interface KBChunkResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  similarity_score: number;
  page_number?: number;
  section_title?: string;
}

export interface KnowledgeQueryRequest {
  org_clerk_id: string;
  plant_id?: string;
  query: string;
  equipment_type?: string;
  manufacturer?: string;
  max_chunks?: number;
  stream?: boolean;
}

export interface KnowledgeQueryResponse {
  answer: string;
  sources: KBChunkResult[];
  llm_model: string;
  llm_cost_usd: number;
  llm_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
}

// Streaming response chunk
export interface KnowledgeStreamChunk {
  type: 'text' | 'source' | 'done' | 'error';
  content?: string;
  source?: KBChunkResult;
  error?: string;
  usage?: {
    llm_cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// =============================================================================
// Report Generation
// =============================================================================

export type ReportType = 'daily_summary' | 'weekly_operations' | 'incident_report';

export interface ReportGenerateRequest {
  org_clerk_id: string;
  plant_id: string;
  report_type: ReportType;
  date_start: string;  // ISO date
  date_end: string;    // ISO date
  include_sections?: string[];
  stream?: boolean;
}

export interface ReportGenerateResponse {
  report_content: string;  // Markdown
  report_type: ReportType;
  plant_name: string;
  period: {
    start: string;
    end: string;
  };
  metrics_summary?: Record<string, number>;
  llm_model: string;
  llm_cost_usd: number;
  llm_latency_ms: number;
}

// =============================================================================
// Usage Tracking
// =============================================================================

export interface LLMUsageStats {
  period_start: string;
  period_end: string;
  total_requests: number;
  cached_requests: number;
  failed_requests: number;
  total_cost_usd: number;
  by_interaction_type: {
    type: LLMInteractionType;
    requests: number;
    tokens: number;
    cost_usd: number;
  }[];
  by_model: {
    model: LLMModel;
    requests: number;
    cost_usd: number;
  }[];
}

export interface LLMUsageRequest {
  org_clerk_id: string;
  period_type: 'daily' | 'weekly' | 'monthly';
  period_start?: string;  // ISO date, defaults to current period
}
