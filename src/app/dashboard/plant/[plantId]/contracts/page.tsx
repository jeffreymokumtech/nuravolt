'use client';

/**
 * Delegates to the /demo route body: the shared contracts section reads the
 * org-scoped live APIs, and the ops chrome resolves links against /dashboard
 * via usePlantRoutePrefix. Reads are plan-ungated; uploads require MANAGE
 * and the ai:copilot feature (enforced server-side).
 */
import DemoPage from '@/app/demo/plant/[plantId]/contracts/page';

export default function DashboardContractsPage() {
  return <DemoPage />;
}
