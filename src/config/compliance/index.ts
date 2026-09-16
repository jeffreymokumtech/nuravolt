import type { CompliancePack, ReportObligation, AssetType } from './types';
import { ES } from './packs/ES';
import { PT } from './packs/PT';
import { IT } from './packs/IT';
import { GB } from './packs/GB';
import { AE } from './packs/AE';
import { SA } from './packs/SA';
import { KE } from './packs/KE';
import { NG } from './packs/NG';
import { ZA } from './packs/ZA';

/**
 * Registry of supported compliance packs, keyed by ISO 3166-1 alpha-2.
 * Adding a new country = drop a file in packs/ and register it here.
 */
export const COMPLIANCE_PACKS: Record<string, CompliancePack> = {
  ES,
  PT,
  IT,
  GB,
  AE,
  SA,
  KE,
  NG,
  ZA,
};

export const SUPPORTED_COUNTRIES = Object.keys(COMPLIANCE_PACKS).sort();

/** Grouped for the onboarding country picker UI. */
export const COUNTRY_GROUPS: { label: string; countries: string[] }[] = [
  { label: 'Europe', countries: ['ES', 'PT', 'IT', 'GB'] },
  { label: 'Middle East', countries: ['AE', 'SA'] },
  { label: 'Sub-Saharan Africa', countries: ['KE', 'NG', 'ZA'] },
];

/**
 * Look up the active pack for a country code. Returns null if we don't have
 * a pack — caller is responsible for fallback (e.g. generic report template).
 */
export function getCompliancePack(country: string | null | undefined): CompliancePack | null {
  if (!country) return null;
  return COMPLIANCE_PACKS[country.toUpperCase()] ?? null;
}

/**
 * Shallow display summary for the wizard card — just the fields we show
 * before the user saves the plant.
 */
export function summarisePack(pack: CompliancePack) {
  return {
    country: pack.country,
    display_name: pack.display_name,
    version: pack.version,
    default_timezone: pack.default_timezone,
    default_currency: pack.default_currency,
    regulator: pack.regulator.name,
    grid_operator: pack.grid_operator.name,
    grid_code_reference: pack.grid_code.reference,
    reporting_obligations: pack.reporting_obligations.map((o) => ({
      id: o.id,
      name: o.name,
      recipient: o.recipient,
      cadence: o.cadence,
    })),
    meter_class: pack.metering.meter_class,
    retention_years: pack.metering.retention_years,
  };
}

/**
 * Filter a pack's obligations to those that actually apply to a specific
 * plant, given its capacity and asset type.
 */
export function applicableObligations(
  pack: CompliancePack,
  plant: { capacity_mw: number; asset_type: AssetType }
): ReportObligation[] {
  return pack.reporting_obligations.filter((o) => {
    const a = o.applies_when;
    if (!a) return true;
    if (a.capacity_mw_min !== undefined && plant.capacity_mw < a.capacity_mw_min) return false;
    if (a.capacity_mw_max !== undefined && plant.capacity_mw > a.capacity_mw_max) return false;
    if (a.asset_type && !a.asset_type.includes(plant.asset_type)) return false;
    return true;
  });
}

export type { CompliancePack, ReportObligation } from './types';
