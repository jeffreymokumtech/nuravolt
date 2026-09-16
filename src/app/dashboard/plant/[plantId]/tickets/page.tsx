'use client';

/**
 * Delegates to the /demo route body: the shared section components read the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix.
 */
import DemoPage from '@/app/demo/plant/[plantId]/tickets/page';

export default function DashboardticketsPage() {
  return <DemoPage />;
}
