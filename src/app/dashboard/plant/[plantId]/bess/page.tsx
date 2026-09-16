'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix. BESS analytics are Business+; the server routes
 * 402 and UpgradeGate shows the upgrade panel for lower plans.
 */
import DemoPage from '@/app/demo/plant/[plantId]/bess/page';
import UpgradeGate from '@/components/billing/UpgradeGate';

export default function DashboardbessPage() {
  return (
    <UpgradeGate
      feature="analytics:bess"
      title="Battery analytics are a Business feature"
      blurb="Dispatch, warranty, cycling and revenue analytics for your storage assets."
      fullPage
    >
      <DemoPage />
    </UpgradeGate>
  );
}
