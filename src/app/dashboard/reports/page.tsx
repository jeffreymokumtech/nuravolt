'use client';

/**
 * Reports & dashboards for real orgs — the same org-scoped hub the demo
 * surface uses (the APIs already enforce ownership), inside the org shell.
 */
import ReportsHub from '@/app/demo/reports/page';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

export default function DashboardReportsPage() {
  return (
    <OpsOrgShell activeNavKey="reports" section="REPORTS">
      <ReportsHub />
    </OpsOrgShell>
  );
}
