'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  RefreshCw,
  Pencil,
  Check,
  X,
  AlertCircle,
  BookOpen,
  ShieldCheck,
} from 'lucide-react';
import type { AINarration, TicketDetail } from '@/types/tickets';
import FaultEvidenceChart from './FaultEvidenceChart';

interface AIAnalysisCardProps {
  ticket: TicketDetail;
  /** Called after regenerate or approve completes so parent can re-fetch. */
  onNarrationChange: () => void;
}

type EditableField =
  | 'summary'
  | 'explanation'
  | 'likely_cause'
  | 'recommended_action'
  | 'urgency'
  | 'confidence';

const FIELD_LABELS: Record<EditableField, string> = {
  summary: 'Summary',
  explanation: 'Explanation',
  likely_cause: 'Likely cause',
  recommended_action: 'Recommended action',
  urgency: 'Urgency',
  confidence: 'Confidence',
};

const URGENCY_OPTIONS = ['IMMEDIATE', 'WITHIN_24H', 'WITHIN_7D', 'MONITOR'] as const;
const CONFIDENCE_OPTIONS = ['HIGH', 'MEDIUM', 'LOW'] as const;

const URGENCY_TONE: Record<AINarration['urgency'], string> = {
  IMMEDIATE: 'bg-signal-critical/10 text-signal-critical border-signal-critical/30',
  WITHIN_24H: 'bg-signal-warning/10 text-signal-warning border-signal-warning/30',
  WITHIN_7D: 'bg-blue-50 text-blue-700 border-blue-200',
  MONITOR: 'bg-paper-2 text-ink-3 border-divider',
};

const URGENCY_LABEL: Record<AINarration['urgency'], string> = {
  IMMEDIATE: 'Immediate',
  WITHIN_24H: 'Within 24 h',
  WITHIN_7D: 'Within 7 d',
  MONITOR: 'Monitor',
};

const CONFIDENCE_TONE: Record<AINarration['confidence'], string> = {
  HIGH: 'bg-signal-positive/10 text-signal-positive border-signal-positive/30',
  MEDIUM: 'bg-signal-warning/10 text-signal-warning border-signal-warning/30',
  LOW: 'bg-signal-critical/10 text-signal-critical border-signal-critical/30',
};

const VARIANT_LABEL: Record<string, string> = {
  v1: 'v1 baseline',
  v2_concise: 'v2 concise',
  v3_root_cause_first: 'v3 root-cause first',
};

const MAX_REGENERATIONS = 5;

export default function AIAnalysisCard({ ticket, onNarrationChange }: AIAnalysisCardProps) {
  const narration = (ticket.ai_edited_narration ?? ticket.ai_narration) ?? null;
  const isApproved = Boolean(ticket.ai_approved_at);
  const regenCount = ticket.ai_regeneration_count ?? 0;
  const regenLimitReached = regenCount >= MAX_REGENERATIONS;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<AINarration | null>(narration);
  const [busy, setBusy] = useState<'regenerate' | 'approve' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When ticket updates from parent (after regenerate/approve), reset local
  // draft so the UI shows the new narration verbatim.
  useEffect(() => {
    setDraft(narration);
    setIsEditing(false);
    setError(null);
  }, [
    ticket.id,
    ticket.ai_generated_at,
    ticket.ai_approved_at,
    ticket.ai_regeneration_count,
  ]);

  const hasNarration = narration !== null;
  const isGenerating = !hasNarration; // background fire-and-forget in progress

  const editedFields = useMemo(() => {
    if (!narration || !draft) return [] as EditableField[];
    return (Object.keys(FIELD_LABELS) as EditableField[]).filter(
      (f) => draft[f] !== narration[f]
    );
  }, [draft, narration]);

  const handleRegenerate = async () => {
    if (busy || regenLimitReached) return;
    setBusy('regenerate');
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/narration/regenerate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Regenerate failed (${res.status})`);
      }
      onNarrationChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Regenerate failed');
    } finally {
      setBusy(null);
    }
  };

  const handleApprove = async () => {
    if (busy || !draft) return;
    setBusy('approve');
    setError(null);
    try {
      const edited = editedFields.length > 0 ? draft : undefined;
      const res = await fetch(`/api/tickets/${ticket.id}/narration/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edited_narration: edited }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Approve failed (${res.status})`);
      }
      onNarrationChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  };

  // ---- Render --------------------------------------------------------------

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50/60 to-paper p-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-600" />
          <h4 className="text-sm font-semibold text-ink">AI Analysis</h4>
          {isApproved && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-signal-positive/10 text-signal-positive border border-signal-positive/30 text-[10px] font-medium">
              <ShieldCheck className="w-3 h-3" /> Approved
            </span>
          )}
        </div>

        {!isApproved && hasNarration && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleRegenerate}
              disabled={busy !== null || regenLimitReached}
              title={
                regenLimitReached
                  ? `Limit reached (${MAX_REGENERATIONS}/${MAX_REGENERATIONS})`
                  : 'Try a different prompt variant'
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw
                className={`w-3 h-3 ${busy === 'regenerate' ? 'animate-spin' : ''}`}
              />
              Regenerate
            </button>
            {!isEditing && (
              <button
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-violet-700 hover:bg-violet-100 transition-colors"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            {isEditing && (
              <button
                onClick={() => {
                  setDraft(narration);
                  setIsEditing(false);
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-3 hover:bg-paper-2 transition-colors"
              >
                <X className="w-3 h-3" /> Reset
              </button>
            )}
          </div>
        )}
      </div>

      {/* Cascade provenance, surface which layer fired this classification */}
      {(() => {
        const tm = ticket.trigger_metadata as
          | { classification_layer?: string; evidence?: string; winner_reason?: string; confidence?: number }
          | null;
        if (!tm?.classification_layer) return null;
        const layer = tm.classification_layer;
        const isAI = layer === 'AI_OVERRIDE';
        const tone = isAI
          ? { fg: '#7c3aed', bg: 'rgba(124,58,237,0.08)', border: 'rgba(124,58,237,0.30)' }
          : layer === 'ML_CLASSIFIER'
            ? { fg: '#B07D2B', bg: 'rgba(176,125,43,0.08)', border: 'rgba(176,125,43,0.30)' }
            : { fg: '#15706A', bg: 'rgba(21,112,106,0.08)', border: 'rgba(21,112,106,0.30)' };
        const short = layer === 'TWIN_RESIDUAL' ? 'TWIN' : layer === 'ML_CLASSIFIER' ? 'ML' : layer === 'AI_OVERRIDE' ? 'AI override' : 'RULE';
        const heading = isAI
          ? 'AI reclassified the cascade result'
          : `Cascade classification: ${short}${tm.confidence ? ` @ ${(tm.confidence * 100).toFixed(0)}% confidence` : ''}`;
        return (
          <div
            className="mb-3 rounded-md border px-3 py-2 text-[11.5px]"
            style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{heading}</span>
              <span
                className="rounded-sm border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider"
                style={{ color: tone.fg, borderColor: tone.border, background: 'transparent' }}
              >
                {short}
              </span>
            </div>
            {tm.evidence && (
              <div className="mt-1 text-[10.5px]" style={{ color: tone.fg, opacity: 0.85 }}>
                {tm.evidence}
              </div>
            )}
            {tm.winner_reason && tm.winner_reason !== tm.evidence && (
              <div className="mt-1 text-[10px] italic" style={{ color: tone.fg, opacity: 0.7 }}>
                {tm.winner_reason}
              </div>
            )}
            <div className="mt-1 text-[9.5px]" style={{ color: 'var(--ops-muted, #6b7280)' }}>
              {isAI
                ? 'AI reclassified after rule/twin/ML layers fell below 0.7 confidence.'
                : 'AI is narrating, not classifying, the upstream layer made the call.'}
            </div>
          </div>
        );
      })()}

      {/* Evidence chart, telemetry overlay showing the model's reasoning */}
      {ticket.trigger_type === 'PERFORMANCE_ANOMALY' && ticket.trigger_metadata && (
        <div className="mb-3">
          <FaultEvidenceChart
            triggerMetadata={ticket.trigger_metadata as Parameters<typeof FaultEvidenceChart>[0]['triggerMetadata']}
          />
        </div>
      )}

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-3 flex items-start gap-2 rounded-md border border-signal-critical/30 bg-signal-critical/10 p-2 text-xs text-signal-critical"
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body */}
      {isGenerating ? (
        <div className="space-y-2 py-1">
          <div className="h-3 w-3/4 rounded bg-violet-200/40 animate-pulse" />
          <div className="h-3 w-full rounded bg-violet-200/40 animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-violet-200/40 animate-pulse" />
          <p className="text-[10px] text-ink-3 italic mt-2">
            Generating analysis from anomaly context…
          </p>
        </div>
      ) : (
        draft && (
          <div className="space-y-3">
            <NarrationField
              field="summary"
              label={FIELD_LABELS.summary}
              value={draft.summary}
              aiValue={narration!.summary}
              editing={isEditing}
              onChange={(v) => setDraft({ ...draft, summary: v })}
            />
            <NarrationField
              field="explanation"
              label={FIELD_LABELS.explanation}
              value={draft.explanation}
              aiValue={narration!.explanation}
              editing={isEditing}
              multiline
              onChange={(v) => setDraft({ ...draft, explanation: v })}
            />
            <NarrationField
              field="likely_cause"
              label={FIELD_LABELS.likely_cause}
              value={draft.likely_cause}
              aiValue={narration!.likely_cause}
              editing={isEditing}
              onChange={(v) => setDraft({ ...draft, likely_cause: v })}
            />
            <NarrationField
              field="recommended_action"
              label={FIELD_LABELS.recommended_action}
              value={draft.recommended_action}
              aiValue={narration!.recommended_action}
              editing={isEditing}
              multiline
              onChange={(v) => setDraft({ ...draft, recommended_action: v })}
            />

            <div className="flex flex-wrap gap-2 pt-1">
              <ChipSelect
                label="Urgency"
                value={draft.urgency}
                options={URGENCY_OPTIONS}
                renderLabel={(v) => URGENCY_LABEL[v]}
                tone={URGENCY_TONE[draft.urgency]}
                aiValue={narration!.urgency}
                editing={isEditing}
                onChange={(v) =>
                  setDraft({ ...draft, urgency: v as AINarration['urgency'] })
                }
              />
              <ChipSelect
                label="Confidence"
                value={draft.confidence}
                options={CONFIDENCE_OPTIONS}
                renderLabel={(v) => v}
                tone={CONFIDENCE_TONE[draft.confidence]}
                aiValue={narration!.confidence}
                editing={isEditing}
                onChange={(v) =>
                  setDraft({ ...draft, confidence: v as AINarration['confidence'] })
                }
              />
            </div>

            {/* Equipment-documentation citations (doc agent) */}
            {narration?.sources && narration.sources.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <BookOpen className="h-3 w-3" aria-hidden />
                  Sources
                </p>
                <ul className="space-y-0.5">
                  {narration.sources.map((s, i) => (
                    <li key={i} className="text-xs text-slate-600 dark:text-slate-300">
                      {s.section}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      )}

      {/* Approve CTA */}
      {!isApproved && hasNarration && (
        <button
          onClick={handleApprove}
          disabled={busy !== null}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check className="w-4 h-4" />
          {busy === 'approve'
            ? 'Saving…'
            : ticket.status === 'NEW'
              ? editedFields.length > 0
                ? `Approve with ${editedFields.length} edit${editedFields.length === 1 ? '' : 's'} & validate`
                : 'Approve & validate'
              : editedFields.length > 0
                ? `Save ${editedFields.length} edit${editedFields.length === 1 ? '' : 's'}`
                : 'Approve as-is'}
        </button>
      )}

      {/* Footer meta */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-3">
        {ticket.ai_model_used === 'fallback' ? (
          <span className="text-signal-warning">rule-based fallback</span>
        ) : ticket.ai_model_used ? (
          <span>via AWS Bedrock</span>
        ) : null}
        {ticket.ai_prompt_variant && (
          <>
            <span>·</span>
            <span>{VARIANT_LABEL[ticket.ai_prompt_variant] ?? ticket.ai_prompt_variant}</span>
          </>
        )}
        {ticket.ai_generated_at && (
          <>
            <span>·</span>
            <span>{formatRelative(ticket.ai_generated_at)}</span>
          </>
        )}
        {ticket.ai_edited && (
          <>
            <span>·</span>
            <span className="text-signal-warning">edited</span>
          </>
        )}
        {regenCount > 0 && (
          <>
            <span>·</span>
            <span>
              regenerated {regenCount}/{MAX_REGENERATIONS}
            </span>
          </>
        )}
      </div>
    </motion.div>
  );
}

// ----- Field components -----------------------------------------------------

interface NarrationFieldProps {
  field: EditableField;
  label: string;
  value: string;
  aiValue: string;
  editing: boolean;
  multiline?: boolean;
  onChange: (v: string) => void;
}

function NarrationField({
  label,
  value,
  aiValue,
  editing,
  multiline,
  onChange,
}: NarrationFieldProps) {
  const edited = value !== aiValue;
  const labelEl = (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">
        {label}
      </span>
      {edited && (
        <span className="text-[9px] font-mono uppercase tracking-wider text-signal-warning">
          edited
        </span>
      )}
    </div>
  );

  if (editing) {
    return (
      <div className="space-y-1">
        {labelEl}
        {multiline ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            className="w-full text-sm bg-white border border-divider rounded-md p-2 text-ink-2 focus:outline-none focus:border-violet-400"
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full text-sm bg-white border border-divider rounded-md p-2 text-ink-2 focus:outline-none focus:border-violet-400"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {labelEl}
      <p className="text-sm leading-relaxed text-ink-2">{value}</p>
    </div>
  );
}

interface ChipSelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  renderLabel: (v: T) => string;
  tone: string;
  aiValue: T;
  editing: boolean;
  onChange: (v: T) => void;
}

function ChipSelect<T extends string>({
  label,
  value,
  options,
  renderLabel,
  tone,
  aiValue,
  editing,
  onChange,
}: ChipSelectProps<T>) {
  const edited = value !== aiValue;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">
        {label}:
      </span>
      {editing ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider focus:outline-none ${tone}`}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {renderLabel(opt)}
            </option>
          ))}
        </select>
      ) : (
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}
        >
          {renderLabel(value)}
        </span>
      )}
      {edited && (
        <span className="text-[9px] font-mono uppercase tracking-wider text-signal-warning">
          edited
        </span>
      )}
    </div>
  );
}

// ----- helpers --------------------------------------------------------------

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
