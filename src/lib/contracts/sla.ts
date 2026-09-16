/**
 * Pure O&M SLA math over ticket timestamps. Response time = created →
 * assigned; resolution time = created → closed. p90 per priority so a single
 * slow ticket in a healthy month doesn't flip the obligation.
 */

export interface SlaTicket {
  created_at: Date;
  assigned_at: Date | null;
  closed_at: Date | null;
  priority: string; // CRITICAL | HIGH | MEDIUM | LOW
}

export interface SlaBucket {
  p90Hours: number | null;
  count: number;
}

export interface SlaMetrics {
  response: Record<string, SlaBucket>;
  resolution: Record<string, SlaBucket>;
}

/** p-th percentile (0-1) with linear interpolation; null for empty input. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const HOUR_MS = 3_600_000;

export function slaMetrics(tickets: SlaTicket[]): SlaMetrics {
  const response: Record<string, number[]> = {};
  const resolution: Record<string, number[]> = {};

  for (const t of tickets) {
    const p = t.priority;
    if (t.assigned_at && t.assigned_at.getTime() >= t.created_at.getTime()) {
      (response[p] ??= []).push((t.assigned_at.getTime() - t.created_at.getTime()) / HOUR_MS);
    }
    if (t.closed_at && t.closed_at.getTime() >= t.created_at.getTime()) {
      (resolution[p] ??= []).push((t.closed_at.getTime() - t.created_at.getTime()) / HOUR_MS);
    }
  }

  const shape = (m: Record<string, number[]>): Record<string, SlaBucket> => {
    const out: Record<string, SlaBucket> = {};
    for (const [priority, values] of Object.entries(m)) {
      out[priority] = { p90Hours: percentile(values, 0.9), count: values.length };
    }
    return out;
  };

  return { response: shape(response), resolution: shape(resolution) };
}

/** Term field → (metric kind, ticket priority) for the OM_SLA vocabulary. */
export const SLA_TERM_MAP: Record<string, { metric: 'response' | 'resolution'; priority: string }> = {
  response_hours_critical: { metric: 'response', priority: 'CRITICAL' },
  response_hours_high: { metric: 'response', priority: 'HIGH' },
  response_hours_medium: { metric: 'response', priority: 'MEDIUM' },
  response_hours_low: { metric: 'response', priority: 'LOW' },
  resolution_hours_critical: { metric: 'resolution', priority: 'CRITICAL' },
  resolution_hours_high: { metric: 'resolution', priority: 'HIGH' },
};
