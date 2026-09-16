/**
 * Shared economics defaults for soiling revenue math.
 *
 * Single source for the electricity tariff used when a plant carries no
 * tariff of its own. Real sources win in this order:
 *   1. plant artifact metadata (`monthly_summary.json` metadata.eur_per_mwh,
 *      or analysis_results row metadata.eur_per_mwh)
 *   2. user input (the cleaning optimiser form)
 *   3. this default (Spanish PPA reference value)
 * Responses that fall back to the default should say so via `tariff_source`.
 */
export const DEFAULT_TARIFF_EUR_PER_MWH = 65;

export type TariffSource = 'plant_metadata' | 'user_input' | 'default';
