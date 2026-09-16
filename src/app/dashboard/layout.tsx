'use client';

import { ReactNode } from 'react';
import { AnonymizationProvider } from '@/contexts/AnonymizationContext';
import { DemoPlantProvider } from '@/contexts/DemoPlantContext';
import { OpsThemeProvider } from '@/contexts/OpsThemeContext';
import { CopilotProvider } from '@/components/copilot/CopilotProvider';
import { GatedCopilotRail } from '@/components/copilot/GatedCopilotRail';
import { ReportComposerProvider } from '@/components/copilot/ReportComposerContext';
import { ReportComposerDrawer } from '@/components/reports/ReportComposerDrawer';
import ImpersonationBanner from '@/components/admin/ImpersonationBanner';

/**
 * Authenticated app shell. Same provider stack as the demo so the shared
 * plant chrome + section components work unchanged, but DemoPlantProvider is
 * mounted WITHOUT static props: it fetches the org-scoped /api/plants, so
 * every page under /dashboard sees the caller's real fleet.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <OpsThemeProvider>
      <DemoPlantProvider>
        <AnonymizationProvider>
          <CopilotProvider>
            <ReportComposerProvider>
              <ImpersonationBanner />
              {children}
              <GatedCopilotRail />
              <ReportComposerDrawer />
            </ReportComposerProvider>
          </CopilotProvider>
        </AnonymizationProvider>
      </DemoPlantProvider>
    </OpsThemeProvider>
  );
}
