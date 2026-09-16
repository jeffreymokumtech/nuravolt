'use client';

import type { ReactNode } from 'react';
import OpsShell from './OpsShell';
import type { CommandBarMeta } from './OpsCommandBar';

/**
 * Shell for org-scope screens (fleet home, org settings, fleet connections).
 * Same command bar + rail chrome as every plant screen, so moving between a
 * plant and org settings never drops the navigation. The body is wrapped in
 * `.ops-legacy` so the existing light-styled page content (shadcn cards,
 * gray text) retones onto the ops canvas in both themes without a rewrite.
 */

interface OpsOrgShellProps {
  /** ORG_NAV key: fleet | org-settings | team | billing | api-keys | connections */
  activeNavKey: string;
  /** Breadcrumb section label, e.g. 'FLEET', 'SETTINGS', 'TEAM'. */
  section: string;
  sectionTone?: CommandBarMeta['sectionTone'];
  children: ReactNode;
}

export default function OpsOrgShell({
  activeNavKey,
  section,
  sectionTone = 'info',
  children,
}: OpsOrgShellProps) {
  return (
    <OpsShell activeNavKey={activeNavKey} commandBar={{ section, sectionTone }}>
      <div className="ops-legacy">{children}</div>
    </OpsShell>
  );
}
