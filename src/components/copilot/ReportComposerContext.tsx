'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Active-report state for the chat report composer. Self-contained provider
 * (NOT part of CopilotProvider) because the /chat surface has no
 * CopilotProvider but still hosts the composer drawer.
 *
 * - activeReportId rides the chat request body so report tools default to it.
 * - refreshNonce bumps whenever a chat tool mutates the report; the drawer
 *   refetches on change.
 */

interface ReportComposerState {
  activeReportId: string | null;
  setActiveReport: (id: string | null) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  refreshNonce: number;
  bumpRefresh: () => void;
}

const Ctx = createContext<ReportComposerState | null>(null);

export function ReportComposerProvider({ children }: { children: ReactNode }) {
  const [activeReportId, setActiveReport] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  const value = useMemo(
    () => ({
      activeReportId,
      setActiveReport,
      drawerOpen,
      setDrawerOpen,
      refreshNonce,
      bumpRefresh,
    }),
    [activeReportId, drawerOpen, refreshNonce, bumpRefresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReportComposer(): ReportComposerState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useReportComposer outside ReportComposerProvider');
  return v;
}

export function useReportComposerOptional(): ReportComposerState | null {
  return useContext(Ctx);
}
