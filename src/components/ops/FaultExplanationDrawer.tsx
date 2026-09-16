'use client';

/**
 * FaultExplanationDrawer
 * ----------------------
 * Click-through fault detail drawer for the Faults console. Slides in from the
 * right (via the existing Sheet primitive) and renders, in order:
 *
 *   1. Header, display name, severity LED, ETA chip, asset link
 *   2. LLM "Why this fault, in plain English", best-effort POST to
 *      /api/llm/interpret-alert. Cached in a useRef so closing/reopening for
 *      the same fault doesn't re-fire the call.
 *   3. Cascade chain stepper, RULE → TWIN → ML → AI_OVERRIDE with confidence
 *      bars and a "winner" highlight on the layer that produced the verdict.
 *   4. Threshold viz, current value vs. threshold bar with trend.
 *   5. Evidence narrative, mono text quoting the rule that fired.
 *   6. Actions, "Draft ticket" (calls onDraftTicket, or POSTs to the demo
 *      incidents endpoint) + Close.
 *
 * Colors come from --ops-* CSS variables so the drawer respects the active
 * ops theme (light/dark). The LLM section is fully optional: if Bedrock is
 * unavailable, we silently skip it, the rule-based content below is enough
 * for the user to act on the fault.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import StatusLed, { type StatusTone } from '@/components/ops/StatusLed';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type ClassificationLayer =
  | 'RULE'
  | 'TWIN_RESIDUAL'
  | 'ML_CLASSIFIER'
  | 'AI_OVERRIDE'
  | string;

export interface CascadeLayer {
  layer: string;
  confidence: number;
  evidence: string;
}

export interface FaultDetails {
  fault_type: string;
  display_name: string;
  classification_layer: ClassificationLayer;
  cascade_winning_confidence: number;
  evidence: string;
  layer_chain?: CascadeLayer[];
  current_value?: number;
  threshold?: number;
  unit?: string;
  trend?: number;
  asset_id?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical' | string;
  eta_days?: number;
}

export interface FaultExplanationDrawerProps {
  fault: FaultDetails | null;
  plantId: string;
  open: boolean;
  onClose: () => void;
  onDraftTicket?: (fault: FaultDetails) => void;
}

// LLM-derived explanation payload we render in the AI callout.
interface LlmExplanation {
  summary: string;
  likely_cause: string;
  recommended_action: string;
  urgency: string;
  confidence: string;
  used_fallback?: boolean;
}

// ----------------------------------------------------------------------------
// Constants / mappings
// ----------------------------------------------------------------------------

const SEVERITY_TONE: Record<string, StatusTone> = {
  low: 'info',
  medium: 'warn',
  high: 'alarm',
  critical: 'alarm',
};

const LAYER_LABEL: Record<string, string> = {
  RULE: 'RULE',
  TWIN_RESIDUAL: 'TWIN',
  ML_CLASSIFIER: 'ML',
  AI_OVERRIDE: 'AI',
};

const LAYER_TONE: Record<
  string,
  { fg: string; bg: string; border: string }
> = {
  RULE: {
    fg: 'var(--ops-info)',
    bg: 'var(--ops-info-bg)',
    border: 'var(--ops-info-border)',
  },
  TWIN_RESIDUAL: {
    fg: 'var(--ops-info)',
    bg: 'var(--ops-info-bg)',
    border: 'var(--ops-info-border)',
  },
  ML_CLASSIFIER: {
    fg: 'var(--ops-warn)',
    bg: 'var(--ops-warn-bg)',
    border: 'var(--ops-warn-border)',
  },
  AI_OVERRIDE: {
    fg: 'var(--ops-bess)',
    bg: 'var(--ops-bess-bg)',
    border: 'var(--ops-bess-border)',
  },
};

// Demo org id (matches /api/quality and /api/tickets demo plumbing).
const DEMO_ORG_ID = 'demo_org_alpha1';

function severityTone(severity?: string): StatusTone {
  if (!severity) return 'info';
  return SEVERITY_TONE[severity] ?? 'info';
}

function severityLabel(severity?: string): string {
  if (!severity) return 'Unknown';
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function layerColor(layer: string) {
  return LAYER_TONE[layer] ?? LAYER_TONE.RULE;
}

function layerLabel(layer: string) {
  return LAYER_LABEL[layer] ?? layer;
}

// Map fault severity to AnomalyContext.severity (the LLM type uses different
// labels than our fault details, info/warning/critical).
function toLlmSeverity(severity?: string): 'info' | 'warning' | 'critical' {
  if (severity === 'critical' || severity === 'high') return 'critical';
  if (severity === 'medium' || severity === 'warn' || severity === 'warning')
    return 'warning';
  return 'info';
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export default function FaultExplanationDrawer({
  fault,
  plantId,
  open,
  onClose,
  onDraftTicket,
}: FaultExplanationDrawerProps) {
  const prefix = usePlantRoutePrefix();
  const [llm, setLlm] = useState<LlmExplanation | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmFailed, setLlmFailed] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);

  // Cache keyed by `${plantId}::${fault_type}::${asset_id ?? ''}`, survives
  // close/reopen of the drawer for the same fault.
  const llmCache = useRef<Map<string, LlmExplanation>>(new Map());

  useEffect(() => {
    if (!open || !fault) return;

    const cacheKey = `${plantId}::${fault.fault_type}::${fault.asset_id ?? ''}`;
    const cached = llmCache.current.get(cacheKey);
    if (cached) {
      setLlm(cached);
      setLlmFailed(false);
      setLlmLoading(false);
      return;
    }

    let cancelled = false;
    setLlm(null);
    setLlmFailed(false);
    setLlmLoading(true);

    (async () => {
      try {
        // Build a minimal AnomalyContext from the fault payload. We don't have
        // SHAP attributions in the click path, so feature_contributions stays
        // empty, the LLM core handles that gracefully.
        const res = await fetch('/api/llm/interpret-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org_clerk_id: DEMO_ORG_ID,
            plant_id: plantId,
            inverter_id: fault.asset_id,
            alert_type: 'fault',
            alert_id: `${fault.fault_type}-${fault.asset_id ?? 'plant'}`,
            context: {
              anomaly_score: clamp01(fault.cascade_winning_confidence ?? 0),
              is_anomaly: true,
              severity: toLlmSeverity(fault.severity),
              confidence: clamp01(fault.cascade_winning_confidence ?? 0),
              component_id: fault.asset_id ?? 'plant',
              component_type: 'inverter',
              fault_type: fault.fault_type,
              display_name: fault.display_name,
              feature_contributions: {},
              expected_value: fault.threshold,
              actual_value: fault.current_value,
              trend_direction:
                typeof fault.trend === 'number'
                  ? fault.trend > 0
                    ? 'worsening'
                    : fault.trend < 0
                      ? 'improving'
                      : 'stable'
                  : undefined,
              existing_interpretation: fault.evidence,
            },
          }),
        });

        if (cancelled) return;
        if (!res.ok) {
          setLlmFailed(true);
          setLlmLoading(false);
          return;
        }

        const data = await res.json();
        const explanation: LlmExplanation = {
          summary: data?.interpretation?.summary ?? '',
          likely_cause: data?.interpretation?.likely_cause ?? '',
          recommended_action: data?.interpretation?.recommended_action ?? '',
          urgency: data?.interpretation?.urgency ?? 'MONITOR',
          confidence: data?.interpretation?.confidence ?? 'LOW',
          used_fallback: data?.interpretation?.used_fallback ?? false,
        };

        if (!explanation.summary && !explanation.likely_cause) {
          // Nothing actionable, treat as failure.
          setLlmFailed(true);
          setLlmLoading(false);
          return;
        }

        llmCache.current.set(cacheKey, explanation);
        setLlm(explanation);
        setLlmLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.warn('[FaultExplanationDrawer] LLM call failed:', err);
          setLlmFailed(true);
          setLlmLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, fault, plantId]);

  // -- Render guards --------------------------------------------------------
  if (!fault) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0"
          style={{
            background: 'var(--ops-panel)',
            color: 'var(--ops-txt)',
            borderColor: 'var(--ops-hair)',
          }}
        />
      </Sheet>
    );
  }

  // Threshold viz math --------------------------------------------------------
  const showThreshold =
    typeof fault.current_value === 'number' &&
    typeof fault.threshold === 'number' &&
    fault.threshold > 0;
  const barMax = showThreshold
    ? Math.max(
        fault.current_value as number,
        (fault.threshold as number) * 1.5,
      )
    : 0;
  const filledPct = showThreshold && barMax > 0
    ? Math.min(100, ((fault.current_value as number) / barMax) * 100)
    : 0;
  const thresholdPct = showThreshold && barMax > 0
    ? Math.min(100, ((fault.threshold as number) / barMax) * 100)
    : 0;
  const sev = severityTone(fault.severity);
  const barFill =
    sev === 'alarm'
      ? 'var(--ops-alarm)'
      : sev === 'warn'
        ? 'var(--ops-warn)'
        : 'var(--ops-info)';

  // Cascade chain ------------------------------------------------------------
  const chain: CascadeLayer[] = Array.isArray(fault.layer_chain)
    ? fault.layer_chain
    : [];

  // Draft ticket -------------------------------------------------------------
  const handleDraftTicket = async () => {
    if (onDraftTicket) {
      onDraftTicket(fault);
      return;
    }

    const summaryBase =
      fault.display_name ||
      fault.fault_type.replace(/_/g, ' ').toLowerCase();
    const assetTag = fault.asset_id ? ` on ${fault.asset_id}` : '';
    const summary = `${summaryBase}${assetTag}, ${fault.evidence}`;
    const sevForIncident: 'low' | 'medium' | 'high' =
      fault.severity === 'critical' || fault.severity === 'high'
        ? 'high'
        : fault.severity === 'low'
          ? 'low'
          : 'medium';

    setDraftLoading(true);
    try {
      const res = await fetch(`/api/quality/plants/${plantId}/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary,
          severity: sevForIncident,
          opened_by: 'ops-console',
          create_linked_ticket: true,
        }),
      });
      if (!res.ok) {
        console.warn(
          '[FaultExplanationDrawer] Incident POST failed:',
          res.status,
        );
      }
    } catch (err) {
      console.warn('[FaultExplanationDrawer] Incident POST error:', err);
    } finally {
      setDraftLoading(false);
      onClose();
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 overflow-y-auto"
        style={{
          background: 'var(--ops-panel)',
          color: 'var(--ops-txt)',
          borderColor: 'var(--ops-hair)',
        }}
      >
        {/* ---------- Header ---------- */}
        <SheetHeader
          className="px-5 pt-5 pb-3 border-b"
          style={{ borderColor: 'var(--ops-hair)' }}
        >
          <div className="flex items-start gap-3">
            <StatusLed
              tone={sev}
              size={10}
              pulse={fault.severity === 'critical'}
              className="mt-1.5"
            />
            <div className="min-w-0 flex-1">
              <SheetTitle
                className="text-[18px] font-semibold leading-tight"
                style={{
                  color: 'var(--ops-bright)',
                  fontFamily: 'var(--ops-font-sans)',
                }}
              >
                {fault.display_name}
              </SheetTitle>
              <SheetDescription
                className="mt-1 flex flex-wrap items-center gap-2 text-[11px]"
                style={{ color: 'var(--ops-muted)' }}
              >
                <span
                  className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono"
                  style={{
                    color: 'var(--ops-txt)',
                    background: 'var(--ops-panel-2)',
                    borderColor: 'var(--ops-hair)',
                  }}
                >
                  {severityLabel(fault.severity)}
                </span>
                {typeof fault.eta_days === 'number' && (
                  <span
                    className="inline-flex items-center rounded-sm border px-1.5 py-px font-mono"
                    style={{
                      color: 'var(--ops-warn)',
                      background: 'var(--ops-warn-bg)',
                      borderColor: 'var(--ops-warn-border)',
                    }}
                  >
                    ETA {fault.eta_days}d
                  </span>
                )}
                {fault.asset_id && (
                  <Link
                    href={`${prefix}/plant/${plantId}/inverter/${fault.asset_id}`}
                    className="inline-flex items-center rounded-sm border px-1.5 py-px font-mono hover:brightness-95"
                    style={{
                      color: 'var(--ops-info)',
                      background: 'var(--ops-info-bg)',
                      borderColor: 'var(--ops-info-border)',
                    }}
                  >
                    {fault.asset_id}
                  </Link>
                )}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="px-5 py-4 space-y-5">
          {/* ---------- LLM callout ---------- */}
          {llmLoading && (
            <section
              className="rounded-md border p-3"
              style={{
                borderColor: 'var(--ops-bess-border)',
                background: 'var(--ops-bess-bg)',
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{
                    background: 'var(--ops-bess)',
                    animation: 'ops-pulse 2s ease-in-out infinite',
                  }}
                />
                <span
                  className="font-mono text-[11px]"
                  style={{ color: 'var(--ops-bess)' }}
                >
                  Generating explanation...
                </span>
              </div>
            </section>
          )}

          {!llmLoading && llm && !llmFailed && (
            <section
              className="rounded-md border p-3.5"
              style={{
                borderColor: 'var(--ops-bess-border)',
                background: 'var(--ops-bess-bg)',
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="font-mono text-[10.5px]"
                  style={{ color: 'var(--ops-muted)' }}
                >
                  Why this fault, in plain English
                </span>
                <span
                  className="inline-flex items-center rounded-sm border px-1.5 py-px font-mono text-[9.5px]"
                  style={{
                    color: 'var(--ops-bess)',
                    background: 'var(--ops-panel)',
                    borderColor: 'var(--ops-bess-border)',
                  }}
                  title={
                    llm.used_fallback
                      ? 'Rule-based fallback (LLM unavailable)'
                      : 'Generated by Bedrock'
                  }
                >
                  AI
                </span>
              </div>
              {llm.summary && (
                <p
                  className="text-[13.5px] leading-snug"
                  style={{
                    color: 'var(--ops-bright)',
                    fontFamily: 'var(--ops-font-serif)',
                  }}
                >
                  {llm.summary}
                </p>
              )}
              {(llm.likely_cause || llm.recommended_action) && (
                <dl
                  className="mt-3 grid gap-2 text-[12px]"
                  style={{ color: 'var(--ops-txt)' }}
                >
                  {llm.likely_cause && (
                    <div>
                      <dt
                        className="font-mono text-[10px]"
                        style={{ color: 'var(--ops-label)' }}
                      >
                        Likely cause
                      </dt>
                      <dd className="mt-0.5">{llm.likely_cause}</dd>
                    </div>
                  )}
                  {llm.recommended_action && (
                    <div>
                      <dt
                        className="font-mono text-[10px]"
                        style={{ color: 'var(--ops-label)' }}
                      >
                        Recommended action
                      </dt>
                      <dd className="mt-0.5">{llm.recommended_action}</dd>
                    </div>
                  )}
                </dl>
              )}
              <div
                className="mt-2 flex items-center gap-2 font-mono text-[9.5px]"
                style={{ color: 'var(--ops-muted)' }}
              >
                <span>Urgency: {llm.urgency}</span>
                <span>·</span>
                <span>Confidence: {llm.confidence}</span>
              </div>
            </section>
          )}

          {/* ---------- Cascade chain stepper ---------- */}
          {chain.length > 0 && (
            <section>
              <h3
                className="mb-2 font-mono text-[10.5px]"
                style={{ color: 'var(--ops-label)' }}
              >
                Cascade chain
              </h3>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {chain.map((step, i) => {
                  const isWinner =
                    fault.classification_layer === step.layer;
                  const c = layerColor(step.layer);
                  const conf = clamp01(step.confidence ?? 0);
                  return (
                    <div
                      key={`${step.layer}-${i}`}
                      className="flex-1 min-w-[140px] rounded-md border p-2.5"
                      style={{
                        borderColor: isWinner ? c.fg : 'var(--ops-hair)',
                        borderWidth: isWinner ? 1.5 : 1,
                        background: isWinner ? c.bg : 'var(--ops-panel-2)',
                      }}
                      title={step.evidence}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className="font-mono text-[10px]"
                          style={{ color: c.fg }}
                        >
                          {layerLabel(step.layer)}
                        </span>
                        {isWinner && (
                          <span
                            className="font-mono text-[8.5px] rounded-sm px-1 py-px"
                            style={{
                              color: 'var(--ops-panel)',
                              background: c.fg,
                            }}
                          >
                            winner
                          </span>
                        )}
                      </div>
                      <div className="mt-2">
                        <div
                          className="h-1 w-full overflow-hidden rounded-sm"
                          style={{ background: 'var(--ops-hair)' }}
                        >
                          <div
                            className="h-full"
                            style={{
                              width: `${conf * 100}%`,
                              background: c.fg,
                              transition: 'width 200ms ease',
                            }}
                          />
                        </div>
                        <div
                          className="mt-1 font-mono text-[9.5px]"
                          style={{ color: 'var(--ops-muted)' }}
                        >
                          {(conf * 100).toFixed(0)}% confidence
                        </div>
                      </div>
                      <p
                        className="mt-1.5 text-[10.5px] leading-snug truncate"
                        style={{ color: 'var(--ops-muted)' }}
                      >
                        {step.evidence}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ---------- Threshold viz ---------- */}
          {showThreshold && (
            <section>
              <h3
                className="mb-2 font-mono text-[10.5px]"
                style={{ color: 'var(--ops-label)' }}
              >
                Threshold
              </h3>
              <div
                className="relative h-3 w-full overflow-hidden rounded-sm"
                style={{ background: 'var(--ops-hair)' }}
              >
                <div
                  className="absolute left-0 top-0 h-full"
                  style={{
                    width: `${filledPct}%`,
                    background: barFill,
                    transition: 'width 250ms ease',
                  }}
                />
                <div
                  className="absolute top-0 h-full"
                  style={{
                    left: `${thresholdPct}%`,
                    width: 0,
                    borderLeft: '1.5px dashed var(--ops-alarm)',
                  }}
                  aria-hidden
                />
              </div>
              <div
                className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px]"
                style={{ color: 'var(--ops-muted)' }}
              >
                <span>
                  <span style={{ color: 'var(--ops-label)' }}>Current:</span>{' '}
                  <span style={{ color: 'var(--ops-txt)' }}>
                    {(fault.current_value as number).toFixed(2)}
                    {fault.unit ? ` ${fault.unit}` : ''}
                  </span>
                </span>
                <span>
                  <span style={{ color: 'var(--ops-label)' }}>Threshold:</span>{' '}
                  <span style={{ color: 'var(--ops-alarm)' }}>
                    {(fault.threshold as number).toFixed(2)}
                    {fault.unit ? ` ${fault.unit}` : ''}
                  </span>
                </span>
                {typeof fault.trend === 'number' && (
                  <span>
                    <span style={{ color: 'var(--ops-label)' }}>Trend:</span>{' '}
                    <span
                      style={{
                        color:
                          fault.trend > 0
                            ? 'var(--ops-alarm)'
                            : fault.trend < 0
                              ? 'var(--ops-ok)'
                              : 'var(--ops-muted)',
                      }}
                    >
                      {fault.trend > 0 ? '+' : ''}
                      {fault.trend.toFixed(2)}
                      {fault.unit ? ` ${fault.unit}` : ''}/day
                    </span>
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ---------- Evidence narrative ---------- */}
          <section>
            <h3
              className="mb-1.5 font-mono text-[10.5px]"
              style={{ color: 'var(--ops-label)' }}
            >
              Evidence
            </h3>
            <p
              className="rounded-md border p-2.5 font-mono text-[12px] leading-snug"
              style={{
                color: 'var(--ops-txt)',
                background: 'var(--ops-panel-2)',
                borderColor: 'var(--ops-hair)',
                fontFamily: 'var(--ops-font-mono)',
              }}
            >
              {fault.evidence}
            </p>
            <div
              className="mt-1 font-mono text-[9.5px]"
              style={{ color: 'var(--ops-muted)' }}
            >
              rule: {fault.fault_type}
              {' · '}
              winning {layerLabel(String(fault.classification_layer))} @{' '}
              {(clamp01(fault.cascade_winning_confidence) * 100).toFixed(0)}%
            </div>
          </section>
        </div>

        {/* ---------- Actions footer ---------- */}
        <div
          className="sticky bottom-0 flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{
            background: 'var(--ops-panel)',
            borderColor: 'var(--ops-hair)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border px-2.5 py-1 font-mono text-[11px] hover:brightness-95"
            style={{
              color: 'var(--ops-txt)',
              background: 'var(--ops-panel-2)',
              borderColor: 'var(--ops-hair)',
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleDraftTicket}
            disabled={draftLoading}
            className="rounded-sm border px-2.5 py-1 font-mono text-[11px] hover:brightness-95 disabled:opacity-60"
            style={{
              color: 'var(--ops-info)',
              background: 'var(--ops-ack-bg)',
              borderColor: 'var(--ops-ack-border)',
            }}
          >
            {draftLoading ? 'Drafting...' : 'Draft ticket'}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
