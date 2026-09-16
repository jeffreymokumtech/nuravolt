import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';

/**
 * GET /api/cron/narration-metrics
 *
 * Nightly aggregation of AI-narration A/B variant performance into the
 * NarrationVariantStats table. Reads three sources:
 *  - Ticket.ai_* fields (variant assignment, approval state, edits)
 *  - TicketNarrationFeedback rows (per-field edit deltas)
 *  - Ticket.closed_at + ai_narration.urgency (urgency-accuracy signal)
 *
 * Idempotent: upserts on the unique (org, variant, period_start, period_end)
 * key. Safe to re-run; later runs overwrite earlier numbers for the same period.
 *
 * Query params:
 *   ?period=daily (default) — yesterday 00:00 → today 00:00 (UTC)
 *   ?period=weekly         — last 7d
 *   ?start=2026-06-10&end=2026-06-17 — explicit override
 */
export async function GET(request: NextRequest) {
  // Auth check: verify CRON_SECRET in production (same convention as
  // api/cron/send-reports).
  if (process.env.NODE_ENV === 'production') {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);

  const { periodStart, periodEnd } = resolvePeriod(searchParams);

  try {
    // Pull every ticket whose narration was generated in the period — narration
    // happens at create-time, so this covers all the narrated tickets we want
    // to score even if approval/close happened later.
    const tickets = await prisma.ticket.findMany({
      where: {
        ai_generated_at: { gte: periodStart, lt: periodEnd },
        ai_prompt_variant: { not: null },
      },
      select: {
        id: true,
        org_clerk_id: true,
        ai_prompt_variant: true,
        ai_edited: true,
        ai_approved_at: true,
        ai_narration: true,
        created_at: true,
        closed_at: true,
        status: true,
      },
    });

    const feedback = await prisma.ticketNarrationFeedback.findMany({
      where: {
        created_at: { gte: periodStart, lt: periodEnd },
      },
      select: {
        org_clerk_id: true,
        prompt_variant: true,
        field_changed: true,
      },
    });

    // Bucket by (org, variant)
    type Bucket = {
      tickets_narrated: number;
      tickets_accepted_clean: number;
      tickets_edited: number;
      edits_summary: number;
      edits_explanation: number;
      edits_likely_cause: number;
      edits_recommended: number;
      edits_urgency: number;
      edits_confidence: number;
      urgency_correct_count: number;
      urgency_total_labeled: number;
      sum_resolution_h: number;
      count_resolution: number;
    };
    const buckets = new Map<string, Bucket>();
    const keyOf = (org: string, v: string) => `${org}::${v}`;
    const empty = (): Bucket => ({
      tickets_narrated: 0,
      tickets_accepted_clean: 0,
      tickets_edited: 0,
      edits_summary: 0,
      edits_explanation: 0,
      edits_likely_cause: 0,
      edits_recommended: 0,
      edits_urgency: 0,
      edits_confidence: 0,
      urgency_correct_count: 0,
      urgency_total_labeled: 0,
      sum_resolution_h: 0,
      count_resolution: 0,
    });

    for (const t of tickets) {
      const v = t.ai_prompt_variant!;
      const k = keyOf(t.org_clerk_id, v);
      const b = buckets.get(k) ?? empty();
      b.tickets_narrated += 1;
      if (t.ai_approved_at) {
        if (t.ai_edited) b.tickets_edited += 1;
        else b.tickets_accepted_clean += 1;
      }
      if (t.closed_at) {
        const hours =
          (t.closed_at.getTime() - t.created_at.getTime()) / 3_600_000;
        b.sum_resolution_h += hours;
        b.count_resolution += 1;
        const narration = t.ai_narration as { urgency?: string } | null;
        if (narration?.urgency) {
          b.urgency_total_labeled += 1;
          if (urgencyMatchesResolution(narration.urgency, hours)) {
            b.urgency_correct_count += 1;
          }
        }
      }
      buckets.set(k, b);
    }

    for (const fb of feedback) {
      const k = keyOf(fb.org_clerk_id, fb.prompt_variant);
      const b = buckets.get(k) ?? empty();
      switch (fb.field_changed) {
        case 'summary': b.edits_summary += 1; break;
        case 'explanation': b.edits_explanation += 1; break;
        case 'likely_cause': b.edits_likely_cause += 1; break;
        case 'recommended_action': b.edits_recommended += 1; break;
        case 'urgency': b.edits_urgency += 1; break;
        case 'confidence': b.edits_confidence += 1; break;
        default: break;
      }
      buckets.set(k, b);
    }

    // Upsert one row per (org, variant) bucket.
    const writes = Array.from(buckets.entries()).map(([key, b]) => {
      const [org_clerk_id, prompt_variant] = key.split('::');
      const avg =
        b.count_resolution > 0
          ? Number((b.sum_resolution_h / b.count_resolution).toFixed(2))
          : null;
      return prisma.narrationVariantStats.upsert({
        where: {
          org_clerk_id_prompt_variant_period_start_period_end: {
            org_clerk_id: org_clerk_id!,
            prompt_variant: prompt_variant!,
            period_start: periodStart,
            period_end: periodEnd,
          },
        },
        update: {
          tickets_narrated: b.tickets_narrated,
          tickets_accepted_clean: b.tickets_accepted_clean,
          tickets_edited: b.tickets_edited,
          edits_summary: b.edits_summary,
          edits_explanation: b.edits_explanation,
          edits_likely_cause: b.edits_likely_cause,
          edits_recommended: b.edits_recommended,
          edits_urgency: b.edits_urgency,
          edits_confidence: b.edits_confidence,
          urgency_correct_count: b.urgency_correct_count,
          urgency_total_labeled: b.urgency_total_labeled,
          avg_resolution_time_h: avg,
        },
        create: {
          org_clerk_id: org_clerk_id!,
          prompt_variant: prompt_variant!,
          period_start: periodStart,
          period_end: periodEnd,
          tickets_narrated: b.tickets_narrated,
          tickets_accepted_clean: b.tickets_accepted_clean,
          tickets_edited: b.tickets_edited,
          edits_summary: b.edits_summary,
          edits_explanation: b.edits_explanation,
          edits_likely_cause: b.edits_likely_cause,
          edits_recommended: b.edits_recommended,
          edits_urgency: b.edits_urgency,
          edits_confidence: b.edits_confidence,
          urgency_correct_count: b.urgency_correct_count,
          urgency_total_labeled: b.urgency_total_labeled,
          avg_resolution_time_h: avg,
        },
      });
    });

    await prisma.$transaction(writes);

    return NextResponse.json({
      ok: true,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      buckets_written: writes.length,
      tickets_scanned: tickets.length,
      feedback_rows_scanned: feedback.length,
    });
  } catch (error) {
    console.error('[cron/narration-metrics] failed:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

function resolvePeriod(params: URLSearchParams): {
  periodStart: Date;
  periodEnd: Date;
} {
  const start = params.get('start');
  const end = params.get('end');
  if (start && end) {
    return { periodStart: new Date(start), periodEnd: new Date(end) };
  }
  const mode = params.get('period') ?? 'daily';
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (mode === 'weekly') {
    const periodStart = new Date(today.getTime() - 7 * 24 * 3_600_000);
    return { periodStart, periodEnd: today };
  }
  // daily (default) — yesterday's window
  const periodStart = new Date(today.getTime() - 24 * 3_600_000);
  return { periodStart, periodEnd: today };
}

/**
 * Crude urgency-vs-reality scorecard. The intent is a rough signal for the
 * A/B comparison, not a precise SLA check.
 *
 *   IMMEDIATE   → matched if closed ≤ 24h
 *   WITHIN_24H  → matched if closed ≤ 48h (operator response often spans a shift)
 *   WITHIN_7D   → matched if closed ≤ 14d
 *   MONITOR     → matched if not closed urgently (> 7d, or closed as WONT_FIX)
 */
function urgencyMatchesResolution(urgency: string, hours: number): boolean {
  switch (urgency) {
    case 'IMMEDIATE': return hours <= 24;
    case 'WITHIN_24H': return hours <= 48;
    case 'WITHIN_7D': return hours <= 14 * 24;
    case 'MONITOR': return hours > 7 * 24;
    default: return false;
  }
}
