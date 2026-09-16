'use client';

/**
 * Dashboard/report editor for real orgs — delegates to the shared editor
 * (prefix-aware links keep navigation on /dashboard).
 */
import DashboardEditorPage from '@/app/demo/reports/[id]/page';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

export default function DashboardReportEditorPage() {
  return (
    <OpsOrgShell activeNavKey="reports" section="REPORTS">
      <DashboardEditorPage />
    </OpsOrgShell>
  );
}
