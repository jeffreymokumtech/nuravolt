import { NextResponse } from 'next/server';
import { getChatIds } from '@/lib/ai/chat-auth';
import { getOrgPlan, hasFeature, PLAN_LIMITS, type Feature } from '@/lib/billing/plan';

export const dynamic = 'force-dynamic';

const FEATURES: Feature[] = [
  'analytics:per_inverter_soiling',
  'analytics:cleaning_optimizer',
  'analytics:fault_detection',
  'analytics:bess',
  'analytics:hydrogen',
  'ai:insights',
  'ai:copilot',
  'reports:builder',
  'tickets:export',
  'mcp:api_keys',
  'mcp:oauth',
];

/**
 * GET /api/billing/plan
 *
 * Lightweight plan lookup for client-side gating (UpgradeGate panels, the
 * API-keys page, export buttons). Mirrors plan.ts FEATURE_MATRIX.
 */
export async function GET() {
  const { orgId } = await getChatIds();
  const plan = await getOrgPlan(orgId);

  return NextResponse.json({
    plan,
    limits: {
      plants: Number.isFinite(PLAN_LIMITS[plan].plants) ? PLAN_LIMITS[plan].plants : null,
      seats: Number.isFinite(PLAN_LIMITS[plan].seats) ? PLAN_LIMITS[plan].seats : null,
    },
    features: Object.fromEntries(FEATURES.map((f) => [f, hasFeature(plan, f)])),
  });
}
