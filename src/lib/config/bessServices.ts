/**
 * Canonical BESS revenue metadata: the single palette for every revenue
 * visualization (Revenue Cockpit, Shams inline charts) and the single place
 * that says which ledger lane a number belongs to.
 *
 * THE THREE LANES ARE NEVER SUMMED. A battery discharging at 14:00 could be
 * running wholesale arbitrage, delivering an accepted balancing-mechanism
 * offer, or answering a frequency event under a response contract, and the
 * power trace is identical in all three cases. Adding a measured imputation to
 * a declared contract fee to an optimizer benchmark would triple-count the
 * same megawatt hour, so the UI renders three columns of one ledger and one
 * derived KPI: the gap versus the benchmark.
 *
 *   measured   what the asset did, valued at a published price, plus settled
 *              balancing-mechanism revenue rebuilt from public data
 *   declared   what a contract says the asset is paid
 *   benchmark  what a perfect-foresight operator would have earned on the
 *              same days and the same prices
 *
 * Lane assignment follows how each service is paid, not how it looks on a
 * chart: the three dynamic response products and the capacity market are
 * availability payments set by a contract or an auction, so they are declared;
 * the balancing mechanism settles per accepted volume and wholesale arbitrage
 * is energy value, so both are measured.
 */

export type RevenueLane = 'measured' | 'declared' | 'benchmark';

export interface BessServiceMeta {
  base:
    | 'dynamic_containment'
    | 'dynamic_moderation'
    | 'dynamic_regulation'
    | 'balancing_mechanism'
    | 'capacity_market'
    | 'wholesale_arbitrage';
  label: string;
  color: string;
  short: string;
  lane: RevenueLane;
}

export const BESS_SERVICES: BessServiceMeta[] = [
  { base: 'dynamic_containment', label: 'Dynamic containment', color: '#0ea5e9', short: 'DC', lane: 'declared' },
  { base: 'dynamic_moderation', label: 'Dynamic moderation', color: '#22c55e', short: 'DM', lane: 'declared' },
  { base: 'dynamic_regulation', label: 'Dynamic regulation', color: '#a855f7', short: 'DR', lane: 'declared' },
  { base: 'balancing_mechanism', label: 'Balancing mechanism', color: '#f97316', short: 'BM', lane: 'measured' },
  { base: 'capacity_market', label: 'Capacity market', color: '#facc15', short: 'CM', lane: 'declared' },
  { base: 'wholesale_arbitrage', label: 'Wholesale arbitrage', color: '#64748b', short: 'WS', lane: 'measured' },
];

/** How each lane is drawn, so the legend and the marks cannot drift apart. */
export const LANE_STYLE: Record<
  RevenueLane,
  { label: string; opacity: number; pattern: 'solid' | 'hatch' | 'outline'; hint: string }
> = {
  measured: {
    label: 'Measured',
    opacity: 1,
    pattern: 'solid',
    hint: 'What the asset did, valued at a published price. Settled only where marked.',
  },
  declared: {
    label: 'Declared',
    opacity: 0.85,
    pattern: 'hatch',
    hint: 'What a contract says the asset is paid. Contracted, not measured.',
  },
  benchmark: {
    label: 'Benchmark',
    opacity: 0.7,
    pattern: 'outline',
    hint: 'What perfect foresight would have earned on the same days and prices.',
  },
};

export const LANE_ORDER: RevenueLane[] = ['measured', 'declared', 'benchmark'];

export function servicesInLane(lane: RevenueLane): BessServiceMeta[] {
  return BESS_SERVICES.filter((s) => s.lane === lane);
}

export function serviceMeta(base: string): BessServiceMeta | undefined {
  return BESS_SERVICES.find((s) => s.base === base);
}

/**
 * Currency suffixes the legacy fixture columns carry. The showcase JSON was
 * written when every BESS plant was assumed to be a sterling GB battery, so
 * its columns read `wholesale_arbitrage_gbp`. Euro-zone plants settle in EUR
 * and the ledger rows carry no suffix at all, so readers must go through
 * serviceValue rather than appending a hardcoded `_gbp`.
 */
const CURRENCY_SUFFIXES = ['', '_gbp', '_eur', '_usd'] as const;

/** Read one service's value off a daily row whatever suffix it was written with. */
export function serviceValue(row: Record<string, unknown> | null | undefined, base: string): number {
  if (!row) return 0;
  for (const suffix of CURRENCY_SUFFIXES) {
    const raw = row[`${base}${suffix}`];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return 0;
}

/** Read a daily row's own total, whatever suffix it was written with. */
export function rowTotal(row: Record<string, unknown> | null | undefined): number {
  if (!row) return 0;
  for (const suffix of CURRENCY_SUFFIXES) {
    const raw = row[`total${suffix}`];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return BESS_SERVICES.reduce((sum, s) => sum + serviceValue(row, s.base), 0);
}

export function currencySymbol(currency: string | null | undefined): string {
  if (currency === 'GBP') return '£';
  if (currency === 'EUR') return '€';
  if (currency === 'USD') return '$';
  return currency ? `${currency} ` : '';
}

/** Compact money label in the ledger's own currency. */
export function formatMoney(value: number, currency: string | null | undefined): string {
  const sym = currencySymbol(currency ?? 'GBP');
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sym}${(value / 1_000).toFixed(1)}k`;
  return `${sym}${Math.round(value)}`;
}
