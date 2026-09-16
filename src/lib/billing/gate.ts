import { NextResponse } from 'next/server';
import { getOrgPlan, hasFeature, FEATURE_MATRIX, type Feature } from '@/lib/billing/plan';

/**
 * Server-side feature gate for API routes.
 *
 * Returns null when the caller's plan includes the feature (or the caller is
 * the dev demo identity), else a 402 with the same shape as the MCP key gate
 * ({ error: 'plan_upgrade_required', feature, detail, upgrade_url }).
 *
 * Usage:
 *   // requireOrg routes:
 *   const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
 *   if (gate) return gate;
 *
 *   // resolvePlantForRead routes — gate ONLY the 'org' branch so public
 *   // demo/showcase plants keep rendering:
 *   if (readAccess.access === 'org') {
 *     const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
 *     if (gate) return gate;
 *   }
 */
export async function requireFeature(
  authOrgId: string | null | undefined,
  feature: Feature,
): Promise<NextResponse | null> {
  // Dev demo fallback identity: all features on (matches getOrgBilling).
  if (!authOrgId || authOrgId.startsWith('demo_')) return null;

  const plan = await getOrgPlan(authOrgId);
  if (hasFeature(plan, feature)) return null;

  const plans = FEATURE_MATRIX[feature]
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' and ');
  return NextResponse.json(
    {
      error: 'plan_upgrade_required',
      feature,
      detail: `This feature is available on the ${plans} plan${FEATURE_MATRIX[feature].length > 1 ? 's' : ''}.`,
      upgrade_url: '/pricing',
    },
    { status: 402 },
  );
}
