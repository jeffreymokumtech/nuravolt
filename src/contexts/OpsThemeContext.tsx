'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme context for the ops console design system. A single class on <html>
 * (`ops-theme-dark`) drives every CSS variable in `ops-theme.scss`; the
 * default state is light (no class). Persistence lives in localStorage so
 * the operator's choice survives reloads.
 */

export type OpsTheme = 'light' | 'dark';

const STORAGE_KEY = 'nuravolt:ops-theme';
const DEFAULT_THEME: OpsTheme = 'light';

interface OpsThemeContextValue {
  theme: OpsTheme;
  setTheme: (t: OpsTheme) => void;
  toggle: () => void;
}

const Ctx = createContext<OpsThemeContextValue | null>(null);

function applyClass(theme: OpsTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('ops-theme-dark');
  else root.classList.remove('ops-theme-dark');
}

export function OpsThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<OpsTheme>(DEFAULT_THEME);

  // Hydrate from localStorage once on mount. We accept the brief flash of
  // the default before this fires; an inline pre-hydration script in the
  // root layout would avoid it but isn't worth the bytes for a demo.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') {
        setThemeState(stored);
        applyClass(stored);
      }
    } catch {
      // localStorage unavailable (private mode etc.) — stay on default.
    }
  }, []);

  const setTheme = useCallback((t: OpsTheme) => {
    setThemeState(t);
    applyClass(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo<OpsThemeContextValue>(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpsTheme(): OpsThemeContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useOpsTheme must be used inside an <OpsThemeProvider>');
  }
  return v;
}

/** Cheap hook for components that only need the current theme name. */
export function useOpsThemeName(): OpsTheme {
  return useOpsTheme().theme;
}

/**
 * Like useOpsThemeName, but safe outside a provider (falls back to light).
 * For leaf primitives (charts) that may render on surfaces without the
 * provider mounted.
 */
export function useOpsThemeNameSafe(): OpsTheme {
  return useContext(Ctx)?.theme ?? DEFAULT_THEME;
}
