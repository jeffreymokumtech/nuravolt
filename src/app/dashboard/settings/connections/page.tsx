'use client';

import ConnectionsManager from '@/components/data-hub/ConnectionsManager';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

/**
 * Org-level fleet connections manager (moved from /dashboard/data-hub, which
 * now redirects here). The per-plant view — lineage plus only that plant's
 * sources — lives at /dashboard/plant/[plantId]/datahub.
 */
export default function FleetConnectionsPage() {
  return (
    <OpsOrgShell activeNavKey="connections" section="CONNECTIONS">
      <div className="p-6">
        <ConnectionsManager />
      </div>
    </OpsOrgShell>
  );
}
