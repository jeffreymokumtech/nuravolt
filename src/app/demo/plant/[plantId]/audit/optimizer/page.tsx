'use client';

import AuditSectionShell from '@/components/audit/AuditSectionShell';
import OptimizerAuditSection from '@/components/audit/OptimizerAuditSection';

export default function OptimizerAuditPage() {
  return (
    <AuditSectionShell>
      <OptimizerAuditSection />
    </AuditSectionShell>
  );
}
