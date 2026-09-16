'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface PageContext {
  plantId?: string;
  plantName?: string;
  inverterId?: string;
  twin?: 'power_ac' | 'temperature' | 'voltage_dc' | 'current_dc';
  range?: { from: string; to: string };
  /** Which console/section the user is looking at (e.g. 'wind:site-wake',
   *  'hydrogen:economics', 'settings:alerts') — lets the copilot answer
   *  "what am I looking at" without guessing from the plant alone. */
  section?: string;
  /** Asset chip of the current plant (PV / BESS / PV+BESS / WIND / H2). */
  assetType?: string;
}

export interface SeedPayload {
  text: string;
  context?: Partial<PageContext>;
  nonce: number;
}

interface CopilotContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;

  width: number;
  setWidth: (w: number) => void;

  pageContext: PageContext;
  setPageContext: (ctx: PageContext) => void;

  /**
   * User-defined scope override from the chat itself. When non-null and
   * `followPage` is false, this wins over `pageContext` for chat requests.
   */
  manualScope: PageContext | null;
  setManualScope: (ctx: PageContext | null) => void;
  followPage: boolean;
  setFollowPage: (v: boolean) => void;
  /** Resolved scope used for outgoing chat requests. */
  resolvedScope: PageContext;

  /** Toggle on the rail to filter the conversation list to current asset. */
  onlyThisAsset: boolean;
  setOnlyThisAsset: (v: boolean) => void;

  /** Pre-fill the chat input. Sending is left to the user (draft+confirm). */
  seedNextMessage: (text: string, context?: Partial<PageContext>) => void;
  seed: SeedPayload | null;
  consumeSeed: () => SeedPayload | null;
}

const CopilotCtx = createContext<CopilotContextValue | null>(null);

const LS_WIDTH = 'copilot_rail_width';
export const COPILOT_DEFAULT_WIDTH = 380;
export const COPILOT_MIN_WIDTH = 320;
export const COPILOT_MAX_WIDTH = 720;

export function CopilotProvider({ children }: { children: ReactNode }) {
  // Always start closed on every page load. Open state is intentionally NOT
  // persisted, users should land on a clean dashboard view and explicitly
  // invoke the Copilot when they want it. Width IS persisted (a preference,
  // not a session state).
  const [open, setOpenState] = useState(false);
  const [width, setWidthState] = useState(COPILOT_DEFAULT_WIDTH);
  const [pageContext, setPageContextState] = useState<PageContext>({});
  const [manualScope, setManualScopeState] = useState<PageContext | null>(null);
  const [followPage, setFollowPageState] = useState(true);
  const [onlyThisAsset, setOnlyThisAsset] = useState(false);
  const [seed, setSeed] = useState<SeedPayload | null>(null);
  const seedNonce = useRef(0);

  // Hydrate width preference on first client render.
  useEffect(() => {
    try {
      const w = localStorage.getItem(LS_WIDTH);
      if (w) {
        const n = parseInt(w, 10);
        if (!isNaN(n))
          setWidthState(Math.min(COPILOT_MAX_WIDTH, Math.max(COPILOT_MIN_WIDTH, n)));
      }
    } catch {
      // SSR or disabled storage, defaults are fine.
    }
  }, []);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  const setWidth = useCallback((w: number) => {
    const clamped = Math.min(COPILOT_MAX_WIDTH, Math.max(COPILOT_MIN_WIDTH, w));
    setWidthState(clamped);
    try {
      localStorage.setItem(LS_WIDTH, String(clamped));
    } catch {}
  }, []);

  const setPageContext = useCallback((ctx: PageContext) => {
    setPageContextState(ctx);
  }, []);

  const setManualScope = useCallback((ctx: PageContext | null) => {
    setManualScopeState(ctx);
    if (ctx) setFollowPageState(false);
  }, []);

  const setFollowPage = useCallback((v: boolean) => {
    setFollowPageState(v);
    if (v) setManualScopeState(null);
  }, []);

  const resolvedScope: PageContext = useMemo(
    () => (!followPage && manualScope ? manualScope : pageContext),
    [followPage, manualScope, pageContext]
  );

  const seedNextMessage = useCallback(
    (text: string, context?: Partial<PageContext>) => {
      seedNonce.current += 1;
      setSeed({ text, context, nonce: seedNonce.current });
      setOpen(true);
    },
    [setOpen]
  );

  const consumeSeed = useCallback((): SeedPayload | null => {
    const s = seed;
    setSeed(null);
    return s;
  }, [seed]);

  const value = useMemo<CopilotContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      width,
      setWidth,
      pageContext,
      setPageContext,
      manualScope,
      setManualScope,
      followPage,
      setFollowPage,
      resolvedScope,
      onlyThisAsset,
      setOnlyThisAsset,
      seedNextMessage,
      seed,
      consumeSeed,
    }),
    [
      open,
      setOpen,
      toggle,
      width,
      setWidth,
      pageContext,
      setPageContext,
      manualScope,
      setManualScope,
      followPage,
      setFollowPage,
      resolvedScope,
      onlyThisAsset,
      seedNextMessage,
      seed,
      consumeSeed,
    ]
  );

  return <CopilotCtx.Provider value={value}>{children}</CopilotCtx.Provider>;
}

export function useCopilot(): CopilotContextValue {
  const ctx = useContext(CopilotCtx);
  if (!ctx) {
    throw new Error('useCopilot must be used inside <CopilotProvider>');
  }
  return ctx;
}

/**
 * Optional version that returns null if no provider is mounted. Useful for
 * components that may render outside the dashboard layout.
 */
export function useCopilotOptional(): CopilotContextValue | null {
  return useContext(CopilotCtx);
}
