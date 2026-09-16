/**
 * Country-specific compliance pack definitions.
 *
 * A CompliancePack captures the technical (grid code) and regulatory (reporting)
 * obligations that apply to a plant based on its country. Packs are versioned
 * per-country so we can re-bind plants when regulations change.
 *
 * Source documents must be cited on every obligation so operators can trace
 * back to the regulator's authoritative text.
 */

export type AssetType = 'SOLAR' | 'WIND' | 'BESS';

export type ReportCadence =
  | 'monthly'
  | 'quarterly'
  | 'semi_annual'
  | 'annual'
  | 'event_based';

export type ReportFormat = 'pdf' | 'xml' | 'csv' | 'portal_form';

export type MeterClass = '0.2S' | '0.5S' | '1.0';

export interface LVRTPoint {
  /** Time after fault in milliseconds. */
  t_ms: number;
  /** Voltage at PCC in per-unit of nominal. */
  u_pu: number;
}

export interface GridCode {
  /** Human-readable reference, e.g. 'P.O. 12.3 / RD 244/2019'. */
  reference: string;
  /** Low-voltage ride-through envelope (polyline). */
  lvrt_curve?: LVRTPoint[];
  /** Allowed range of power factor at PCC, e.g. [-0.95, 0.95]. */
  reactive_power_range?: [number, number];
  /** Frequency window the plant must stay connected in, Hz. */
  frequency_range_hz?: [number, number];
  /** Anti-islanding standard, e.g. 'IEC 61727'. */
  anti_islanding_standard?: string;
  /** Max active-power ramp rate, % nominal/minute. */
  active_power_ramp_pct_per_min?: number;
  /** Free-text notes about extra technical obligations. */
  notes?: string;
}

/**
 * Metering obligations.
 *
 * `meter_class`, `retention_years` and `calibration_cadence_months` are optional on purpose.
 * An unset field means "not yet verified against the source document" — it is deliberately
 * distinct from a value we believe to be correct. A pack author who cannot trace a figure to
 * the regulator's text must leave the field out with a TODO(verify) naming the document,
 * never fill it with a plausible-looking number. Renderers must treat unset as unknown and
 * say so, not print a placeholder as if it were fact.
 */
export interface MeteringPolicy {
  meter_class?: MeterClass;
  interval_minutes: number;
  retention_years?: number;
  calibration_cadence_months?: number;
}

export interface InspectionCadence {
  /** Short identifier, e.g. 'OCA', 'NEMSA', 'SPPC technical audit'. */
  type: string;
  interval_months: number;
  /** Who performs the inspection. */
  authority: string;
  /** Only required above this capacity (MW). */
  capacity_mw_min?: number;
}

export interface ReportApplicability {
  capacity_mw_min?: number;
  capacity_mw_max?: number;
  asset_type?: AssetType[];
}

export interface ReportObligation {
  /** Stable ID, e.g. 'ES.CNMC.monthly'. */
  id: string;
  /** Display title. */
  name: string;
  /** Short description of the submission. */
  description?: string;
  /** Regulator or grid operator receiving the report. */
  recipient: string;
  cadence: ReportCadence;
  format: ReportFormat;
  applies_when?: ReportApplicability;
  /** Renderer ID in src/lib/reports/sections/ — drives which renderer runs. */
  section_id: string;
  /**
   * Deadline as days after the end of the reporting period.
   *
   * Optional on purpose: unset means "not yet verified against the source document", which is
   * deliberately distinct from a day count we believe to be correct. Leave it out with a
   * TODO(verify) rather than guessing a submission window; renderers must say the deadline is
   * not verified instead of showing a number.
   */
  deadline_days_after_period?: number;
  /** Source document link + clause reference for audit trail. */
  source?: { url: string; clause?: string };
}

export interface EnvironmentalReporting {
  /** Guarantees of Origin or similar. */
  program: string;
  cadence: ReportCadence;
  recipient: string;
  mandatory: boolean;
}

export interface SourceDocument {
  title: string;
  url: string;
  clause?: string;
  /** ISO date the pack author last confirmed this reference. */
  verified_at?: string;
}

export interface CompliancePack {
  /** ISO 3166-1 alpha-2, e.g. 'ES'. */
  country: string;
  /** Pack revision, e.g. '2026.Q2'. Bumped when regulation changes. */
  version: string;
  /** Full country name in English. */
  display_name: string;
  default_timezone: string;
  default_currency: string;
  /** BCP-47 language tag for report localisation, e.g. 'es-ES'. */
  language: string;
  /** 2–3 sentence narrative framing the regulatory landscape — shown at the top of the reference guide. */
  context?: string;
  /** Glossary keys relevant to this country; used to build a per-country terms box. */
  key_terms?: string[];
  regulator: { name: string; url: string };
  grid_operator: { name: string; url: string };
  grid_code: GridCode;
  metering: MeteringPolicy;
  reporting_obligations: ReportObligation[];
  inspection_cadence?: InspectionCadence[];
  environmental_reporting?: EnvironmentalReporting[];
  /** Ordered list of section IDs to include in a compliance report. */
  report_sections: string[];
  /** Key into src/config/electricity.ts if a tariff exists for this country. */
  tariff_ref?: string;
  source_documents: SourceDocument[];
}
