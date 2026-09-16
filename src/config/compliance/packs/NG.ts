import type { CompliancePack } from '../types';

/**
 * Nigeria.
 * Regulator: NERC (Nigerian Electricity Regulatory Commission).
 * Transmission: TCN (Transmission Company of Nigeria).
 * Bulk trader: NBET (Nigerian Bulk Electricity Trading).
 * Safety: NEMSA (Nigerian Electricity Management Services Agency).
 * Mini-grid framework: Mini-Grid Regulation 2016.
 */
export const NG: CompliancePack = {
  country: 'NG',
  version: '2026.Q2',
  display_name: 'Nigeria',
  default_timezone: 'Africa/Lagos',
  default_currency: 'NGN',
  language: 'en-NG',
  context:
    'Nigeria\'s NESI (Nigerian Electricity Supply Industry) is unbundled into NERC (regulator), TCN (transmission), eleven distribution companies, and NBET as the single-buyer bulk trader for IPPs. ' +
    'The Mini-Grid Regulation 2016 governs off-grid/rural systems below 1 MW — a distinct track from large-grid PPAs. ' +
    'All new plants require a NEMSA pre-energisation safety inspection before they are allowed to synchronise.',
  key_terms: ['NERC', 'NBET', 'NEMSA', 'LVRT', 'PCC'],
  regulator: { name: 'NERC', url: 'https://nerc.gov.ng' },
  grid_operator: { name: 'TCN', url: 'https://www.tcn.org.ng' },
  grid_code: {
    reference: 'NERC Grid Code / Distribution Code / Mini-Grid Regulation 2016',
    lvrt_curve: [
      { t_ms: 0, u_pu: 0.15 },
      { t_ms: 300, u_pu: 0.4 },
      { t_ms: 1500, u_pu: 0.8 },
      { t_ms: 3000, u_pu: 0.9 },
    ],
    reactive_power_range: [-0.95, 0.95],
    frequency_range_hz: [49.25, 50.75],
    anti_islanding_standard: 'IEC 62116',
    notes: 'NESI Metering Code (MAP) applies; NEMSA inspection mandatory before energisation.',
  },
  metering: {
    meter_class: '1.0',
    interval_minutes: 15,
    retention_years: 5,
    calibration_cadence_months: 36,
  },
  reporting_obligations: [
    {
      id: 'NG.NERC.monthly_generation',
      name: 'NERC monthly generation & availability report',
      description: 'Monthly generation, availability and outage report.',
      recipient: 'NERC',
      cadence: 'monthly',
      format: 'pdf',
      applies_when: { asset_type: ['SOLAR', 'WIND', 'BESS'] },
      section_id: 'ng_nerc_monthly',
      deadline_days_after_period: 15,
      source: { url: 'https://nerc.gov.ng' },
    },
    {
      id: 'NG.NBET.quarterly_ppa',
      name: 'NBET quarterly PPA report',
      recipient: 'NBET',
      cadence: 'quarterly',
      format: 'pdf',
      applies_when: { capacity_mw_min: 1 },
      section_id: 'ng_nbet_quarterly',
      deadline_days_after_period: 30,
      source: { url: 'https://nbet.com.ng' },
    },
    {
      id: 'NG.NEMSA.pre_energisation',
      name: 'NEMSA pre-energisation inspection record',
      recipient: 'NEMSA',
      cadence: 'event_based',
      format: 'pdf',
      section_id: 'ng_nemsa_inspection',
      deadline_days_after_period: 0,
      source: { url: 'https://www.nemsa.gov.ng' },
    },
  ],
  inspection_cadence: [
    { type: 'NEMSA periodic inspection', interval_months: 24, authority: 'NEMSA', capacity_mw_min: 0.1 },
  ],
  environmental_reporting: [
    { program: 'Environmental impact assessment (EIA) monitoring', cadence: 'annual', recipient: 'Federal Ministry of Environment', mandatory: true },
  ],
  report_sections: ['ng_nerc_monthly', 'ng_nbet_quarterly', 'ng_nemsa_inspection'],
  source_documents: [
    { title: 'NERC Grid Code', url: 'https://nerc.gov.ng', verified_at: '2026-04-14' },
    { title: 'Mini-Grid Regulation 2016', url: 'https://nerc.gov.ng', verified_at: '2026-04-14' },
  ],
};
