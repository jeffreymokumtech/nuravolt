'use client';

import { usePlanFeatures } from '@/lib/billing/use-plan';
import { CopilotRail } from '@/components/copilot/CopilotRail';

/**
 * Plan-gated wrapper around the Copilot rail. The AI copilot is Business+
 * only (ai:copilot in FEATURE_MATRIX), so the rail stays hidden while the
 * plan is loading and for orgs whose plan lacks the feature — the server-side
 * requireFeature() 402s remain the real enforcement. Demo/showcase layouts
 * mount <CopilotRail /> directly and are unaffected.
 */
export function GatedCopilotRail() {
  const { features, loading } = usePlanFeatures();

  if (loading || features['ai:copilot'] === false) return null;

  return <CopilotRail />;
}
