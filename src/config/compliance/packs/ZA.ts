import type { CompliancePack } from '../types';

/**
 * South Africa.
 * Regulator: NERSA (National Energy Regulator of South Africa).
 * Utility: Eskom (transmission + large distribution) + municipalities.
 * Small-scale embedded generation: NRS 097-2-1 (MV) and NRS 097-2-3 (LV).
 * Renewable Power Plants: Grid Connection Code for RPPs, categorised A1/A2/A3/B/C by capacity.
 * IPP procurement: REIPPPP / RMIPPPP (Risk Mitigation IPPPP).
 */
export const ZA: CompliancePack = {
  country: 'ZA',
  version: '2026.Q2',
  display_name: 'South Africa',
  default_timezone: 'Africa/Johannesburg',
  default_currency: 'ZAR',
  language: 'en-ZA',
  context:
    'South Africa splits distributed generation into two regimes: small-scale embedded generation (SSEG) up to 100 kVA, governed by NRS 097-2-1 / -3 and connected via Eskom or the local municipality, and Renewable Power Plants (RPP), categorised A1 through C by capacity with escalating SCADA, protection and reporting requirements from Category B upward. ' +
    'NERSA licenses generators above 100 MW; utility-scale IPPs participate in REIPPPP / RMIPPPP and submit monthly dispatch data to DMRE. ' +
    'A Certificate of Compliance (COC) is required at energisation and after any modification.',
  key_terms: ['NERSA', 'SSEG', 'NRS 097', 'RPP', 'REIPPPP', 'COC', 'LVRT', 'PCC'],
  regulator: { name: 'NERSA', url: 'https://www.nersa.org.za' },
  grid_operator: { name: 'Eskom', url: 'https://www.eskom.co.za' },
  grid_code: {
    reference: 'RPP Grid Code / NRS 097-2-1 / NRS 097-2-3',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.0 },
      { t_ms: 150, u_pu: 0.15 },
      { t_ms: 1000, u_pu: 0.85 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [47.0, 52.0],
    anti_islanding_standard: 'NRS 097-2-1 / IEC 62116',
    active_power_ramp_pct_per_min: 10,
    notes: 'Category B+ plants must provide a SCADA link to the system operator. COC required; revalidated after any modification.',
  },
  metering: {
    meter_class: '0.5S',
    interval_minutes: 15,
    retention_years: 5,
    calibration_cadence_months: 60,
  },
  reporting_obligations: [
    {
      id: 'ZA.NERSA.quarterly_compliance',
      name: 'NERSA quarterly compliance report',
      description: 'Quarterly compliance report for licensed generators.',
      recipient: 'NERSA',
      cadence: 'quarterly',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'za_nersa_quarterly',
      deadline_days_after_period: 30,
      source: { url: 'https://www.nersa.org.za' },
    },
    {
      id: 'ZA.DMRE.monthly_dispatch',
      name: 'DMRE monthly dispatch data (RMIPPPP / REIPPPP)',
      recipient: 'DMRE',
      cadence: 'monthly',
      format: 'csv',
      applies_when: { capacity_mw_min: 10 },
      section_id: 'za_dmre_monthly_dispatch',
      deadline_days_after_period: 10,
      source: { url: 'https://www.dmre.gov.za' },
    },
    {
      id: 'ZA.NRS.097_checklist',
      name: 'NRS 097 SSEG compliance checklist',
      description: 'Checklist confirming compliance with NRS 097-2-1 / -3 for small-scale embedded generation.',
      recipient: 'Eskom / municipality',
      cadence: 'annual',
      format: 'pdf',
      applies_when: { capacity_mw_max: 1 },
      section_id: 'za_nrs_097_checklist',
      deadline_days_after_period: 60,
      source: { url: 'https://www.eskom.co.za' },
    },
  ],
  inspection_cadence: [
    { type: 'COC (Certificate of Compliance)', interval_months: 0, authority: 'Accredited electrician (post-modification)' },
  ],
  environmental_reporting: [
    { program: 'REIPPPP carbon offset reporting', cadence: 'annual', recipient: 'DMRE', mandatory: false },
  ],
  report_sections: ['za_nersa_quarterly', 'za_dmre_monthly_dispatch', 'za_nrs_097_checklist'],
  source_documents: [
    { title: 'Grid Connection Code for Renewable Power Plants', url: 'https://www.nersa.org.za', verified_at: '2026-04-14' },
    { title: 'NRS 097-2-1 / NRS 097-2-3', url: 'https://www.sabs.co.za', verified_at: '2026-04-14' },
  ],
};
