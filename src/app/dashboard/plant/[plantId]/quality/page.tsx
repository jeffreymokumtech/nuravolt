'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix.
 */
import DemoPage from '@/app/demo/plant/[plantId]/quality/page';

export default function DashboardqualityPage() {
  return <DemoPage />;
}
