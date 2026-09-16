import type { PerformanceAnomalyTriggerData, TicketPriority } from '@/types/tickets';

/**
 * Shape produced by `predictive_faults` in
 * `public/data/faults/{plantId}/fault_detection_enhanced.json`. The on-disk
 * JSON sometimes carries extra fields; we destructure only what we need.
 */
export interface PredictiveAlarm {
  id: string;
  fault_type: string;
  display_name?: string;
  equipment_id: string;
  days_to_fault: number;
  urgency: 'critical' | 'urgent' | 'soon' | 'planned' | 'monitoring' | string;
  recommended_action?: string;
  revenue_at_risk_eur?: number;
  /** Optional sensor reading at detection time. */
  current_value?: number;
  /** Threshold the model is comparing against. */
  threshold?: number;
  unit?: string;
  /** Trend signal (positive = worsening). */
  trend?: number;
  confidence?: number;
  projected_energy_loss_kwh?: number;
  /** Cascade classification provenance — flows through to ticket.trigger_metadata. */
  classification_layer?: 'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE';
  evidence?: string;
  winner_reason?: string;
}

const URGENCY_TO_PRIORITY: Record<string, TicketPriority> = {
  critical: 'CRITICAL',
  urgent: 'HIGH',
  soon: 'MEDIUM',
  planned: 'LOW',
  monitoring: 'LOW',
};

const URGENCY_TO_ANOMALY_SEVERITY: Record<
  string,
  PerformanceAnomalyTriggerData['severity']
> = {
  critical: 'critical',
  urgent: 'high',
  soon: 'medium',
  planned: 'low',
  monitoring: 'low',
};

export interface BuildTicketCreatePayloadArgs {
  plantId: string;
  alarm: PredictiveAlarm;
}

export interface TicketCreatePayload {
  plant_id: string;
  inverter_id: string | null;
  title: string;
  description: string;
  priority: TicketPriority;
  trigger_type: 'PERFORMANCE_ANOMALY';
  trigger_id: string;
  trigger_metadata: PerformanceAnomalyTriggerData & {
    /** Echoed back so the evidence chart can recover the fault context. */
    fault_type: string;
    equipment_id: string;
    days_to_fault: number;
    threshold?: number;
    unit?: string;
    trend?: number;
    confidence?: number;
    projected_energy_loss_kwh?: number;
    recommended_action?: string;
    /** Cascade provenance carried through to AIAnalysisCard. */
    classification_layer?: 'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE';
    evidence?: string;
    winner_reason?: string;
  };
  estimated_revenue_impact_eur: number | null;
  estimated_energy_loss_kwh: number | null;
}

/**
 * Maps a predictive-fault alarm into the shape `/api/tickets` POST expects.
 * Idempotency on the caller side uses `trigger_id === alarm.id`.
 */
export function buildTicketCreatePayload({
  plantId,
  alarm,
}: BuildTicketCreatePayloadArgs): TicketCreatePayload {
  const urgencyKey = alarm.urgency?.toLowerCase() ?? 'planned';
  const priority = URGENCY_TO_PRIORITY[urgencyKey] ?? 'MEDIUM';
  const anomalySeverity = URGENCY_TO_ANOMALY_SEVERITY[urgencyKey] ?? 'medium';

  const expected = alarm.threshold ?? alarm.current_value ?? 0;
  const actual = alarm.current_value ?? 0;
  const deviation_pct =
    expected !== 0 ? ((actual - expected) / Math.abs(expected)) * 100 : 0;

  const displayName = alarm.display_name ?? alarm.fault_type;
  const equipment = alarm.equipment_id;
  const action = alarm.recommended_action ?? '';

  return {
    plant_id: plantId,
    inverter_id: equipment.startsWith('INV') ? equipment : null,
    title: `${displayName} · ${equipment}`,
    description: action,
    priority,
    trigger_type: 'PERFORMANCE_ANOMALY',
    trigger_id: alarm.id,
    trigger_metadata: {
      anomaly_id: alarm.id,
      anomaly_type: alarm.fault_type,
      severity: anomalySeverity,
      detected_at: new Date().toISOString(),
      metric_name: alarm.fault_type,
      expected_value: expected,
      actual_value: actual,
      deviation_pct,
      // Echo-through fields used by the evidence chart
      fault_type: alarm.fault_type,
      equipment_id: equipment,
      days_to_fault: alarm.days_to_fault,
      threshold: alarm.threshold,
      unit: alarm.unit,
      trend: alarm.trend,
      confidence: alarm.confidence,
      projected_energy_loss_kwh: alarm.projected_energy_loss_kwh,
      recommended_action: action,
      // Cascade provenance — surfaces in AIAnalysisCard so the operator
      // sees whether AI is classifying, narrating, or overriding.
      classification_layer: alarm.classification_layer,
      evidence: alarm.evidence,
      winner_reason: alarm.winner_reason,
    },
    estimated_revenue_impact_eur: alarm.revenue_at_risk_eur ?? null,
    estimated_energy_loss_kwh: alarm.projected_energy_loss_kwh ?? null,
  };
}
