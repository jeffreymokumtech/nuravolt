import type { DemoThread } from './types';

/**
 * Lazy per-plant registry so thread fixtures (and the JSON they import) only
 * enter the bundle on the demo/showcase surfaces that open them.
 */
export const demoThreadRegistry: Record<string, () => Promise<DemoThread[]>> = {
  ribera: () => import('./ribera').then((m) => m.default),
  helios: () => import('./helios').then((m) => m.default),
  nimbus: () => import('./nimbus').then((m) => m.default),
  portfolio: () => import('./portfolio').then((m) => m.default),
};

export function threadsForPlant(slug: string | null | undefined): (() => Promise<DemoThread[]>) | null {
  if (!slug) return null;
  return demoThreadRegistry[slug] ?? null;
}

/**
 * Curated "greatest hits" list for the authenticated dashboard rail: the
 * highest-value sessions across the demo portfolio, replayed read-only and
 * honestly labeled as demo data. Order = display order.
 */
export function flagshipThreads(): Promise<DemoThread[]> {
  return Promise.all([
    import('./portfolio').then((m) => m.default),
    import('./ribera').then((m) => m.default),
    import('./nimbus').then((m) => m.default),
    import('./helios').then((m) => m.default),
  ]).then(([portfolio, ribera, nimbus, helios]) => {
    const pick = (threads: DemoThread[], id: string) =>
      threads.find((t) => t.id === id);
    return [
      pick(portfolio, 'portfolio-money-leaks'),
      pick(ribera, 'ribera-compose-report'),
      pick(portfolio, 'portfolio-morning-triage'),
      pick(ribera, 'ribera-cleaning-roi'),
      pick(ribera, 'ribera-fault-triage'),
      pick(nimbus, 'nimbus-revenue-stack') ?? nimbus[0],
      pick(ribera, 'ribera-weekly-report'),
      pick(ribera, 'ribera-manuals-sop'),
      pick(helios, 'helios-irradiance-quality'),
    ].filter(Boolean) as DemoThread[];
  });
}
