'use client';

import { Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import OpsCommandBar from '@/components/ops/OpsCommandBar';
import { OpsThemeProvider } from '@/contexts/OpsThemeContext';
import { ReportComposerProvider } from '@/components/copilot/ReportComposerContext';
import { ReportComposerDrawer } from '@/components/reports/ReportComposerDrawer';

/**
 * Shams (the full-screen agent) lives inside the same ops chrome as the
 * dashboard: one product, two modes, switched via the command-bar control.
 * The existing light-styled chat components render under `.ops-legacy` so
 * the dark theme retones them without rewriting their internals.
 *
 * Plant context arrives as ?plant=<id> (set by the nav rail, the rail's
 * "open full view" link, and the switcher) and feeds the switcher's
 * back-to-dashboard target. useSearchParams requires a Suspense boundary.
 */

function ChatChrome({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const plantId = params?.get('plant') ?? null;

  return (
    <div className="ops-canvas flex h-screen w-full flex-col">
      <OpsCommandBar
        meta={{ section: 'Shams', sectionTone: 'info', mode: 'agent', plantId }}
      />
      <div className="ops-legacy flex min-h-0 flex-1">
        <ConversationSidebar />
        <div className="flex min-w-0 flex-1 flex-col bg-white text-gray-900">{children}</div>
      </div>
    </div>
  );
}

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <OpsThemeProvider>
      <ReportComposerProvider>
        <Suspense fallback={<div className="ops-canvas h-screen w-full" />}>
          <ChatChrome>{children}</ChatChrome>
        </Suspense>
        <ReportComposerDrawer />
      </ReportComposerProvider>
    </OpsThemeProvider>
  );
}
