'use client';

import AuditSectionShell from '@/components/audit/AuditSectionShell';
import ComplianceEvidenceSection from '@/components/audit/ComplianceEvidenceSection';

export default function ComplianceEvidencePage() {
  return (
    <AuditSectionShell>
      <ComplianceEvidenceSection />
    </AuditSectionShell>
  );
}
