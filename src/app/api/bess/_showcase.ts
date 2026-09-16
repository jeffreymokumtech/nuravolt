/**
 * Shared list of BESS showcase plants. Their fixtures live at
 * public/data/showcase/bess/{slug}/. Demo (Postgres-backed) plants are read
 * from public/data/bess/{plantId}/ instead.
 */
// zephyr is a WIND showcase plant with no BESS fixtures — excluded so its BESS
// endpoints don't 404 pretending storage data exists.
export const SHOWCASE_BESS_PLANTS = new Set(['helios', 'nimbus']);

export function bessFixtureSubdir(plantId: string): 'showcase/bess' | 'bess' {
  return SHOWCASE_BESS_PLANTS.has(plantId) ? 'showcase/bess' : 'bess';
}
