'use client';

import { createContext, useContext } from 'react';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * True inside a scripted example-session replay. Draft cards read this to
 * disable their live actions (Create/Adopt) — scripted threads must never
 * persist anything.
 */
const Ctx = createContext(false);

export const ScriptedThreadProvider = Ctx.Provider;

export function useIsScriptedThread(): boolean {
  return useContext(Ctx);
}

/**
 * True when links inside a scripted replay should render inert: on the
 * authenticated dashboard the demo-portfolio slugs (ribera, nimbus, ...)
 * do not exist for the viewer's org, so cite chips and table rows would
 * deep-link into 404s. Demo/showcase surfaces keep their links.
 */
export function useScriptedLinksInert(): boolean {
  const scripted = useIsScriptedThread();
  const prefix = usePlantRoutePrefix();
  return scripted && prefix === '/dashboard';
}
