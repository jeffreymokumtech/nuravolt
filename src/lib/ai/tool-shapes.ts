/**
 * Pure output-shaping helpers shared by the live chat tools
 * (src/lib/ai/chat-tools.ts) and the scripted demo-conversation fixtures
 * (src/fixtures/demo-conversations/*). No prisma/fs imports — everything here
 * must run in both server tools and client fixture modules so scripted
 * threads show exactly what the live tool would return.
 */

export interface SoilingSeries {
  /** Steers the model away from reciting the arrays — they are render data. */
  note: string;
  dates: string[];
  sr: number[];
  lo: number[];
  hi: number[];
  /** Indices into the arrays where cleaning is recommended. */
  clean_idx: number[];
}

const MAX_SERIES_POINTS = 90;

const r3 = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : null;

/**
 * Compact columnar series for the inline forecast chart. Columnar arrays +
 * 3-decimal rounding keep the token cost ~1-1.5k for 90 points (the whole
 * tool output enters model context — AI SDK has no model-hidden field).
 * Even-stride downsample above 90 points (365d horizon → ~90).
 */
export function buildSoilingSeries(forecast: any[]): SoilingSeries | null {
  if (!Array.isArray(forecast) || forecast.length === 0) return null;

  const stride = Math.max(1, Math.ceil(forecast.length / MAX_SERIES_POINTS));
  const rows = forecast.filter((_, i) => i % stride === 0);

  const dates: string[] = [];
  const sr: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  const clean_idx: number[] = [];

  for (const row of rows) {
    const srVal = r3(row.soilingRatio ?? row.soiling_ratio_predicted ?? row.predicted);
    if (srVal == null || typeof row.date !== 'string') continue;
    const loVal = r3(row.lowerBound ?? row.lower_bound ?? row.lower) ?? srVal;
    const hiVal = r3(row.upperBound ?? row.upper_bound ?? row.upper) ?? srVal;
    if (row.cleaningRecommended === true || row.is_cleaning_needed === true) {
      clean_idx.push(dates.length);
    }
    dates.push(row.date.slice(0, 10));
    sr.push(srVal);
    lo.push(loVal);
    hi.push(hiVal);
  }
  if (dates.length < 2) return null;

  return {
    note: 'Downsampled render data for the UI chart. Do not enumerate; reason from the summary fields and preview.',
    dates,
    sr,
    lo,
    hi,
    clean_idx,
  };
}

export interface ToolPlantRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * The exact getSoilingForecast tool output for a forecast-row array (the
 * /api/soiling forecast route's row shape). Shared so scripted demo threads
 * show precisely what the live tool would return.
 */
export function shapeSoilingForecastOutput(
  forecast: any[],
  plant: ToolPlantRef,
  days: number,
  dataSource: string | null,
  nextRainEvent: string | null,
  observed?: {
    fleet_sr: number | null;
    estimated_loss_pct: number | null;
    next_cleaning_recommended: string | null;
    expected_net_benefit_eur: number | null;
  } | null
) {
  const srOf = (r: any) => r.soilingRatio ?? r.soiling_ratio_predicted ?? r.predicted ?? null;
  const srValues = forecast.map(srOf).filter((v: any) => typeof v === 'number');
  const avgPredicted = srValues.length
    ? Number(
        (srValues.reduce((a: number, b: number) => a + b, 0) / srValues.length).toFixed(4)
      )
    : null;
  // A provisional (climate-transfer) forecast can start from the zone's
  // typical clean state rather than this fleet's measured SR. When the
  // observed state is materially dirtier, say so — the observed value is the
  // current truth, the forecast is the forward what-if.
  const divergence =
    observed?.fleet_sr != null && avgPredicted != null && observed.fleet_sr < avgPredicted - 0.02
      ? 'Observed fleet SR is materially below the forecast curve; treat the observed value as the current state and the forecast as a provisional forward trajectory.'
      : null;
  return {
    plant: { id: plant.id, slug: plant.slug, name: plant.name },
    horizon_days: days,
    data_source: dataSource,
    sample_size: forecast.length,
    avg_predicted_sr: avgPredicted,
    cleaning_recommended: forecast.some(
      (r: any) => r.cleaningRecommended === true || r.is_cleaning_needed === true
    ),
    next_rain_event: nextRainEvent,
    ...(observed
      ? {
          observed_now: {
            fleet_sr: observed.fleet_sr,
            estimated_loss_pct: observed.estimated_loss_pct,
            next_cleaning_recommended: observed.next_cleaning_recommended,
            expected_net_benefit_eur: observed.expected_net_benefit_eur,
          },
          ...(divergence ? { note: divergence } : {}),
        }
      : {}),
    preview: forecast.slice(0, 7),
    series: buildSoilingSeries(forecast),
  };
}

/**
 * Adapt sr_forecast.json fixture daily rows (sr_forecast / sr_lower_95 /
 * sr_upper_95) to the tool's forecast row shape. A "within N days" cleaning
 * recommendation marks day N as the recommended window — a deterministic
 * derivation of the fixture's own text, not an invented date.
 */
export function soilingRowsFromFixture(
  daily: any[],
  cleaningRecommendation?: string | null
): any[] {
  const withinDays = /within (\d+) days/.exec(cleaningRecommendation ?? '')?.[1];
  const cleanDay = withinDays ? Number(withinDays) : null;
  return (daily ?? []).map((row: any, i: number) => ({
    date: row.date,
    soilingRatio: row.sr_forecast,
    lowerBound: row.sr_lower_95 ?? row.sr_forecast,
    upperBound: row.sr_upper_95 ?? row.sr_forecast,
    soilingLossPct: row.soiling_rate_pct ?? null,
    cleaningRecommended: cleanDay != null && i === cleanDay - 1,
  }));
}

/**
 * The exact getChart tool output for a normalized daily point array
 * ({date, actual, predicted}). Columnar ≤90 pts + summary stats + a
 * ready-to-add chart.timeseries widget config. Shared by the live tool
 * and scripted demo threads.
 */
export function shapeChartOutput(
  points: Array<{ date: string; actual: number | null; predicted: number | null }>,
  args: {
    plant: ToolPlantRef;
    metric: string;
    unit: string;
    label: string;
    deviceId?: string | null;
    range: string;
  }
) {
  const stride = Math.max(1, Math.ceil(points.length / MAX_SERIES_POINTS));
  const rows = points.filter((_, i) => i % stride === 0);

  const actualVals = points
    .map((p) => p.actual)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const hasPredicted = points.some((p) => p.predicted != null);

  const stats = actualVals.length
    ? {
        mean: r3(actualVals.reduce((a, b) => a + b, 0) / actualVals.length),
        min: r3(Math.min(...actualVals)),
        max: r3(Math.max(...actualVals)),
        latest: r3(actualVals[actualVals.length - 1]),
      }
    : null;

  return {
    plant: { id: args.plant.id, slug: args.plant.slug, name: args.plant.name },
    metric: args.metric,
    label: args.label,
    unit: args.unit,
    device_id: args.deviceId ?? null,
    range: args.range,
    window: points.length
      ? { from: points[0].date, to: points[points.length - 1].date }
      : null,
    sample_size: points.length,
    stats,
    series: points.length >= 2
      ? {
          note: 'Downsampled render data for the UI chart. Do not enumerate; reason from stats.',
          dates: rows.map((p) => p.date),
          actual: rows.map((p) => r3(p.actual)),
          ...(hasPredicted ? { predicted: rows.map((p) => r3(p.predicted)) } : {}),
        }
      : null,
    // Ready-to-add report widget for addReportChart / the composer drawer.
    widget_config: {
      type: 'chart.timeseries',
      config: {
        ...(args.deviceId ? { deviceIds: [args.deviceId] } : {}),
        plantIds: [args.plant.slug],
        range: args.range,
        options: { metric: args.metric },
      },
    },
  };
}

/**
 * The exact proposeAlarm tool output (a DRAFT — nothing persists until the
 * user confirms the card, which PUTs the plant settings). Alarm capability
 * is strictly two plant-wide thresholds + the critical-email toggle; the
 * card copy states the honest constraints.
 */
export function buildAlarmDraft(input: {
  plant: ToolPlantRef;
  current: { soilingLossPct: number; performanceRatioPct: number; emailCritical: boolean };
  soilingLossPct?: number | null;
  performanceRatioPct?: number | null;
  emailCritical?: boolean | null;
}) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const proposed = {
    soilingLossPct:
      input.soilingLossPct != null ? clamp(input.soilingLossPct, 0, 50) : input.current.soilingLossPct,
    performanceRatioPct:
      input.performanceRatioPct != null
        ? clamp(input.performanceRatioPct, 0, 100)
        : input.current.performanceRatioPct,
    emailCritical: input.emailCritical ?? input.current.emailCritical,
  };
  return {
    kind: 'alarm_draft',
    draft: {
      plant_id: input.plant.id,
      plant_slug: input.plant.slug,
      plant_name: input.plant.name,
      current: input.current,
      proposed,
    },
    note: 'This is a DRAFT. The user must press "Apply" in the rendered card. Alarms are plant-wide thresholds evaluated hourly; only newly critical breaches email org managers. There are no per-inverter or custom-metric alarms.',
  };
}

/**
 * Shaped summary of a report (Dashboard row) for report-composition tool
 * outputs: enough for the model to reason about current state, deliberately
 * WITHOUT any data series (cheap tokens). Shared with scripted threads.
 */
export function shapeReportSummary(d: {
  id: string;
  slug: string;
  title: string;
  scope_plant_ids?: string[] | null;
  default_range?: string | null;
  widgets: any[];
}) {
  const widgets = Array.isArray(d.widgets) ? d.widgets : [];
  return {
    report_id: d.id,
    slug: d.slug,
    title: d.title,
    range: d.default_range ?? 'last_30d',
    plants: d.scope_plant_ids ?? [],
    widget_count: widgets.length,
    widgets: widgets.map((w: any) => ({
      id: w.id,
      type: w.type,
      title: w.config?.title ?? null,
      plant: w.config?.plantIds?.[0] ?? null,
      device: w.config?.deviceIds?.[0] ?? null,
      metric: w.config?.options?.metric ?? null,
      range: w.config?.range ?? null,
    })),
    note: 'The user can see and edit this report in the composer drawer. Refer to widgets by their title or metric, not by id.',
  };
}

const r1 = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(1)) : null;

/**
 * The exact getIrradianceQuality tool output for an IrradianceComparisonData
 * payload (the /quality/irradiance route shape). On-site sensor vs the
 * Open-Meteo reference model — there is no two-on-site-sensor comparison
 * data, so this is the honest "compare irradiance tracks" story. Shared by
 * the live tool and the scripted demo threads.
 */
export function shapeIrradianceQualityOutput(data: any, plant: ToolPlantRef) {
  const m = data?.overallMetrics ?? {};
  const sampleCount = Number(m.sampleCount ?? 0);
  const plantOut = { id: plant.id, slug: plant.slug, name: plant.name };

  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return {
      plant: plantOut,
      no_data: true,
      note: 'No on-site irradiance sensor data is available for this plant, so no sensor-vs-model comparison exists. Tell the user that plainly; never present zeros as measurements.',
    };
  }

  const monthly: any[] = Array.isArray(data?.monthlyMetrics)
    ? data.monthlyMetrics.slice(-12)
    : [];

  return {
    plant: plantOut,
    period: data?.metadata?.period ?? null,
    sensor: data?.metadata?.onSiteSensorType ?? null,
    reference: `Open-Meteo ${data?.metadata?.openMeteoSource ?? ''}`.trim(),
    overall: {
      correlation: r3(m.correlation),
      r_squared: r3(m.r_squared),
      bias_w_m2: r1(m.bias),
      bias_pct: r1(m.biasPct),
      rmse_w_m2: r1(m.rmse),
      mae_w_m2: r1(m.mae),
      sample_count: sampleCount,
    },
    alerts: (Array.isArray(data?.alerts) ? data.alerts : [])
      .slice(0, 5)
      .map((a: any) => ({
        type: String(a.type ?? 'unknown'),
        severity: String(a.severity ?? 'low'),
        message: String(a.message ?? ''),
        recommendation: a.recommendation ? String(a.recommendation) : null,
      })),
    monthly: {
      note: 'Render data for the UI chart. Do not enumerate; reason from overall and alerts.',
      months: monthly.map((x: any) => String(x.month ?? '')),
      bias_pct: monthly.map((x: any) => r1(x.metrics?.biasPct)),
      correlation: monthly.map((x: any) => r3(x.metrics?.correlation)),
    },
  };
}

/**
 * Detect a recurring-report request in a user message. Qwen refuses to pick
 * proposeReportSchedule on "email me a ... report" phrasings no matter how
 * the prompt frames it (it treats them as "send an email", which it thinks it
 * cannot do), so /api/chat forces the tool on the first step when this
 * matches. Requires BOTH a delivery verb + "report" AND a recurrence signal
 * so one-off asks ("show me the fault report") never trigger it.
 */
export function wantsReportSchedule(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  if (!/\breports?\b/.test(t)) return false;
  const delivery = /\b(email|e-mail|mail|send|receive|get)\b/.test(t);
  const recurrence =
    /\b(every|each|weekly|monthly|daily|recurring|regular(ly)?|schedule[ds]?)\b/.test(t);
  return delivery && recurrence;
}

export interface ReportScheduleDraftInput {
  name?: string | null;
  plant?: ToolPlantRef | null;
  schedule: 'weekly' | 'monthly';
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  period: 'last_7d' | 'last_30d' | 'last_month';
  recipients: string[];
  includeSummary?: boolean;
  includeRisk?: boolean;
  includeLosses?: boolean;
  /** Attached interactive report (Dashboard) to render as the PDF. */
  dashboard?: { id: string; title: string } | null;
}

const ISO_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * The exact proposeReportSchedule tool output (a DRAFT — nothing persists
 * until the user confirms the rendered card). Shared by the live tool and
 * the scripted demo threads.
 */
export function buildReportScheduleDraft(input: ReportScheduleDraftInput) {
  const schedule = input.schedule;
  const dayOfWeek =
    schedule === 'weekly' && input.dayOfWeek && input.dayOfWeek >= 1 && input.dayOfWeek <= 7
      ? input.dayOfWeek
      : schedule === 'weekly'
        ? 1
        : null;
  const dayOfMonth =
    schedule === 'monthly' && input.dayOfMonth && input.dayOfMonth >= 1 && input.dayOfMonth <= 28
      ? input.dayOfMonth
      : schedule === 'monthly'
        ? 1
        : null;

  const cadence =
    schedule === 'weekly'
      ? `every ${ISO_DAYS[(dayOfWeek ?? 1) - 1]}`
      : `on day ${dayOfMonth ?? 1} of each month`;

  return {
    kind: 'report_schedule_draft',
    draft: {
      name:
        input.name?.trim() ||
        input.dashboard?.title ||
        (input.plant ? `${input.plant.name} report` : 'Portfolio performance report'),
      dashboard_id: input.dashboard?.id ?? null,
      dashboard_title: input.dashboard?.title ?? null,
      schedule,
      send_day_of_week: dayOfWeek,
      send_day_of_month: dayOfMonth,
      period: input.period,
      recipient_emails: input.recipients,
      plant_slug: input.plant?.slug ?? null,
      plant_name: input.plant?.name ?? null,
      include_summary: input.includeSummary ?? true,
      include_risk: input.includeRisk ?? true,
      include_losses: input.includeLosses ?? true,
      cadence_label: `${cadence} at 07:00 UTC`,
    },
    note: 'This is a DRAFT. The user must press "Schedule" in the rendered card for it to be persisted. Emails go out at 07:00 UTC on the chosen day.',
  };
}

const BESS_SERVICE_BASES = [
  'dynamic_containment',
  'dynamic_moderation',
  'dynamic_regulation',
  'balancing_mechanism',
  'capacity_market',
  'wholesale_arbitrage',
] as const;

/**
 * The exact getBessRevenue tool output for a parsed ancillary_revenue_30d
 * fixture. Shared by the live tool and scripted demo threads.
 */
export function shapeBessRevenueOutput(
  parsed: { currency: string; days: Array<Record<string, number | string>> },
  plant: ToolPlantRef,
  days: number,
  by: 'service' | 'day'
) {
  const series = parsed.days.slice(-days);
  if (!series.length) return null;

  if (by === 'day') {
    return {
      plant: { id: plant.id, slug: plant.slug, name: plant.name },
      currency: parsed.currency,
      days,
      series: series.map((d) => ({
        date: d.date,
        total: d.total_gbp,
        dynamic_containment: d.dynamic_containment_gbp,
        dynamic_moderation: d.dynamic_moderation_gbp,
        dynamic_regulation: d.dynamic_regulation_gbp,
        balancing_mechanism: d.balancing_mechanism_gbp,
        capacity_market: d.capacity_market_gbp,
        wholesale_arbitrage: d.wholesale_arbitrage_gbp,
      })),
    };
  }

  const totals = Object.fromEntries(
    BESS_SERVICE_BASES.map((base) => [
      base,
      series.reduce((s, d) => s + (Number(d[`${base}_gbp`]) || 0), 0),
    ])
  ) as Record<(typeof BESS_SERVICE_BASES)[number], number>;
  const total = Object.values(totals).reduce((s, x) => s + x, 0);
  const topService = Object.entries(totals).sort(([, a], [, b]) => b - a)[0];
  return {
    plant: { id: plant.id, slug: plant.slug, name: plant.name },
    currency: parsed.currency,
    days,
    window: {
      from: series[0].date,
      to: series[series.length - 1].date,
    },
    total,
    daily_mean: Math.round(total / series.length),
    services: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [
        k,
        { total: v, share_pct: total > 0 ? Math.round((v / total) * 1000) / 10 : 0 },
      ])
    ),
    top_service: topService[0],
  };
}

// ── Contract intelligence shapers (arc 11) ─────────────────────────────────

interface ContractTermWire {
  field: string;
  label: string;
  valueNumeric: number | null;
  unit: string | null;
  valueText: string | null;
  confidence: number | null;
  status: string;
  monitored: boolean;
}

interface ContractWire {
  id: string;
  contractType: string;
  title: string;
  counterparty: string | null;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  hasSourceDocument: boolean;
  terms: ContractTermWire[];
}

interface ObligationWire {
  contract_id: string;
  field: string;
  status: string;
  observed_value: number | null;
  threshold: number | null;
  unit?: string | null;
  window?: string | null;
  detail?: string | null;
}

const termValue = (t: ContractTermWire) =>
  t.valueNumeric != null ? `${t.valueNumeric}${t.unit ? ` ${t.unit}` : ''}` : t.valueText ?? null;

/** Compact contract list: one line per contract + worst obligation status. */
export function shapeContractsOutput(payload: {
  plantId: string;
  contracts: ContractWire[];
  obligations: { obligations?: ObligationWire[] } | null;
}) {
  const rows = payload.obligations?.obligations ?? [];
  const worstFor = (id: string): string | null => {
    const mine = rows.filter((o) => o.contract_id === id);
    for (const s of ['breach', 'at_risk', 'ok', 'no_data', 'unmonitored']) {
      if (mine.some((o) => o.status === s)) return s;
    }
    return null;
  };
  return {
    plant: payload.plantId,
    count: payload.contracts.length,
    contracts: payload.contracts.map((c) => ({
      id: c.id,
      type: c.contractType,
      title: c.title,
      counterparty: c.counterparty,
      status: c.status,
      effective: `${c.effectiveFrom ?? '?'} to ${c.effectiveTo ?? '?'}`,
      term_count: c.terms.length,
      confirmed_terms: c.terms.filter((t) => t.status === 'CONFIRMED').length,
      obligation_status: c.status === 'DRAFT' ? 'awaiting_review' : worstFor(c.id) ?? 'unmonitored',
      has_source_document: c.hasSourceDocument,
    })),
    note:
      'obligation_status: breach > at_risk > ok; unmonitored = terms on file without a live data source. DRAFT contracts need human review in the Contracts tab before terms count.',
  };
}

/** Full terms + live obligation rows for one contract. */
export function shapeContractDetailOutput(
  contract: ContractWire,
  obligations: ObligationWire[],
) {
  return {
    id: contract.id,
    type: contract.contractType,
    title: contract.title,
    counterparty: contract.counterparty,
    status: contract.status,
    effective_from: contract.effectiveFrom,
    effective_to: contract.effectiveTo,
    terms: contract.terms.map((t) => ({
      term: t.label,
      value: termValue(t),
      status: t.status,
      monitored: t.monitored,
      ...(t.confidence != null ? { extraction_confidence: t.confidence } : { entered: 'manually' }),
    })),
    obligations: obligations.map((o) => ({
      term: o.field,
      status: o.status,
      observed: o.observed_value,
      threshold: o.threshold,
      unit: o.unit ?? null,
      window: o.window ?? null,
      detail: o.detail ?? null,
    })),
    note:
      'Only CONFIRMED terms bind; EXTRACTED terms are unreviewed drafts; never present them as agreed contract terms.',
  };
}

/** Warranty guardian summary from the live dossier artifact. */
export function shapeWarrantyPositionOutput(dossier: {
  asset?: { name?: string };
  health_score?: {
    score?: number;
    risk_level?: string;
    current_soh?: number;
    soh_margin?: number;
    cycles_used?: number;
    cycles_remaining?: number;
    years_remaining?: number;
    recommendation?: string;
  };
  warranty_terms?: { capacity_guarantee_pct?: number; warranty_years?: number; max_cycles?: number };
  violations?: unknown[];
  soh_trajectory?: {
    projected_threshold_crossing?: string | null;
    capacity_tests?: { date: string; soh: number; test_type: string }[];
  };
  provenance?: { provisional?: boolean; telemetry_source?: string };
  _generatedAt?: string;
}) {
  const hs = dossier.health_score ?? {};
  const terms = dossier.warranty_terms ?? {};
  const tests = dossier.soh_trajectory?.capacity_tests ?? [];
  const latestStandard = [...tests].reverse().find((t) => ['standard', 'partial'].includes(t.test_type));
  return {
    asset: dossier.asset?.name ?? null,
    health_score: hs.score ?? null,
    risk_level: hs.risk_level ?? null,
    current_soh_pct: hs.current_soh != null ? Math.round(hs.current_soh * 1000) / 10 : null,
    capacity_floor_pct:
      terms.capacity_guarantee_pct != null ? Math.round(terms.capacity_guarantee_pct * 100) : null,
    soh_margin_pp: hs.soh_margin != null ? Math.round(hs.soh_margin * 1000) / 10 : null,
    cycles_used: hs.cycles_used != null ? Math.round(hs.cycles_used) : null,
    cycle_budget: terms.max_cycles ?? null,
    warranty_years_remaining: hs.years_remaining ?? null,
    projected_floor_crossing: dossier.soh_trajectory?.projected_threshold_crossing ?? null,
    open_violations: (dossier.violations ?? []).length,
    latest_capacity_test: latestStandard
      ? { date: latestStandard.date.slice(0, 10), soh_pct: Math.round(latestStandard.soh * 1000) / 10 }
      : null,
    recommendation: hs.recommendation ?? null,
    provisional: dossier.provenance?.provisional ?? false,
    generated_at: dossier._generatedAt ?? null,
    note:
      'Modelled dispatch twin (no BMS telemetry): present the position as platform analytics on database records, never as measured hardware behaviour. Dossier PDF regenerates weekly on the plant Audit page.',
  };
}

/** Optimizer strategy benchmark summary from the live audit artifact. */
export function shapeOptimizerAuditOutput(audit: {
  summary?: {
    asset_name?: string;
    days_analyzed?: number;
    days_skipped?: number;
    realized_net_eur?: number;
    optimal_net_eur?: number;
    revenue_gap_eur?: number;
    capture_ratio?: number;
    annualized_gap_eur?: number;
    realized_efc_total?: number;
    optimal_efc_total?: number;
    price_source?: string;
    zone?: string;
  };
  provenance?: { provisional?: boolean; framing?: string };
  _generatedAt?: string;
}) {
  const s = audit.summary ?? {};
  return {
    asset: s.asset_name ?? null,
    days_analyzed: s.days_analyzed ?? null,
    capture_ratio: s.capture_ratio ?? null,
    realized_net_eur: s.realized_net_eur ?? null,
    optimal_net_eur: s.optimal_net_eur ?? null,
    revenue_gap_eur: s.revenue_gap_eur ?? null,
    annualized_gap_eur: s.annualized_gap_eur ?? null,
    realized_cycles: s.realized_efc_total ?? null,
    optimal_cycles: s.optimal_efc_total ?? null,
    price_source: s.price_source ?? null,
    zone: s.zone ?? null,
    provisional: audit.provenance?.provisional ?? false,
    generated_at: audit._generatedAt ?? null,
    note:
      'Strategy benchmark: the modelled dispatch vs per-day perfect foresight on the same real day-ahead prices. Perfect foresight is an upper bound no live trader reaches; commercial optimizers typically capture 70-90%. Never present this as measured plant behaviour.',
  };
}

// ── Cleaning optimizer run (maturity round) ─────────────────────────────────

/**
 * Compresses an OptimizationResponse (the Python optimizer's output) into the
 * chat tool's scenario-ladder summary. Shared with scripted demo threads.
 */
export function shapeOptimizerRunOutput(
  result: {
    optimal_schedule?: {
      dates?: string[];
      n_cleanings?: number;
      energy_recovered_MWh?: number;
      revenue_recovered_EUR?: number;
      cleaning_cost_EUR?: number;
      net_benefit_EUR?: number;
      roi_pct?: number;
      payback_days?: number;
    };
    comparison_table?: Array<{
      n_cleanings: number;
      best_dates: string[];
      net_benefit_EUR: number;
      roi_pct: number;
    }>;
    execution_time_ms?: number;
    rain_aware?: boolean;
    warnings?: string[];
  },
  plant: ToolPlantRef,
) {
  const opt = result.optimal_schedule ?? {};
  return {
    kind: 'optimizer_run',
    plant: { id: plant.id, slug: plant.slug, name: plant.name },
    rain_aware: result.rain_aware ?? false,
    recommended: {
      dates: opt.dates ?? [],
      n_cleanings: opt.n_cleanings ?? (opt.dates?.length ?? 0),
      energy_recovered_mwh: opt.energy_recovered_MWh ?? null,
      revenue_recovered_eur: opt.revenue_recovered_EUR ?? null,
      cleaning_cost_eur: opt.cleaning_cost_EUR ?? null,
      net_benefit_eur: opt.net_benefit_EUR ?? null,
      roi_pct: opt.roi_pct ?? null,
      payback_days: opt.payback_days ?? null,
    },
    scenarios: (result.comparison_table ?? []).map((row) => ({
      n_cleanings: row.n_cleanings,
      first_date: row.best_dates?.[0] ?? null,
      net_benefit_eur: row.net_benefit_EUR,
      roi_pct: row.roi_pct,
    })),
    execution_time_ms: result.execution_time_ms ?? null,
    warnings: result.warnings ?? [],
    note:
      'Quick-mode scenario search on the digital-twin soiling forecast. To adopt: draft it with proposeCleaningSchedule so the user can confirm; adoption can also create maintenance tickets.',
  };
}
