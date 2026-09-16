import type { HybridSeriesPoint } from './joinPvBess';

export interface CurtailmentEvent {
  /** First hour (inclusive). */
  start: string;
  /** Last hour (inclusive). */
  end: string;
  /** Total hours in the event. */
  duration_hours: number;
  /** Total energy that would have been clipped (MWh). */
  clipped_mwh: number;
  /** Energy redirected to BESS instead of being lost (MWh). */
  recovered_mwh: number;
  /** € recovered (clip-hour price × recovered kWh). */
  recovered_eur: number;
  /** BESS state-of-charge delta over the event (%). */
  bess_soc_delta_pct: number;
  /** Peak clipped kW within the event. */
  peak_clipped_kw: number;
}

/**
 * Identify contiguous runs of curtailment in a joined series. A "gap" of
 * one or more hours without curtailment closes an event.
 */
export function detectCurtailmentEvents(series: HybridSeriesPoint[]): CurtailmentEvent[] {
  const events: CurtailmentEvent[] = [];
  let buffer: HybridSeriesPoint[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const clippedKwh = buffer.reduce((s, p) => s + p.pv_curtailed_kw, 0);
    const recoveredKwh = buffer.reduce((s, p) => s + p.pv_to_bess_kw, 0);
    const recoveredEur = buffer.reduce(
      (s, p) => s + (p.pv_to_bess_kw * p.price_eur_mwh) / 1000,
      0
    );
    const socStart = buffer[0].bess_soc;
    const socEnd = buffer[buffer.length - 1].bess_soc;
    events.push({
      start: buffer[0].time,
      end: buffer[buffer.length - 1].time,
      duration_hours: buffer.length,
      clipped_mwh: Math.round((clippedKwh / 1000) * 100) / 100,
      recovered_mwh: Math.round((recoveredKwh / 1000) * 100) / 100,
      recovered_eur: Math.round(recoveredEur),
      bess_soc_delta_pct: Math.round((socEnd - socStart) * 1000) / 10,
      peak_clipped_kw: Math.round(Math.max(...buffer.map((p) => p.pv_curtailed_kw))),
    });
    buffer = [];
  };

  for (const p of series) {
    if (p.pv_curtailed_kw > 0) {
      buffer.push(p);
    } else if (buffer.length) {
      flush();
    }
  }
  flush();

  return events.sort((a, b) => b.clipped_mwh - a.clipped_mwh);
}

/**
 * Coarse "totals" view of the whole window — useful for the hero number.
 */
export function summariseCurtailment(series: HybridSeriesPoint[]): {
  total_clipped_mwh: number;
  total_recovered_mwh: number;
  total_recovered_eur: number;
  recovery_rate_pct: number;
} {
  const clipped = series.reduce((s, p) => s + p.pv_curtailed_kw, 0) / 1000;
  const recovered = series.reduce((s, p) => s + p.pv_to_bess_kw, 0) / 1000;
  const eur = series.reduce(
    (s, p) => s + (p.pv_to_bess_kw * p.price_eur_mwh) / 1000,
    0
  );
  return {
    total_clipped_mwh: Math.round(clipped * 100) / 100,
    total_recovered_mwh: Math.round(recovered * 100) / 100,
    total_recovered_eur: Math.round(eur),
    recovery_rate_pct: clipped > 0 ? Math.round((recovered / clipped) * 1000) / 10 : 0,
  };
}
