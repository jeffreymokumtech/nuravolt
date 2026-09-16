'use client';

import { ReactNode } from 'react';
import { AnonymizationProvider } from '@/contexts/AnonymizationContext';
import { DemoPlantProvider } from '@/contexts/DemoPlantContext';
import { OpsThemeProvider } from '@/contexts/OpsThemeContext';
import { CopilotProvider } from '@/components/copilot/CopilotProvider';
import { CopilotRail } from '@/components/copilot/CopilotRail';
import { ReportComposerProvider } from '@/components/copilot/ReportComposerContext';
import { ReportComposerDrawer } from '@/components/reports/ReportComposerDrawer';

export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <OpsThemeProvider>
      <DemoPlantProvider>
        <AnonymizationProvider>
          <CopilotProvider>
            <ReportComposerProvider>
              {children}
              <CopilotRail />
              <ReportComposerDrawer />
            </ReportComposerProvider>
          </CopilotProvider>
        </AnonymizationProvider>
      </DemoPlantProvider>
    </OpsThemeProvider>
  );
}
