'use client';

/**
 * Returns the route prefix that shared plant-page components should use for
 * their internal links. Three surfaces share the same chrome + sections:
 *  - /dashboard — the authenticated app (real org plants, live data)
 *  - /demo      — the fixture-driven sales demo (blocked in prod by middleware)
 *  - /showcase  — the public static-JSON showcase
 *
 * Usage:
 *   const prefix = usePlantRoutePrefix();
 *   <Link href={`${prefix}/plant/${plantId}/inverter/${id}`} />
 */

import { usePathname } from 'next/navigation';

export type PlantRoutePrefix = '/dashboard' | '/demo' | '/showcase';

export function usePlantRoutePrefix(): PlantRoutePrefix {
  const pathname = usePathname();
  if (pathname?.startsWith('/dashboard')) return '/dashboard';
  // /chat (Shams) is an authenticated surface sharing the ops chrome — its
  // links must resolve to the real app, never the /demo fixtures.
  if (pathname?.startsWith('/chat')) return '/dashboard';
  if (pathname?.startsWith('/showcase')) return '/showcase';
  return '/demo';
}

/** Where the chrome's "home" (fleet/portfolio) link points per surface. */
export function homeHrefFor(prefix: PlantRoutePrefix): string {
  return prefix === '/dashboard' ? '/dashboard' : `${prefix}/portfolio`;
}
