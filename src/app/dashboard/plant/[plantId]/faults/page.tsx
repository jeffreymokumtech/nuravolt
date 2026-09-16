'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix. Fault detection is Business+; the server routes
 * 402 and UpgradeGate shows the upgrade panel for lower plans.
 */
import DemoPage from '@/app/demo/plant/[plantId]/faults/page';
import UpgradeGate from '@/components/billing/UpgradeGate';

export default function DashboardfaultsPage() {
  return (
    <UpgradeGate
      feature="analytics:fault_detection"
      title="Fault detection is a Business feature"
      blurb="Predictive fault queues, RUL estimates and sensor forensics for your fleet."
      fullPage
    >
      <DemoPage />
    </UpgradeGate>
  );
}
