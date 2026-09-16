import prisma from '@/libs/prisma';
import { Resend } from 'resend';

/**
 * Org-level LLM cost caps (OrgLLMBudget: defaults $5/day, $100/month).
 * Call checkLLMBudget() before paid inference; a blocked result should map
 * to HTTP 429 with the reason. Spend is aggregated from LLMInteraction rows,
 * which every Bedrock call site already records.
 */

export interface LLMBudgetResult {
  ok: boolean;
  reason?: 'daily_cap_exceeded' | 'monthly_cap_exceeded';
  capUsd?: number;
  spentUsd?: number;
}

const DEFAULT_DAILY_CAP = 5.0;
const DEFAULT_MONTHLY_CAP = 100.0;

export async function checkLLMBudget(orgId: string | null | undefined): Promise<LLMBudgetResult> {
  // Anonymous/demo callers are rate-limited elsewhere; budgets are per-org.
  if (!orgId || orgId.startsWith('demo_')) return { ok: true };

  const budget = await prisma.orgLLMBudget.findUnique({
    where: { org_clerk_id: orgId },
  });
  const dailyCap = budget ? Number(budget.daily_cap_usd) : DEFAULT_DAILY_CAP;
  const monthlyCap = budget ? Number(budget.monthly_cap_usd) : DEFAULT_MONTHLY_CAP;

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [daily, monthly] = await Promise.all([
    prisma.lLMInteraction.aggregate({
      where: { org_clerk_id: orgId, created_at: { gte: dayStart } },
      _sum: { cost_usd: true },
    }),
    prisma.lLMInteraction.aggregate({
      where: { org_clerk_id: orgId, created_at: { gte: monthStart } },
      _sum: { cost_usd: true },
    }),
  ]);

  const dailySpend = daily._sum.cost_usd ? Number(daily._sum.cost_usd) : 0;
  const monthlySpend = monthly._sum.cost_usd ? Number(monthly._sum.cost_usd) : 0;

  if (monthlySpend >= monthlyCap) {
    notifyCapHit(orgId, budget?.alert_email, 'monthly', monthlyCap, monthlySpend);
    return { ok: false, reason: 'monthly_cap_exceeded', capUsd: monthlyCap, spentUsd: monthlySpend };
  }
  if (dailySpend >= dailyCap) {
    notifyCapHit(orgId, budget?.alert_email, 'daily', dailyCap, dailySpend);
    return { ok: false, reason: 'daily_cap_exceeded', capUsd: dailyCap, spentUsd: dailySpend };
  }

  return { ok: true };
}

/** HTTP body for a blocked request (serve with status 429). */
export function llmBudgetError(result: LLMBudgetResult) {
  return {
    error: 'llm_budget_exceeded',
    reason: result.reason,
    detail:
      result.reason === 'monthly_cap_exceeded'
        ? `Your organization's monthly AI budget ($${result.capUsd}) is used up. It resets on the 1st, or raise the cap in settings.`
        : `Your organization's daily AI budget ($${result.capUsd}) is used up. It resets at midnight UTC, or raise the cap in settings.`,
  };
}

// Fire-and-forget cap notification. At most noisy per blocked call; callers
// hitting the cap repeatedly is itself a signal worth surfacing.
function notifyCapHit(
  orgId: string,
  alertEmail: string | null | undefined,
  window: 'daily' | 'monthly',
  capUsd: number,
  spentUsd: number,
) {
  if (!alertEmail || !process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  resend.emails
    .send({
      from: 'NuraVolt <noreply@nuravolt.com>',
      to: alertEmail,
      subject: `NuraVolt: ${window} AI budget reached`,
      html: `<p>Your organization's ${window} AI budget of $${capUsd} has been reached (spent: $${spentUsd.toFixed(2)}). AI features are paused until the window resets. You can raise the cap in billing settings.</p>`,
    })
    .catch(() => {});
}
