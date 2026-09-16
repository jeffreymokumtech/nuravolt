'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * localStorage draft persistence for the ConnectionWizard, so a hard refresh
 * mid-onboarding resumes where the user left off instead of losing everything.
 *
 * Secrets never touch localStorage: config objects are sanitized with the
 * same sensitive-key substring list the connections API uses. That's lossless
 * in practice — once a source has been tested, its credentials already live
 * server-side in DataConnection.config; an untested source just needs the
 * password re-typed on resume.
 */

// Mirrors sanitizeConfig() in src/app/api/connections/route.ts.
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'api_key', 'apikey', 'credentials'];

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 500;

export interface WizardDraft {
  version: 1;
  savedAt: string;
  currentStep: number;
  visited: number[];
  activeSourceIndex: number;
  // Full onboarding
  plantConfig: any;
  inverterGroups: any[];
  discoveredInverters: any[];
  weatherStation: any;
  skipEquipment: boolean;
  dataSources: any[];
  skipDataSources: boolean;
  sampleMode: boolean;
  deviceMatches: Record<string, any>;
  createStarterReport: boolean;
  // Connection-only
  connectionName: string;
  selectedType: string | null;
  config: any;
  connectionId: string | null;
}

export function sanitizeDraftConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config) return {};
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEYS.some((sk) => key.toLowerCase().includes(sk))) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function useWizardDraft(key: string, enabled: boolean) {
  const storageKey = `nuravolt.wizard-draft.${key}`;
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore once on mount.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as WizardDraft;
      if (parsed.version !== 1) return;
      if (Date.now() - new Date(parsed.savedAt).getTime() > MAX_AGE_MS) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setDraft(parsed);
    } catch {
      // Corrupt draft — discard.
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, enabled]);

  const save = useCallback(
    (data: Omit<WizardDraft, 'version' | 'savedAt'>) => {
      if (!enabled || typeof window === 'undefined') return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        try {
          const payload: WizardDraft = {
            ...data,
            version: 1,
            savedAt: new Date().toISOString(),
            config: sanitizeDraftConfig(data.config),
            dataSources: (data.dataSources ?? []).map((ds: any) => ({
              ...ds,
              config: sanitizeDraftConfig(ds.config),
            })),
          };
          window.localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch {
          /* quota/serialization failures must never break the wizard */
        }
      }, DEBOUNCE_MS);
    },
    [storageKey, enabled],
  );

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setDraft(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  return { draft, save, clear };
}
