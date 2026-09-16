'use client';

import AuditSectionShell from '@/components/audit/AuditSectionShell';
import AuditOverviewSection from '@/components/audit/AuditOverviewSection';

/**
 * Audit product surface, overview. Parallel to the Monitor surface; the
 * Monitor | Audit switch lives in PlantPageChrome.
 */
export default function AuditOverviewPage() {
  return (
    <AuditSectionShell>
      <AuditOverviewSection />
    </AuditSectionShell>
  );
}
