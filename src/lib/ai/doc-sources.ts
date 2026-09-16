/**
 * Curated documentation sources for the doc-agent ingestion batch
 * (/api/cron/ingest-docs). First-priority source before web discovery:
 * known official documentation URLs per manufacturer.
 *
 * Add entries as the fleet grows — the nightly batch picks up anything a
 * fleet equipment model matches that isn't in the KB yet. `modelMatch` is a
 * case-insensitive substring test against the fleet's model string.
 */

export interface CuratedDoc {
  /** Substring that must appear in the fleet's model string (case-insensitive). */
  modelMatch: string;
  manufacturer: string;
  equipmentType: 'inverter' | 'battery' | 'wind_turbine' | 'electrolyzer' | 'panel';
  docType: 'manual' | 'datasheet' | 'fault-codes';
  title: string;
  url: string;
}

export const CURATED_DOCS: CuratedDoc[] = [
  {
    // Recorded source of the structured manual already in the repo
    // (public/data/manuals/SUN2000-60KTL-M0.json).
    modelMatch: 'SUN2000',
    manufacturer: 'Huawei',
    equipmentType: 'inverter',
    docType: 'manual',
    title: 'Huawei SUN2000-50/60/65KTL-M0 User Manual',
    url: 'https://solar.huawei.com/-/media/Solar/attachment/pdf/au/service/commercial/SUN200050KTL%2060KTL%2065KTLM0%20User%20Manual%2025%2008%2021.pdf',
  },
];

/** Curated docs matching a fleet model string. */
export function curatedDocsFor(model: string, manufacturer?: string | null): CuratedDoc[] {
  const m = model.toLowerCase();
  return CURATED_DOCS.filter(
    (d) =>
      m.includes(d.modelMatch.toLowerCase()) &&
      (!manufacturer || d.manufacturer.toLowerCase() === manufacturer.toLowerCase())
  );
}
