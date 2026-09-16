'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix. BESS analytics are Business+; the server routes
 * 402 and UpgradeGate shows the upgrade panel for lower plans.
 */
import DemoPage from '@/app/demo/plant/[plantId]/revenue/page';
import UpgradeGate from '@/components/billing/UpgradeGate';

export default function DashboardrevenuePage() {
  return (
    <UpgradeGate
      feature="analytics:bess"
      title="Battery analytics are a Business feature"
      blurb="Revenue stacking analytics are part of the Business storage suite."
      fullPage
    >
      <DemoPage />
    </UpgradeGate>
  );
}
