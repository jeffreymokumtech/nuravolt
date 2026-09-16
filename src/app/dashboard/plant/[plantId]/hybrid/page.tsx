'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix. BESS analytics are Business+; the server routes
 * 402 and UpgradeGate shows the upgrade panel for lower plans.
 */
import DemoPage from '@/app/demo/plant/[plantId]/hybrid/page';
import UpgradeGate from '@/components/billing/UpgradeGate';

export default function DashboardhybridPage() {
  return (
    <UpgradeGate
      feature="analytics:bess"
      title="Battery analytics are a Business feature"
      blurb="The hybrid PV+BESS cockpit is part of the Business storage suite."
      fullPage
    >
      <DemoPage />
    </UpgradeGate>
  );
}
